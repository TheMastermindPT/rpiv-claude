// approve-outward-actions.mjs — PreToolUse hook that forces a permission prompt
// ("ask") before outward-facing actions: git push (and push plumbing), branch and
// worktree creation, any `gh` command that is not a known read, and GitHub MCP
// tools that are not reads. Runs for the main session and every subagent (D2).
//
// Output: one `permissionDecision: "ask"` object, reason prefixed
// `[rpiv-hook] outward action: ` or `[rpiv-hook] broken input: `; no output means
// no opinion. Anything that cannot be parsed, any internal error and any command
// over 64 KB asks as broken input with exit 0 (D13) — Claude Code runs the tool
// unprompted when a hook crashes or times out.
//
// Guarantee scope (D11): commands issued directly through Bash, PowerShell or a
// GitHub MCP tool, including literal wrapper strings (D12). Script files, interpreter
// code, raw HTTP, configured git aliases and edits to this hook are accepted
// residual risk.
//
// Vocabulary drift (D7, accepted): git command vocabulary is also hand-copied in
// DESTRUCTIVE_BASH and BASH_ALLOWLIST (.claude/hooks/enforce-readonly-agent.mjs),
// BASH_PERMISSIONS (opencode/adapter.mjs), and jev DEFAULT_FAST_PATH and
// DEFAULT_HARD_DENY (scripts/jev-gate.mjs). `git push` overlaps DESTRUCTIVE_BASH.
// Extract one owner (shared-vocab-union) when the OpenCode mirror (S16) becomes the
// second consumer of this outward list.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createdNameWord, writeBeforeNote } from "./_branch-creations.mjs";
import {
	approval,
	branchNames,
	headState,
	limitGitTime,
} from "./_git-branch.mjs";

// ---- command tokenizer -----------------------------------------------------------
//
// Splits a Bash or PowerShell command into segments of words. A segment ends at
// `;`, `|`, `&`, newlines and grouping (`( ) { }`). Quoted text joins one word;
// substitutions (`$(...)`, backticks) are parsed as their own segments. Comments
// and heredoc / here-string bodies are skipped.

class Unparseable extends Error {}

// Substitution nesting beyond this is treated as unparseable rather than recursed.
const MAX_NESTING = 64;

function tokenize(src, mode) {
	const p = {
		src,
		i: 0,
		mode,
		segments: [],
		heredocs: [],
		depth: 0,
		arithmeticFailed: new Set(),
	};
	parseList(p, null);
	return p.segments;
}

function parseList(p, terminator, options = {}) {
	if (++p.depth > MAX_NESTING)
		throw new Unparseable("substitutions nested too deeply");
	const seg = newSegmentBuilder(p, options);
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		// A `)` closing a `(` group opened in this list is grouping, not the end
		// of a `$(...)` substitution.
		if (ch === terminator && seg.openParens === 0) {
			p.i++;
			seg.endSegment();
			p.depth--;
			return;
		}
		step(p, seg, ch);
	}
	if (terminator !== null) throw new Unparseable("unterminated substitution");
	seg.endSegment();
}

function parenDelta(ch, open) {
	if (ch === "(") return 1;
	return ch === ")" && open > 0 ? -1 : 0;
}

// A word records its decoded `value` and, in `raw`, which characters were
// unquoted (quoted ones become "\0"), so redirection prefixes and expansions can
// be told apart from quoted text. `options.fed`: every segment of this list is
// stdin-fed (an output process substitution).
function newSegmentBuilder(p, options = {}) {
	let words = [];
	let word = null;
	let piped = false;
	let called = false;
	let stdinRedirect = false;
	// The next word is a redirection target: dropped from the segment's words.
	let targetPending = false;
	// Open groups `( … )` / `{ …; }`. A group fed by a pipe or a `<` redirection
	// feeds every segment inside it (`echo x | (bash)`, `{ bash; } < f`).
	const groups = [];
	let closedGroup = null;
	let openParens = 0;
	const empty = () => words.length === 0 && word === null;
	return {
		get inWord() {
			return word !== null;
		},
		get current() {
			return word?.value ?? "";
		},
		get currentRaw() {
			return word?.raw ?? "";
		},
		/** `&` (PowerShell call operator) with no command word yet. */
		get callPending() {
			return called && empty();
		},
		/** Quoted or escaped text. */
		append(text) {
			word ??= { value: "", raw: "", dynamic: false, firstLiteral: undefined };
			if (text !== "") word.firstLiteral ??= true;
			word.value += text;
			word.raw += "\0".repeat(text.length);
		},
		/** An unquoted character. */
		appendUnquoted(ch) {
			this.append("");
			word.firstLiteral ??= true;
			word.value += ch;
			word.raw += ch;
		},
		/** The current word's value is only known at run time (`$x`, `$(...)`). */
		markDynamic() {
			this.append("");
			word.dynamic = true;
			word.firstLiteral ??= false;
		},
		/** Records a variable the word expands (`$env:NAME` -> "env:NAME"). */
		noteVariable(name) {
			this.markDynamic();
			(word.vars ??= []).push(name);
		},
		dropWord() {
			word = null;
		},
		/** Bash `<(…)`/`>(…)`: a word standing for a file the substitution feeds. */
		markProcessSubstitution() {
			this.markDynamic();
			word.processSubstitution = true;
		},
		/** A redirection operator; its target word (if any) follows. */
		redirect({ feedsStdin, hasTarget = true }) {
			targetPending = hasTarget;
			if (!feedsStdin) return;
			if (empty() && closedGroup !== null) closedGroup.fed = true;
			else stdinRedirect = true;
		},
		endWord() {
			if (word !== null && !targetPending)
				words.push(...psParameterParts(p, word));
			if (word !== null) targetPending = false;
			word = null;
		},
		// `ending`: how the segment ends — "list" (`;`, `&&`, `||`, newline, end),
		// "pipe" (it feeds the next one) or "background" (Bash `&`); `depth` is 1
		// for top-level segments, more inside substitutions (D14 S2 rev. 1).
		endSegment({
			nextPiped = false,
			nextCalled = false,
			ending = "list",
		} = {}) {
			this.endWord();
			if (words.length > 0)
				p.segments.push({
					words,
					piped,
					called,
					stdinRedirect,
					inheritedFed: options.fed === true,
					group: groups.at(-1) ?? null,
					ending,
					depth: p.depth,
				});
			words = [];
			piped = nextPiped;
			called = nextCalled;
			stdinRedirect = false;
			targetPending = false;
			closedGroup = null;
		},
		/** `(` groups open in this list. */
		get openParens() {
			return openParens;
		},
		/** The segment already has a command word (PowerShell `(` is then an
		    argument expression, not a group). */
		get hasWords() {
			return !empty();
		},
		/** Records the segments parsed inside an argument expression `( … )`. */
		noteExpression(segments) {
			// The first expression is the call's argument list (`Create("…")`); a
			// later member call such as `.Invoke()` does not replace it.
			word.expression ??= segments;
		},
		openGroup(paren) {
			const fed = piped && empty();
			this.endSegment();
			groups.push({ fed, paren, parent: groups.at(-1) ?? null });
			if (paren) openParens++;
		},
		closeGroup() {
			this.endSegment();
			closedGroup = groups.pop() ?? null;
			if (closedGroup?.paren) openParens--;
		},
	};
}

// PowerShell `-Name:value` is the parameter `-Name` with the value `value`.
const PS_JOINED_PARAMETER = /^-[A-Za-z][A-Za-z0-9]*:./;

/** A word as the segment receives it: PowerShell `-Name:value` becomes the two
    words `-Name` and `value` (D5 rev. 3). */
function psParameterParts(p, word) {
	if (p.mode !== "ps" || !PS_JOINED_PARAMETER.test(word.value)) return [word];
	const colon = word.value.indexOf(":");
	const name = {
		value: word.value.slice(0, colon),
		raw: word.raw.slice(0, colon),
		dynamic: false,
		firstLiteral: true,
	};
	return [name, { ...word, ...joinedValue(word, colon + 1) }];
}

/** Is the segment's stdin a pipe, a `<`/`<<`/`<<<` redirection or a fed group? */
const isStdinFed = (segment) =>
	segment.piped ||
	segment.stdinRedirect ||
	segment.inheritedFed ||
	groupIsFed(segment.group);

/** Is `group`, or a group around it, fed? Segments share their enclosing groups
    as a parent chain instead of copying the open-group stack (D13 rev. 2); the
    answer is cached per group once tokenizing is complete. */
function groupIsFed(group) {
	const pending = [];
	let node = group;
	while (node && node.anyFed === undefined) {
		pending.push(node);
		node = node.parent;
	}
	let fed = node?.anyFed ?? false;
	for (let k = pending.length - 1; k >= 0; k--) {
		fed ||= pending[k].fed;
		pending[k].anyFed = fed;
	}
	return group?.anyFed ?? false;
}

const BLANKS = new Set([" ", "\t", "\r"]);
const GROUPING = new Set(["(", ")", "{", "}", ";"]);
const ESCAPE_CHAR = { bash: "\\", ps: "`" };

/** Escape at p.i: a line continuation is dropped, otherwise the next char is literal. */
function readEscape(p) {
	const next = p.src[p.i + 1];
	if (next === "\n") {
		p.i += 2;
		return "";
	}
	if (next === "\r" && p.src[p.i + 2] === "\n") {
		p.i += 3;
		return "";
	}
	p.i += 2;
	return next ?? "";
}

// One tokenizer step at p.i. Handlers run in order; each returns true when it
// consumed input. An unclaimed character is part of the current word.
function step(p, seg, ch) {
	const next = p.src[p.i + 1];
	const handled =
		stepLayout(p, seg, ch) ||
		stepQuoting(p, seg, ch, next) ||
		stepRedirection(p, seg, ch, next) ||
		stepSeparator(p, seg, ch, next);
	if (!handled) {
		seg.appendUnquoted(ch);
		p.i++;
	}
}

/** Escapes, line breaks, blanks and comments. */
function stepLayout(p, seg, ch) {
	if (ch === ESCAPE_CHAR[p.mode]) {
		const text = readEscape(p);
		if (text !== "") seg.append(text);
	} else if (ch === "\n") {
		seg.endSegment();
		p.i++;
		consumeHeredocs(p);
	} else if (BLANKS.has(ch)) {
		seg.endWord();
		p.i++;
	} else if (ch === "#" && !seg.inWord) skipComment(p);
	else return false;
	return true;
}

/** Quotes, expansions, substitutions and PowerShell here-strings. */
function stepQuoting(p, seg, ch, next) {
	if (ch === "'") seg.append(readSingleQuoted(p));
	else if (ch === '"') readDoubleQuoted(p, seg);
	else if (ch === "$") return stepDollar(p, seg, next);
	else if (ch === "`" && p.mode === "bash") readBacktick(p, seg);
	else if (ch === "@" && startsHereString(p, seg))
		seg.append(readHereString(p));
	else return false;
	return true;
}

/** Bash `$'…'` is a decoded literal and `$"…"` a double-quoted string. */
function stepDollar(p, seg, next) {
	if (p.mode === "bash" && next === "'") readAnsiC(p, seg);
	else if (p.mode === "bash" && next === '"') {
		p.i++;
		readDoubleQuoted(p, seg);
	} else return readExpansion(p, seg, next);
	return true;
}

const SIMPLE_ESCAPES = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};
// Escape letter -> [digit pattern, max digits, radix]; at least one digit needed.
const NUMERIC_ESCAPES = {
	x: [/[0-9a-fA-F]/, 2, 16],
	u: [/[0-9a-fA-F]/, 4, 16],
	U: [/[0-9a-fA-F]/, 8, 16],
};

function readAnsiC(p, seg) {
	p.i += 2;
	seg.append("");
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		if (ch === "'") {
			p.i++;
			return;
		}
		if (ch === "\\") readAnsiCEscape(p, seg);
		else {
			seg.append(ch);
			p.i++;
		}
	}
	throw new Unparseable("unbalanced quotes");
}

/** One `\…` escape inside `$'…'`. An escape that cannot be decoded makes the
    word computed, so it fails closed where it decides anything. */
function readAnsiCEscape(p, seg) {
	const letter = p.src[p.i + 1];
	if (letter === undefined) throw new Unparseable("unbalanced quotes");
	if (Object.hasOwn(SIMPLE_ESCAPES, letter)) {
		seg.append(SIMPLE_ESCAPES[letter]);
		p.i += 2;
		return;
	}
	const decoded = decodeNumericEscape(p, letter);
	if (decoded === undefined) {
		seg.append(`\\${letter}`);
		p.i += 2;
	} else if (decoded === null) seg.markDynamic();
	else seg.append(decoded);
}

/** Returns the decoded text and advances, `null` for an undecodable escape
    (advanced past it), or `undefined` when `letter` is no numeric escape. */
function decodeNumericEscape(p, letter) {
	if (letter === "c") return decodeControl(p);
	const spec = numericEscapeSpec(letter);
	if (spec === undefined) return undefined;
	const [digit, max, radix, skip] = spec;
	const start = p.i + skip;
	let j = start;
	while (j < start + max && digit.test(p.src[j] ?? "")) j++;
	p.i = j;
	if (j === start) return null;
	const code = Number.parseInt(p.src.slice(start, j), radix);
	if (!isScalarValue(code)) return null;
	return String.fromCodePoint(radix === 8 ? code & 0xff : code);
}

/** [digit pattern, max digits, radix, chars to skip before the digits]. Octal
    digits start at the escape letter itself (`\160`). */
function numericEscapeSpec(letter) {
	if (/[0-7]/.test(letter)) return [/[0-7]/, 3, 8, 1];
	if (!Object.hasOwn(NUMERIC_ESCAPES, letter)) return undefined;
	return [...NUMERIC_ESCAPES[letter], 2];
}

const isScalarValue = (code) =>
	code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);

function decodeControl(p) {
	const target = p.src[p.i + 2];
	p.i += 3;
	if (target === undefined || target === "'") {
		p.i -= 1;
		return null;
	}
	return String.fromCharCode(target.charCodeAt(0) & 0x1f);
}

/** Redirections, heredocs, PowerShell block comments and process substitution
    `<(`/`>(`. */
function stepRedirection(p, seg, ch, next) {
	if (ch !== "<" && ch !== ">") return false;
	if (next === "(") stepAngleParen(p, seg);
	else if (ch === ">") readRedirection(p, seg, ch);
	else if (p.mode === "ps") return stepPsLessThan(p, seg, next);
	else if (next === "<") readHeredocStart(p, seg);
	else readRedirection(p, seg, ch);
	return true;
}

/** `<(` / `>(`: Bash process substitution; in PowerShell the `(` groups. */
function stepAngleParen(p, seg) {
	if (p.mode === "bash") return readProcessSubstitution(p, seg);
	seg.endWord();
	p.i++;
}

/** Bash `<(…)` / `>(…)`: parsed like `$(…)`, standing as one computed word. The
    commands inside `>(…)` read the output written to it: they are stdin-fed
    (D12 rev. 2). */
function readProcessSubstitution(p, seg) {
	const output = p.src[p.i] === ">";
	seg.endWord();
	p.i += 2;
	seg.markProcessSubstitution();
	parseList(p, ")", { fed: output });
}

/** PowerShell has no `<` redirection; `<#` opens a block comment. */
function stepPsLessThan(p, seg, next) {
	if (next !== "#" || seg.inWord) return false;
	skipBlockComment(p);
	return true;
}

const FD_PREFIX = { bash: /^\d+$/, ps: /^(\d+|\*)$/ };
const REDIRECTION_SUFFIX = { ">": ">|&", "<": "&>" };

/** `[n]>`, `>>`, `>&`, `>|`, `<`, `<&`, `<>` (PowerShell `2>`, `*>&1`): the fd
    prefix and the target word are not arguments of the command. */
function readRedirection(p, seg, ch) {
	if (FD_PREFIX[p.mode].test(seg.currentRaw)) seg.dropWord();
	else seg.endWord();
	p.i++;
	const after = p.src[p.i];
	if (after !== undefined && REDIRECTION_SUFFIX[ch].includes(after)) p.i++;
	seg.redirect({ feedsStdin: ch === "<" });
}

/** Segment separators: `&`, `|`, `;` and grouping. */
function stepSeparator(p, seg, ch, next) {
	if (ch === "&") stepAmpersand(p, seg, next);
	else if (ch === "|") {
		// `||` is a list operator; `|` and Bash `|&` pipe into the next segment.
		const pipes = next !== "|";
		seg.endSegment({ nextPiped: pipes, ending: pipes ? "pipe" : "list" });
		p.i += next === "|" || next === "&" ? 2 : 1;
	} else if (ch === ";") {
		seg.endSegment();
		p.i++;
	} else if (isGrouping(p, seg, ch, next)) stepGrouping(p, seg, ch);
	else return false;
	return true;
}

/** `(`/`{` opens a group, `)`/`}` closes one. PowerShell `& (expr)` calls an
    expression whose command cannot be known. */
function stepGrouping(p, seg, ch) {
	if (callsExpression(p, seg, ch))
		p.segments.push({
			words: [],
			broken: broken("PowerShell call operator applied to an expression"),
		});
	else if (ch === "(" && p.mode === "ps" && seg.hasWords)
		return readArgumentExpression(p, seg);
	if (ch === "(" || ch === "{") seg.openGroup(ch === "(");
	else seg.closeGroup();
	p.i++;
}

/** PowerShell `(` after a word of the same command: an expression whose value is
    passed as an argument. It is one computed word; the commands inside it are
    still parsed as segments, and kept on the word (D5 rev. 2). */
function readArgumentExpression(p, seg) {
	p.i++;
	const before = p.segments.length;
	seg.markDynamic();
	parseList(p, ")");
	seg.noteExpression(p.segments.slice(before));
}

const callsExpression = (p, seg, ch) =>
	ch === "(" && p.mode === "ps" && seg.callPending;

const isBrace = (ch) => ch === "{" || ch === "}";

// Bash braces group only as standalone words (`{ cmd; }`); `{a,b}`, `@{-1}` and
// `repos/{owner}` are words. PowerShell braces always group.
function isGrouping(p, seg, ch, next) {
	if (!GROUPING.has(ch)) return false;
	if (p.mode === "ps" || !isBrace(ch)) return true;
	if (seg.inWord) return false;
	return ch === "}" || /^\s?$/.test(next ?? "");
}

function stepAmpersand(p, seg, next) {
	// Bash `&>file` / `&>>file`: the `>` that follows is read as a redirection.
	if (p.mode === "bash" && next === ">") {
		seg.endWord();
		p.i++;
		return;
	}
	// PowerShell `& <command>` is the call operator: its command word is checked.
	// A single Bash `&` runs the segment before it as a background job.
	const background = p.mode === "bash" && next !== "&";
	seg.endSegment({
		nextCalled: p.mode === "ps" && next !== "&",
		ending: background ? "background" : "list",
	});
	p.i += next === "&" ? 2 : 1;
}

const VARIABLE_START = { bash: /[A-Za-z0-9_@*#?$!{-]/, ps: /[A-Za-z_{?:^$]/ };

/** `$` at p.i: a substitution or variable marks the word dynamic. Returns false
    for a literal `$`. */
function readExpansion(p, seg, next, inDouble = false) {
	if (next === "(") return readSubstitution(p, seg);
	if (next === undefined || !VARIABLE_START[p.mode].test(next)) return false;
	seg.markDynamic();
	if (next === "{") readBracedVariable(p, seg, inDouble);
	else readVariableName(p, seg);
	return true;
}

const startsArithmetic = (p) => p.mode === "bash" && p.src[p.i + 2] === "(";

/** `$(` at p.i: Bash arithmetic `$((…))`, else a command substitution. */
function readSubstitution(p, seg) {
	if (startsArithmetic(p) && readArithmetic(p, seg)) return true;
	p.i += 2;
	seg.markDynamic();
	parseList(p, ")");
	return true;
}

/** `${…}` at p.i: a Bash parameter body, or PowerShell `${env:NAME}`, which
    names its variable between the braces. */
function readBracedVariable(p, seg, inDouble) {
	p.i += 2;
	if (p.mode === "bash") return skipParameterBody(p, inDouble);
	const nameStart = p.i;
	skipPast(p, "}", "unterminated ${...}");
	seg.noteVariable(p.src.slice(nameStart, p.i - 1));
}

function readVariableName(p, seg) {
	const nameStart = p.i + 1;
	p.i += 2;
	while (p.i < p.src.length && /[A-Za-z0-9_:]/.test(p.src[p.i])) p.i++;
	seg.noteVariable(p.src.slice(nameStart, p.i));
}

/** Bash `$(( … ))` at p.i: one computed word whose `$( … )` and backtick
    substitutions are still parsed. Returns false, with p unchanged, when the
    `$((` does not close with `))`: POSIX then reads it as a command substitution
    starting with a subshell (D5 rev. 2). */
function readArithmetic(p, seg) {
	// A start that already failed is not re-tried: nested unclosed `$((` would
	// otherwise be re-scanned at every level (exponential, D5 rev. 3).
	if (p.arithmeticFailed.has(p.i)) return false;
	const saved = { i: p.i, depth: p.depth, segments: p.segments.length };
	p.i += 3;
	try {
		if (scanArithmetic(p)) {
			seg.markDynamic();
			return true;
		}
	} catch (err) {
		if (!(err instanceof Unparseable)) throw err;
	}
	p.i = saved.i;
	p.depth = saved.depth;
	p.segments.length = saved.segments;
	p.arithmeticFailed.add(saved.i);
	return false;
}

/** Scans an arithmetic body after `$((`; true once its closing `))` is read. */
function scanArithmetic(p) {
	const sink = newSegmentBuilder(p);
	let depth = 0;
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		if (ch === ")" && depth === 0) {
			if (p.src[p.i + 1] !== ")") return false;
			p.i += 2;
			return true;
		}
		depth += parenDelta(ch, depth);
		if (!stepArithmetic(p, sink, ch)) p.i++;
	}
	return false;
}

function stepArithmetic(p, sink, ch) {
	if (ch === "\\") p.i += 2;
	else if (ch === "`") readBacktick(p, sink);
	else return ch === "$" && readExpansion(p, sink, p.src[p.i + 1], true);
	return true;
}

function skipPast(p, text, why) {
	const close = p.src.indexOf(text, p.i);
	if (close === -1) throw new Unparseable(why);
	p.i = close + text.length;
}

/** The body of a Bash `${…}`, after `${`: nested substitutions are parsed (so
    `${X:-$(git push)}` is inspected); quotes and nested `${` are honoured. Inside
    double quotes a single quote is a plain character. */
function skipParameterBody(p, inDouble) {
	const sink = newSegmentBuilder(p);
	let depth = 1;
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		if (ch === "}" && --depth === 0) {
			p.i++;
			return;
		}
		if (ch === "$" && p.src[p.i + 1] === "{") depth++;
		if (!stepParameterBody(p, sink, inDouble)) p.i++;
	}
	throw new Unparseable("unterminated ${...}");
}

function stepParameterBody(p, sink, inDouble) {
	const ch = p.src[p.i];
	const next = p.src[p.i + 1];
	if (ch === "\\") p.i += 2;
	else if (ch === "'" && !inDouble) readSingleQuoted(p);
	else if (ch === '"') readDoubleQuoted(p, sink);
	else if (ch === "`") readBacktick(p, sink);
	else if (ch === "$" && next === "(") readExpansion(p, sink, next);
	else return false;
	return true;
}

function readBacktick(p, seg) {
	p.i++;
	seg.markDynamic();
	parseList(p, "`");
}

function skipComment(p) {
	while (p.i < p.src.length && p.src[p.i] !== "\n") p.i++;
}

function skipBlockComment(p) {
	const end = p.src.indexOf("#>", p.i + 2);
	if (end === -1) throw new Unparseable("unterminated block comment");
	p.i = end + 2;
}

function readSingleQuoted(p) {
	let out = "";
	p.i++;
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		if (ch === "'") {
			if (p.mode === "ps" && p.src[p.i + 1] === "'") {
				out += "'";
				p.i += 2;
				continue;
			}
			p.i++;
			return out;
		}
		out += ch;
		p.i++;
	}
	throw new Unparseable("unbalanced quotes");
}

function readDoubleQuoted(p, seg) {
	p.i++;
	seg.append("");
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		const next = p.src[p.i + 1];
		if (closesDoubleQuote(p, ch, next)) {
			p.i++;
			return;
		}
		stepDoubleQuoted(p, seg, ch, next);
	}
	throw new Unparseable("unbalanced quotes");
}

/** `""` inside PowerShell double quotes is a literal quote, not the end. */
function closesDoubleQuote(p, ch, next) {
	if (ch !== '"') return false;
	return p.mode !== "ps" || next !== '"';
}

// Inside double quotes Bash escapes only `$ \` " \ newline`; PowerShell's
// backtick escapes anything and `""` is a literal quote.
const escapesInDoubleQuotes = (p, next) =>
	p.mode === "ps" || /[$`"\\\r\n]/.test(next ?? "");

// PowerShell "`u{67}" is a Unicode escape; the word is treated as computed.
const isPsUnicodeEscape = (p, ch, next) =>
	p.mode === "ps" && ch === "`" && next === "u" && p.src[p.i + 2] === "{";

function stepDoubleQuoted(p, seg, ch, next) {
	if (ch === '"') {
		seg.append('"');
		p.i += 2;
	} else if (isPsUnicodeEscape(p, ch, next)) {
		seg.markDynamic();
		skipPast(p, "}", "unterminated `u{...}");
	} else if (ch === ESCAPE_CHAR[p.mode] && escapesInDoubleQuotes(p, next))
		seg.append(readEscape(p));
	else if (ch === "$" && readExpansion(p, seg, next, true)) return;
	else if (ch === "`" && p.mode === "bash") readBacktick(p, seg);
	else {
		seg.append(ch);
		p.i++;
	}
}

const startsHereString = (p, seg) =>
	p.mode === "ps" && !seg.inWord && isHereString(p);

function isHereString(p) {
	const quote = p.src[p.i + 1];
	if (quote !== "'" && quote !== '"') return false;
	const after = p.src.slice(p.i + 2, p.i + 4);
	return after.startsWith("\n") || after === "\r\n";
}

function readHereString(p) {
	const quote = p.src[p.i + 1];
	const bodyStart = p.src.indexOf("\n", p.i) + 1;
	const close = p.src.indexOf(`\n${quote}@`, bodyStart - 1);
	if (close === -1) throw new Unparseable("unterminated here-string");
	p.i = close + 3;
	const body = p.src.slice(bodyStart, close).replace(/\r$/, "");
	if (quote === '"') scanExpandingBody(p, body);
	return body;
}

/** The body of an expanding heredoc or `@"…"@` here-string: only substitutions
    are parsed (their segments are inspected); quote characters are plain text. */
function scanExpandingBody(p, body) {
	const q = {
		...p,
		src: body,
		i: 0,
		heredocs: [],
		arithmeticFailed: new Set(),
	};
	const sink = newSegmentBuilder(q);
	while (q.i < body.length) {
		const ch = body[q.i];
		const next = body[q.i + 1];
		if (ch === ESCAPE_CHAR[q.mode]) q.i += 2;
		else if (ch === "`" && q.mode === "bash") readBacktick(q, sink);
		else if (!(ch === "$" && readExpansion(q, sink, next, true))) q.i++;
	}
}

function readHeredocStart(p, seg) {
	seg.endWord();
	// `<<<word`: a here-string feeds the word to stdin.
	if (p.src[p.i + 2] === "<") {
		p.i += 3;
		seg.redirect({ feedsStdin: true });
		return;
	}
	seg.redirect({ feedsStdin: true, hasTarget: false });
	p.i += 2;
	const strip = p.src[p.i] === "-";
	if (strip) p.i++;
	while (p.src[p.i] === " " || p.src[p.i] === "\t") p.i++;
	p.heredocs.push({ ...readHeredocDelimiter(p), strip });
}

/** The delimiter word. Any quoting in it makes the body literal; otherwise the
    body expands. */
function readHeredocDelimiter(p) {
	let delim = "";
	let quoted = false;
	while (p.i < p.src.length && !/[\s;|&<>()]/.test(p.src[p.i])) {
		const ch = p.src[p.i];
		quoted ||= `'"\\`.includes(ch);
		delim += readDelimiterPart(p, ch);
	}
	return { delim, quoted };
}

function readDelimiterPart(p, ch) {
	if (ch === "'") return readSingleQuoted(p);
	if (ch === "\\") return readEscape(p);
	if (ch === '"') {
		const sink = newSegmentBuilder(p);
		readDoubleQuoted(p, sink);
		return sink.current;
	}
	p.i++;
	return ch;
}

/** After a newline, consume the bodies of heredocs opened on the previous line;
    an expanding body is scanned for substitutions. */
function consumeHeredocs(p) {
	for (const { delim, strip, quoted } of p.heredocs) {
		const start = p.i;
		let bodyEnd = p.src.length;
		while (p.i < p.src.length) {
			const nl = p.src.indexOf("\n", p.i);
			const end = nl === -1 ? p.src.length : nl;
			let line = p.src.slice(p.i, end).replace(/\r$/, "");
			if (strip) line = line.replace(/^\t+/, "");
			const lineStart = p.i;
			p.i = nl === -1 ? p.src.length : nl + 1;
			if (line === delim) {
				bodyEnd = lineStart;
				break;
			}
		}
		if (!quoted) scanExpandingBody(p, p.src.slice(start, bodyEnd));
	}
	p.heredocs = [];
}

// ---- word facts ------------------------------------------------------------------
//
// Analyses work on word objects `{ value, raw, dynamic, firstLiteral, vars }` and
// index ranges of a segment's word list, so a range question ("is any word before
// `--` computed?") is answered from a cached suffix table instead of a rescan.

const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/;
const GLOB = /[*?]|\[[^\]]*\]/;
const PLAIN_WORD = /^[A-Za-z0-9-]+$/;

/** A word whose value is only known at run time: a variable, substitution or
    undecodable escape (`dynamic`), or unquoted brace expansion or glob. The test
    words `[` and `[[` are not globs. */
function isComputed(word) {
	if (word.dynamic) return true;
	if (word.value === "[" || word.value === "[[") return false;
	return BRACE_EXPANSION.test(word.raw) || GLOB.test(word.raw);
}

/** A computed word that cannot turn into an option: it starts with a literal
    character other than `-` (`"repos/$O/$R"`). */
const isOptionSafe = (word) =>
	word.firstLiteral === true && !word.value.startsWith("-");

const suffixTables = new WeakMap();

/** Cached right-to-left fold over `words`: table[k] = step(words[k], table[k+1]),
    table[words.length] = init. One table per (word list, key). */
function suffixTable(words, key, step, init) {
	let tables = suffixTables.get(words);
	if (tables === undefined) {
		tables = new Map();
		suffixTables.set(words, tables);
	}
	let table = tables.get(key);
	if (table === undefined) {
		table = new Array(words.length + 1);
		table[words.length] = init;
		for (let k = words.length - 1; k >= 0; k--)
			table[k] = step(words, k, table[k + 1]);
		tables.set(key, table);
	}
	return table;
}

const walkCaches = new WeakMap();

/** Cached forward walk over `words` from `start`: `step(k)` returns
    `{ done: result }` or `{ next }` and must depend only on k. Every index
    visited shares the result, so a walk restarted from a later word (every
    `git`, `gh` or computed word re-walks the options after it) costs nothing:
    analysis stays linear in the command length (D13 rev. 2). */
function memoWalk(words, key, start, step) {
	let caches = walkCaches.get(words);
	if (caches === undefined) {
		caches = new Map();
		walkCaches.set(words, caches);
	}
	let cache = caches.get(key);
	if (cache === undefined) {
		cache = new Map();
		caches.set(key, cache);
	}
	const visited = [];
	let result;
	for (let k = start; ; ) {
		if (cache.has(k)) {
			result = cache.get(k);
			break;
		}
		visited.push(k);
		const r = step(k);
		if ("done" in r) {
			result = r.done;
			break;
		}
		k = r.next;
	}
	for (const k of visited) cache.set(k, result);
	return result;
}

/** Boolean suffix table: table[k] = step(words[k], table[k+1]). */
const suffixAny = (words, key, step) =>
	suffixTable(words, key, (ws, k, rest) => step(ws[k], rest), false);

/** Does any word in words[from..] satisfy `test`? */
const anyFrom = (words, from, key, test) =>
	suffixAny(words, key, (w, rest) => test(w) || rest)[from] ?? false;

/** Does any word from `from` up to the first `--` satisfy `test`? */
const anyBeforeDashDash = (words, from, key, test) =>
	suffixAny(
		words,
		`${key}/--`,
		(w, rest) => w.value !== "--" && (test(w) || rest),
	)[from] ?? false;

// ---- option tables -----------------------------------------------------------------
//
// Runners, wrappers and launchers read their options from a table: "flag" takes
// no value, "value" takes the next word unless joined (`-n1`, `--opt=v`),
// "optional" takes a value only joined, and "string" is the option whose value
// is a command string. An option missing from the table is "unknown": it may
// take the next word, so what follows cannot be known (D5/D12 rev. 2).

let optionSpecCount = 0;

/** Builds a table from space-separated names per kind (`a` short, `--x` long). */
function optionSpec(kinds) {
	const spec = { id: optionSpecCount++, short: new Map(), long: new Map() };
	for (const [kind, names] of Object.entries(kinds))
		for (const name of names.split(/\s+/).filter(Boolean))
			(name.startsWith("--") ? spec.long : spec.short).set(name, kind);
	return spec;
}

/** The value joined to an option word from position `at` (raw and value align). */
const joinedValue = (word, at) => ({
	value: word.value.slice(at),
	raw: word.raw.slice(at),
	dynamic: word.dynamic,
	firstLiteral: true,
});

function readLongOption(words, k, spec) {
	const v = words[k].value;
	const eq = v.indexOf("=");
	const kind = spec.long.get(eq === -1 ? v : v.slice(0, eq));
	if (kind === undefined) return { unknown: true };
	if (kind !== "value" && kind !== "string") return { width: 1, kind };
	if (eq !== -1)
		return { width: 1, kind, value: joinedValue(words[k], eq + 1) };
	return { width: 2, kind, value: words[k + 1] };
}

function readShortCluster(words, k, spec) {
	const v = words[k].value;
	for (let j = 1; j < v.length; j++) {
		const kind = spec.short.get(v[j]);
		if (kind === undefined) return { unknown: true };
		if (kind === "optional") return { width: 1, kind };
		if (kind !== "value" && kind !== "string") continue;
		if (j + 1 < v.length)
			return { width: 1, kind, value: joinedValue(words[k], j + 1) };
		return { width: 2, kind, value: words[k + 1] };
	}
	return { width: 1, kind: "flag" };
}

/** The option word at `k`: `{ width, kind, value }` or `{ unknown: true }`. */
function readOption(words, k, spec) {
	if (words[k].value === "--") return { width: 1, kind: "end" };
	if (words[k].value.startsWith("--")) return readLongOption(words, k, spec);
	return readShortCluster(words, k, spec);
}

const isOptionWord = (word) => /^-./.test(word.value);

/** Reads options from `from`: `{ next }` (first word after them), with
    `unknown` (index of an unknown option) or `string` (the command-string
    option's value word, or null when it has none). */
function readOptions(words, from, spec) {
	return memoWalk(words, `options/${spec.id}`, from, (k) => {
		if (k >= words.length || !isOptionWord(words[k]))
			return { done: { next: k } };
		const opt = readOption(words, k, spec);
		if (opt.unknown) return { done: { next: k, unknown: k } };
		if (opt.kind === "end") return { done: { next: k + 1 } };
		if (opt.kind === "string")
			return { done: { next: k + opt.width, string: opt.value ?? null } };
		return { next: k + opt.width };
	});
}

// ---- git -------------------------------------------------------------------------

const BRANCH = "branch creation";

// Short-option clusters are matched letter by letter (`-fc` contains `c`).
const isCluster = (arg) => /^-[a-zA-Z]+$/.test(arg);
const clusterHas = (arg, letters) =>
	isCluster(arg) && [...arg.slice(1)].some((ch) => letters.includes(ch));
const hasLongOption = (arg, names) =>
	names.some((n) => arg === n || arg.startsWith(`${n}=`));

const SWITCH_CREATE = ["--create", "--force-create", "--orphan", "--track"];
const CHECKOUT_CREATE = ["--orphan", "--track"];
const BRANCH_RENAME_COPY = ["--copy", "--move"];
// Modes in which `git branch` lists, deletes or edits upstream instead of creating.
// Display options (`-v`, `--verbose`, `--format`, `--sort`, `--column`) are not
// modes: with a new name, git still creates the branch (D4 rev. 2).
const BRANCH_QUERY = [
	"--list",
	"--all",
	"--remotes",
	"--show-current",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--delete",
	"--set-upstream-to",
	"--unset-upstream",
	"--edit-description",
];
// Display options that take the next word as their value when written without `=`.
const BRANCH_DISPLAY_WITH_VALUE = new Set(["--format", "--sort"]);

/** A `git branch` argument that names a branch: not an option, and not the
    separate value of `--format`/`--sort`. */
const isBranchName = (words, k) =>
	!words[k].value.startsWith("-") &&
	!BRANCH_DISPLAY_WITH_VALUE.has(words[k - 1]?.value);

const switchCreates = (words, from) =>
	anyBeforeDashDash(
		words,
		from,
		"switch-create",
		({ value }) =>
			clusterHas(value, "cCt") || hasLongOption(value, SWITCH_CREATE),
	);

const checkoutCreates = (words, from) =>
	anyBeforeDashDash(
		words,
		from,
		"checkout-create",
		({ value }) =>
			clusterHas(value, "bBt") || hasLongOption(value, CHECKOUT_CREATE),
	);

function branchCreates(words, from) {
	const copies = ({ value }) =>
		clusterHas(value, "cCmM") || hasLongOption(value, BRANCH_RENAME_COPY);
	if (anyBeforeDashDash(words, from, "branch-copy", copies)) return true;
	const queries = ({ value }) =>
		clusterHas(value, "dDalru") || hasLongOption(value, BRANCH_QUERY);
	if (anyBeforeDashDash(words, from, "branch-query", queries)) return false;
	const names = suffixTable(
		words,
		"branch-name",
		(ws, k, later) => later || isBranchName(ws, k),
		false,
	);
	return names[from] ?? false;
}

const pushesVia = (words, from) =>
	anyFrom(words, from, "push-word", ({ value }) => value === "push");

// git subcommand -> [outward kind, does this invocation act outward?]
const GIT_OUTWARD = {
	push: ["git push", () => true],
	"send-pack": ["git push", () => true],
	"http-push": ["git push", () => true],
	subtree: ["git push", pushesVia],
	lfs: ["git push", pushesVia],
	switch: [BRANCH, switchCreates],
	checkout: [BRANCH, checkoutCreates],
	branch: [BRANCH, branchCreates],
	stash: [BRANCH, (words, from) => words[from]?.value === "branch"],
	worktree: [
		"worktree creation",
		(words, from) => words[from]?.value === "add",
	],
};

// Which arguments decide what an outward-capable subcommand does (D5 rev. 1).
// push, send-pack and http-push are outward whatever their arguments.
const DECISIVE_ARGS = {
	switch: "before --",
	checkout: "before --",
	branch: "before --",
	stash: "first",
	worktree: "first",
	subtree: "all",
	lfs: "all",
};

function decisiveArgComputed(sub, words, from) {
	const rule = Object.hasOwn(DECISIVE_ARGS, sub) ? DECISIVE_ARGS[sub] : null;
	if (rule === "first")
		return words[from] !== undefined && isComputed(words[from]);
	if (rule === null) return false;
	const any = rule === "before --" ? anyBeforeDashDash : anyFrom;
	return any(words, from, "computed", isComputed);
}

function gitSubcommandReason(sub, words, from) {
	// Every git commit the analysis meets, aliases and wrapper strings included,
	// is gated once the command has no other reason (D14).
	if (sub === "commit") decision.commits++;
	if (!Object.hasOwn(GIT_OUTWARD, sub)) return null;
	if (decisiveArgComputed(sub, words, from))
		return broken(`an argument that decides what git ${sub} does is computed`);
	const [kind, acts] = GIT_OUTWARD[sub];
	return acts(words, from) ? outward(kind) : null;
}

// git's global options (D5 rev. 1); any other option before the subcommand asks,
// since it may consume the next word.
const GIT_GLOBAL_OPTIONS = new Set([
	"-v",
	"--version",
	"-h",
	"--help",
	"-C",
	"-c",
	"--config-env",
	"--exec-path",
	"--html-path",
	"--man-path",
	"--info-path",
	"-p",
	"--paginate",
	"-P",
	"--no-pager",
	"--no-replace-objects",
	"--no-lazy-fetch",
	"--no-optional-locks",
	"--no-advice",
	"--bare",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--list-cmds",
	"--attr-source",
]);
// Path options consume the next word when written without `=`; their values do
// not decide the action, so they may be computed (`git -C "$DIR" status`).
const GIT_PATH_OPTIONS = new Set([
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--attr-source",
]);
// PowerShell `Start-Process git -ArgumentList push`: the parameter name is skipped
// so its value is read as git's subcommand.
const PS_ARGUMENT_LIST =
	/^-(args|a(r(g(u(m(e(n(t(l(i(s(t)?)?)?)?)?)?)?)?)?)?)?)$/i;
const RUNTIME_CONFIG = "git configuration is supplied at run time";

/** A `-c` setting's `[lower-case key, value]`. */
function configSetting(word) {
	const [, rawKey, value] = /^([^=]*)=?(.*)$/s.exec(word.value);
	return [rawKey.toLowerCase(), value];
}

/** `-c <name>=<value>`: returns the option's width, or a broken reason. */
function readGitConfigOption(valueWord) {
	if (valueWord === undefined) return 1;
	if (isComputed(valueWord)) return broken("git -c setting is computed");
	const [key] = configSetting(valueWord);
	if (key === "include.path" || key.startsWith("includeif."))
		return broken(RUNTIME_CONFIG);
	return 2;
}

/** Width (1 or 2 words) of the git option at `j`, or a broken reason. */
function gitOptionWidth(words, j) {
	const word = words[j];
	const [name] = word.value.split("=", 1);
	const joined = word.value.includes("=");
	if (name === "--config-env") return broken(RUNTIME_CONFIG);
	if (!GIT_GLOBAL_OPTIONS.has(name))
		return broken(
			`git option ${JSON.stringify(word.value)} is not a global option`,
		);
	// Only a path option's joined value may be computed (`--git-dir=$D`).
	const pathValue = joined && GIT_PATH_OPTIONS.has(name);
	if (isComputed(word) && !pathValue) return broken("a git option is computed");
	if (name === "-c") return readGitConfigOption(words[j + 1]);
	return GIT_PATH_OPTIONS.has(name) && !joined ? 2 : 1;
}

/** Skips git's own options from `start`: `{ sub, aliases }` with the index of the
    subcommand and its inline aliases, or `{ reason }` when a deciding word fails
    closed. The walk is cached (D13 rev. 2). */
function readGitOptions(words, start, mode) {
	const end = memoWalk(words, `git/${mode}`, start, (j) => {
		if (j >= words.length || !/^-./.test(words[j].value))
			return { done: { sub: j } };
		if (mode === "ps" && PS_ARGUMENT_LIST.test(words[j].value))
			return { next: j + 1 };
		const width = gitOptionWidth(words, j);
		if (typeof width === "string") return { done: { reason: width } };
		return { next: j + width };
	});
	if (end.reason) return end;
	return { sub: end.sub, aliases: aliasesBetween(words, start, end.sub) };
}

const aliasDefinitionCache = new WeakMap();

/** `-c alias.<name>=<value>` settings of a word list, in order, cached. */
function aliasDefinitions(words) {
	let definitions = aliasDefinitionCache.get(words);
	if (definitions !== undefined) return definitions;
	definitions = [];
	for (let k = 0; k + 1 < words.length; k++) {
		if (words[k].value !== "-c" || isComputed(words[k + 1])) continue;
		const [key, value] = configSetting(words[k + 1]);
		if (key.startsWith("alias."))
			definitions.push({ at: k, name: key.slice("alias.".length), value });
	}
	aliasDefinitionCache.set(words, definitions);
	return definitions;
}

/** Inline aliases set between `start` and `end`; a later one wins, as in git. */
function aliasesBetween(words, start, end) {
	const aliases = new Map();
	const definitions = aliasDefinitions(words);
	if (definitions.length === 0) return aliases;
	let lo = 0;
	let hi = definitions.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (definitions[mid].at < start) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < definitions.length && definitions[i].at < end; i++)
		aliases.set(definitions[i].name, definitions[i].value);
	return aliases;
}

/** The git invocation whose words start at `start` (just after `git`). `chain`
    carries inline aliases and the alias names already expanded, so aliases
    resolve through each other (D5 rev. 2). */
function gitInvocationReason(words, start, mode, chain = null) {
	const read = readGitOptions(words, start, mode);
	if (read.reason) return read.reason;
	const subWord = words[read.sub];
	if (subWord === undefined) return null;
	const problem = gitSubcommandProblem(subWord);
	if (problem) return problem;
	const sub = subWord.value.toLowerCase();
	const aliases = chain
		? new Map([...chain.aliases, ...read.aliases])
		: read.aliases;
	if (!aliases.has(sub)) return gitSubcommandReason(sub, words, read.sub + 1);
	const args = { words, from: read.sub + 1 };
	return expandGitAlias(sub, args, mode, { aliases, seen: chain?.seen });
}

function gitSubcommandProblem(subWord) {
	if (isComputed(subWord)) return broken("the git subcommand is computed");
	if (!PLAIN_WORD.test(subWord.value))
		return broken(
			`git subcommand ${JSON.stringify(subWord.value)} is not a plain word`,
		);
	return null;
}

/** Expands inline alias `sub` in front of its arguments `rest`; a `!` alias is
    a shell command. */
function expandGitAlias(sub, args, mode, { aliases, seen = new Set() }) {
	const problem = aliasChainProblem(sub, seen) ?? aliasBudgetProblem();
	if (problem) return problem;
	const alias = aliases.get(sub);
	if (alias.startsWith("!")) return analyzeCommand(alias.slice(1), "bash");
	const expanded = tokenize(alias, "bash")[0]?.words ?? [];
	const { words, from } = args;
	return gitInvocationReason([...expanded, ...words.slice(from)], 0, mode, {
		aliases,
		seen: new Set([...seen, sub]),
	});
}

/** Each expansion copies the rest of its segment, so one decision may expand
    at most MAX_NESTING inline aliases (D5/D13 rev. 3). */
function aliasBudgetProblem() {
	if (++decision.aliasExpansions <= MAX_NESTING) return null;
	return broken(`git alias expansions exceed ${MAX_NESTING} in one command`);
}

/** An alias that expands to itself, or a chain deeper than the nesting bound,
    asks broken with its own reason (degrade-distinguishes-broken). */
function aliasChainProblem(sub, seen) {
	if (seen.has(sub))
		return broken(`git alias ${JSON.stringify(sub)} expands to itself`);
	if (seen.size >= MAX_NESTING)
		return broken(`git alias chain is deeper than ${MAX_NESTING}`);
	return null;
}

/** A `git-<name>` program (`git-lfs`, `/usr/lib/git-core/git-push`) is the
    `git <name>` command; its arguments start at `from` (D4 rev. 2). */
function gitDashReason(name, words, from) {
	const sub = name.slice("git-".length);
	if (!PLAIN_WORD.test(sub)) return null;
	return gitSubcommandReason(sub, words, from);
}

// ---- gh ------------------------------------------------------------------------

// Known-read gh commands: top-level -> read subcommands, or "*" when every
// subcommand reads. Anything absent asks (default-ask, D3).
const GH_READS = {
	pr: ["view", "list", "status", "diff", "checks"],
	issue: ["view", "list", "status"],
	repo: ["view", "list"],
	auth: ["status"],
	run: ["view", "list", "watch"],
	workflow: ["view", "list"],
	release: ["view", "list"],
	gist: ["view", "list"],
	label: ["list"],
	cache: ["list"],
	secret: ["list"],
	variable: ["list", "get"],
	search: "*",
	status: "*",
	help: "*",
	version: "*",
	completion: "*",
};
// gh top-level commands that can write: a computed word directly followed by one
// of these, forming an outward invocation, asks (D5 rev. 1).
const GH_WRITE_CAPABLE = new Set([
	"agent-task",
	"alias",
	"api",
	"attestation",
	"auth",
	"cache",
	"co",
	"codespace",
	"config",
	"extension",
	"gist",
	"gpg-key",
	"issue",
	"label",
	"org",
	"pr",
	"preview",
	"project",
	"release",
	"repo",
	"ruleset",
	"run",
	"secret",
	"ssh-key",
	"variable",
	"workflow",
]);
const GH_REPO_FLAGS = new Set(["-R", "--repo"]);
const GH_API_FIELD_FLAGS = ["--field", "--raw-field", "--input"];
// `-f`/`-F` take their value joined too: `-ftitle=x`, `-Fn=1`.
const isGhFieldFlag = ({ value }) =>
	/^-[fF]/.test(value) || hasLongOption(value, GH_API_FIELD_FLAGS);
const GH_API_OPTIONS_WITH_ARG = new Set([
	"-X",
	"--method",
	"-f",
	"-F",
	"--field",
	"--raw-field",
	"-H",
	"--header",
	"--input",
	"-p",
	"--preview",
	"-q",
	"--jq",
	"-t",
	"--template",
	"--cache",
	"--hostname",
]);

// Options gh reads at the root and group level without a value; `-R`/`--repo`
// take one. Any other option there may take the next word (D3 rev. 2).
const GH_ROOT_OPTIONS = new Set(["--help", "-h", "--version"]);
// Top-level commands with no subcommand level: their own options follow freely.
const GH_LEAF_COMMANDS = new Set([
	"api",
	"search",
	"status",
	"help",
	"version",
	"completion",
	"browse",
]);
const GH_UNKNOWN_OPTION =
	"gh option before the subcommand may take the next word";
const isGhRepoJoined = (v) => v.startsWith("--repo=") || /^-R./.test(v);
const isGhPositional = (word) =>
	!word.value.startsWith("-") || isComputed(word);

/** The next positional word from `start`, past `-R <repo>`, `--help` and
    `--version`: `{ at }`, or `{ unknown }` for any other option. Cached. */
function ghNextPositional(words, start) {
	return memoWalk(words, "gh-positional", start, (k) => {
		if (k >= words.length) return { done: {} };
		const v = words[k].value;
		if (isGhPositional(words[k])) return { done: { at: k } };
		if (GH_REPO_FLAGS.has(v)) return { next: k + 2 };
		if (GH_ROOT_OPTIONS.has(v) || isGhRepoJoined(v)) return { next: k + 1 };
		return { done: { unknown: k } };
	});
}

/** The first two positional words of a gh invocation from `start` (`second`
    only for command groups), or `unknown`: the index of an option gh may read
    as taking the next word, before the subcommand. */
function ghPositionals(words, start) {
	const first = ghNextPositional(words, start);
	if (first.at === undefined) return { unknown: first.unknown };
	if (GH_LEAF_COMMANDS.has(words[first.at].value.toLowerCase()))
		return { first: first.at };
	const second = ghNextPositional(words, first.at + 1);
	return { first: first.at, second: second.at, unknown: second.unknown };
}

function ghWordProblem(word) {
	if (isComputed(word)) return broken("a gh subcommand is computed");
	if (!PLAIN_WORD.test(word.value))
		return broken(
			`gh subcommand ${JSON.stringify(word.value)} is not a plain word`,
		);
	return null;
}

/** HTTP method of `gh api` from `from`: the last explicit -X/--method, else
    POST when fields are sent, else GET. */
function ghApiMethod(words, from) {
	const methods = suffixTable(
		words,
		"gh-method",
		(ws, k, later) => later ?? ghMethodAt(ws, k),
		null,
	);
	if (methods[from] != null) return methods[from].toUpperCase();
	return anyFrom(words, from, "gh-field", isGhFieldFlag) ? "POST" : "GET";
}

function ghMethodAt(words, k) {
	const v = words[k].value;
	if (v === "-X" || v === "--method") return words[k + 1]?.value ?? "";
	if (v.startsWith("--method=")) return v.slice("--method=".length);
	if (v.startsWith("-X")) return v.slice(2).replace(/^=/, "");
	return null;
}

/** `gh api`, words from `from`: every option, value and argument decides, except
    an option-safe endpoint (D5 rev. 1). */
function ghApiReason(words, from) {
	const options = ghApiOptions(words, from);
	if (options.reason) return options.reason;
	const endpoint = words[options.end];
	if (endpoint && !isOptionSafeOrLiteral(endpoint))
		return broken("the gh api endpoint is computed");
	if (anyFrom(words, options.end + 1, "computed", isComputed))
		return broken("a gh api argument is computed");
	if (ghApiMethod(words, from) === "GET") return null;
	return outward(`gh api ${endpoint?.value ?? ""}`.trimEnd());
}

const isOptionSafeOrLiteral = (word) => !isComputed(word) || isOptionSafe(word);

/** The options before the endpoint: `{ end }` (the endpoint's index), or
    `{ reason }` when an option or its value is computed. */
function ghApiOptions(words, from) {
	return memoWalk(words, "gh-api-options", from, (k) => {
		if (k >= words.length || !words[k].value.startsWith("-"))
			return { done: { end: k } };
		const width = GH_API_OPTIONS_WITH_ARG.has(words[k].value) ? 2 : 1;
		if (words.slice(k, k + width).some(isComputed))
			return { done: { reason: broken("a gh api option is computed") } };
		return { next: k + width };
	});
}

function ghIsRead(top, second) {
	// Own properties only: `gh constructor` is not a read (D3).
	if (!Object.hasOwn(GH_READS, top)) return false;
	const reads = GH_READS[top];
	return reads === "*" || second === undefined || reads.includes(second);
}

/** The gh invocation whose words start at `start` (just after `gh`). */
function ghInvocationReason(words, start) {
	const { first, second, unknown } = ghPositionals(words, start);
	if (unknown !== undefined)
		return broken(
			`${GH_UNKNOWN_OPTION}: ${JSON.stringify(words[unknown].value)}`,
		);
	if (first === undefined) return null;
	const problem = ghWordProblem(words[first]);
	if (problem) return problem;
	const top = words[first].value;
	if (top.toLowerCase() === "api") return ghApiReason(words, first + 1);
	const sub = words[second];
	if (sub !== undefined && ghWordProblem(sub)) return ghWordProblem(sub);
	if (ghIsRead(top.toLowerCase(), sub?.value.toLowerCase())) return null;
	return outward(`gh ${top}${sub ? ` ${sub.value}` : ""}`);
}

/** Would words from `start` form a gh invocation of a write-capable top-level
    command that is outward, or that has an unknown option before its
    subcommand (D3 rev. 2: `sudo $GH pr --title view create …`)? */
function ghWouldWrite(words, start) {
	const { first, unknown } = ghPositionals(words, start);
	if (first === undefined) return false;
	if (!GH_WRITE_CAPABLE.has(words[first].value.toLowerCase())) return false;
	return unknown !== undefined || isOutward(ghInvocationReason(words, start));
}

// ---- GitHub MCP ----------------------------------------------------------------

const MCP_READ_PREFIXES = ["get_", "list_", "search_"];

/** A tool is GitHub MCP when its server segment (between the first and the last
    `__`) contains "github" in any case. Returns the tool's own name, or null. */
function githubMcpTool(toolName) {
	if (!toolName.startsWith("mcp__")) return null;
	const last = toolName.lastIndexOf("__");
	if (last <= 3) return null;
	const server = toolName.slice(5, last);
	return server.toLowerCase().includes("github")
		? toolName.slice(last + 2)
		: null;
}

function classifyMcp(toolName) {
	const tool = githubMcpTool(toolName);
	if (tool === null || MCP_READ_PREFIXES.some((p) => tool.startsWith(p)))
		return null;
	return outward(`GitHub MCP tool ${toolName}`);
}

// ---- analysis --------------------------------------------------------------------
//
// Every analysis returns a reason string or null (no opinion). An outward reason
// outranks a broken one: both ask, the outward one says more.

const OUTWARD_PREFIX = "outward action: ";
const outward = (kind) => (kind ? `${OUTWARD_PREFIX}${kind}` : null);
const broken = (why) => `broken input: ${why}`;
const isOutward = (reason) => reason?.startsWith(OUTWARD_PREFIX) ?? false;

/** Command-word normalisation: drop path qualifiers and `.exe`, ignore case. */
const commandName = (value) =>
	value
		.split(/[\\/]/)
		.pop()
		.toLowerCase()
		.replace(/\.exe$/, "");

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the word a shell runs, or -1. PowerShell only runs a computed
    word through the call operator (`& $x`). */
function commandWordIndex({ words, called }, mode) {
	if (mode === "ps") return called ? 0 : -1;
	return words.findIndex((w) => !ASSIGNMENT.test(w.value));
}

// ---- wrappers (D12) ----------------------------------------------------------------

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);
const INVOKE_EXPRESSION = new Set(["invoke-expression", "iex"]);
// Shell options whose value is the next word, before or after `-c` (D12 rev. 2).
const POSIX_VALUE_OPTIONS = new Set([
	"-o",
	"+o",
	"-O",
	"+O",
	"--rcfile",
	"--init-file",
]);
const POSIX_LONG_FLAGS = new Set([
	"--login",
	"--noprofile",
	"--norc",
	"--posix",
	"--restricted",
	"--verbose",
	"--noediting",
	"--debugger",
	"--dump-strings",
	"--dump-po-strings",
	"--pretty-print",
]);
const PWSH_OPTIONS_WITH_ARG = new Set([
	"executionpolicy",
	"ep",
	"ex",
	"windowstyle",
	"w",
	"workingdirectory",
	"wd",
	"outputformat",
	"of",
	"o",
	"inputformat",
	"if",
	"configurationname",
	"custompipename",
	"settingsfile",
]);

/** A literal inner command is analysed like any other; a computed one asks.
    `fed`: the wrapper's segment is stdin-fed, so the inner command is too. */
function innerReason(words, mode, fed = false) {
	if (words.length === 0) return broken("wrapper has no command string");
	if (words.some((w) => w.dynamic))
		return broken("wrapped command is computed at run time");
	return analyzeCommand(words.map((w) => w.value).join(" "), mode, fed);
}

const STDIN_FED = "shell reads its commands from stdin";

// Word checks return { reason, covered }: `covered` counts the following words an
// inner analysis already inspected, so the segment scan skips them. Without the
// skip, `eval eval ... x` re-analyses every suffix and the hook can time out.
const verdict = (reason, covered = 0) => ({ reason, covered });
const inner = (words, mode, covered, fed) =>
	verdict(innerReason(words, mode, fed), covered);

// ---- which word a segment runs (D12 rev. 1, rev. 2) ---------------------------------

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
	"!",
]);
// Launchers that run their operand, with their option tables (D12 rev. 2).
const LAUNCHERS = {
	sudo: optionSpec({
		flag: "A b E e H i K k l n P S s V v B N --askpass --background --edit --set-home --login --remove-timestamp --reset-timestamp --list --non-interactive --preserve-groups --stdin --shell --version --validate --bell --help --nonewline --no-update",
		value:
			"u g h p C D r t U T R --user --group --host --prompt --close-from --chdir --role --type --other-user --command-timeout --chroot",
		optional: "--preserve-env",
	}),
	doas: optionSpec({ flag: "n s L", value: "u C a" }),
	env: optionSpec({
		flag: "i 0 v --ignore-environment --null --debug --help --version --list-signal-handling",
		value: "u C a --unset --chdir --argv0",
		optional: "--default-signal --ignore-signal --block-signal",
		string: "S --split-string",
	}),
	command: optionSpec({ flag: "p v V" }),
	exec: optionSpec({ flag: "c l", value: "a" }),
	nohup: optionSpec({ flag: "--help --version" }),
	time: optionSpec({
		flag: "p v q a --portability --verbose --quiet --append --help --version",
		value: "f o --format --output",
	}),
	nice: optionSpec({ flag: "--help --version", value: "n --adjustment" }),
	timeout: optionSpec({
		flag: "v --foreground --preserve-status --verbose --help --version",
		value: "s k --signal --kill-after",
	}),
	stdbuf: optionSpec({
		flag: "--help --version",
		value: "i o e --input --output --error",
	}),
	setsid: optionSpec({
		flag: "c f w --ctty --fork --wait --help --version",
	}),
};
// PowerShell `Start-Process` (`start`, `saps`): its `-FilePath` or first
// positional is the command being run.
const PS_LAUNCHERS = new Set(["start-process", "start", "saps"]);
const PS_LAUNCHER_VALUES = [
	"argumentlist",
	"args",
	"workingdirectory",
	"credential",
	"redirectstandardinput",
	"redirectstandardoutput",
	"redirectstandarderror",
	"windowstyle",
	"verb",
	"environment",
];
const LAUNCHER_NUMBER = /^-?\d+(\.\d+)?[smhd]?$/;

/** Past a launcher's options, option values, numbers and assignments: `{ next }`,
    with `unknown` when an option is not in its table. */
function skipLauncherArgs(words, k, spec) {
	for (let step = { next: k }; ; ) {
		if (step.done) return step.done;
		step = launcherStep(words, step.next, spec);
	}
}

/** One launcher word at `k`: `{ next }` to go on, or `{ done }`. */
function launcherStep(words, k, spec) {
	if (k >= words.length) return { done: { next: k } };
	const v = words[k].value;
	if (ASSIGNMENT.test(v) || LAUNCHER_NUMBER.test(v)) return { next: k + 1 };
	if (!isOptionWord(words[k])) return { done: { next: k } };
	const opt = readOption(words, k, spec);
	if (opt.unknown) return { done: { next: k + 1, unknown: k } };
	if (opt.kind === "end") return { done: { next: k + 1 } };
	return { next: k + opt.width };
}

/** Past `Start-Process` parameters: `{ next }` (the command being run). */
function skipPsLauncherArgs(words, k) {
	while (k < words.length && /^-./.test(words[k].value)) {
		const param = words[k].value.slice(1).toLowerCase();
		if (abbreviates(param, "filepath")) return { next: k + 1 };
		const takesValue = PS_LAUNCHER_VALUES.some((n) => abbreviates(param, n));
		k += takesValue ? 2 : 1;
	}
	return { next: k };
}

function launcherSkip(words, k, mode) {
	const name = commandName(words[k]?.value ?? "");
	if (mode === "ps" && PS_LAUNCHERS.has(name))
		return skipPsLauncherArgs(words, k + 1);
	if (Object.hasOwn(LAUNCHERS, name))
		return skipLauncherArgs(words, k + 1, LAUNCHERS[name]);
	return null;
}

/** Where a segment's command word is: `{ index, after }`. `index` is the first
    non-assignment word or a launcher's operand; after an option a launcher does
    not know, any later word counts as run (`after`). Computed once per segment. */
function runPosition(segment, mode) {
	if (segment.run !== undefined) return segment.run;
	const { words } = segment;
	let k = mode === "ps" ? psLeadingEnd(words) : 0;
	let after;
	const launchers = [];
	while (isLeadingWord(words[k])) k++;
	for (let skip = launcherSkip(words, k, mode); skip; ) {
		launchers.push(k);
		after ??= skip.unknown;
		k = skip.next;
		skip = launcherSkip(words, k, mode);
	}
	segment.run = { index: k, after, launchers };
	return segment.run;
}

const isRunWord = (segment, i, mode) => {
	const run = runPosition(segment, mode);
	return i === run.index || (run.after !== undefined && i > run.after);
};

const PS_ASSIGNMENT_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "??="]);

/** PowerShell `$x = …`, `[t]$x = …` and a foreach header's `$f in …` come
    before the command being run (D5 rev. 4): the index after them, else 0. */
function psLeadingEnd(words) {
	const next = words[1]?.value;
	const leads = PS_ASSIGNMENT_OPS.has(next) || next === "in";
	return words[0]?.dynamic && leads ? 2 : 0;
}

/** An assignment or shell keyword before the command word. */
const isLeadingWord = (word) =>
	word !== undefined &&
	(ASSIGNMENT.test(word.value) || SHELL_KEYWORDS.has(word.value));

// Shell reads that never run commands, valid only before a command string or
// operand (`bash -c "git push" --version` still pushes).
const TERMINAL_READS = {
	posix: new Set(["--version", "--help"]),
	pwsh: new Set(["-version", "--version", "-help", "--help", "-?"]),
	powershell: new Set(["-help", "-?", "/?"]),
};
const STDIN_OPERANDS = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

/** A POSIX shell or `source` operand: stdin (`-`, `/dev/stdin`, `<(…)`) asks
    when the shell is run; a file operand is D11 residual risk. */
function posixOperandReason(word, isRun) {
	const readsStdin = STDIN_OPERANDS.has(word.value) || word.processSubstitution;
	return verdict(readsStdin && isRun ? broken(STDIN_FED) : null);
}

// Wrapper checks read the segment's words from `from` (just after the wrapper
// word) in place, without copying them: every shell word in a long segment would
// otherwise copy the rest of it (D13: cost stays linear).

/** A short-option cluster of a POSIX shell (`-x`, `-lc`, `+e`). */
const isShellCluster = (word) =>
	/^[-+][A-Za-z]+$/.test(word.value) && !word.processSubstitution;

/** Where a POSIX shell's options end: `{ terminal }`, `{ unknown }` (an unknown
    long option between `-c` and its string), `{ string }` (index of the `-c`
    string) or `{ operand }`; `stdin` when `-s` was given. */
function readPosixShellOptions(words, from, afterC = false, stdin = false) {
	// The walk's state only turns on, so it is part of the cache key and a
	// change continues as a new walk (D13 rev. 2).
	return memoWalk(words, `posix/${afterC}/${stdin}`, from, (j) =>
		posixShellStep(words, j, afterC, stdin),
	);
}

function posixShellStep(words, j, afterC, stdin) {
	const ended = (at) => ({
		done: afterC ? { string: at } : { operand: at, stdin },
	});
	if (j >= words.length) return ended(j);
	const v = words[j].value;
	if (!afterC && TERMINAL_READS.posix.has(v))
		return { done: { terminal: true } };
	if (POSIX_VALUE_OPTIONS.has(v)) return { next: j + 2 };
	if (v === "--") return ended(j + 1);
	if (isShellCluster(words[j]))
		return posixClusterStep(words, j, afterC, stdin);
	return v.startsWith("--") ? posixLongStep(j, v, afterC) : ended(j);
}

/** A long shell option: an unknown one between `-c` and its string asks. */
function posixLongStep(j, v, afterC) {
	if (afterC && !POSIX_LONG_FLAGS.has(v)) return { done: { unknown: j } };
	return { next: j + 1 };
}

/** `-c` / `-s` inside a short-option cluster turn the walk's state on. */
const clusterTurnsOn = (v, letter) => v[0] === "-" && v.includes(letter);

function posixClusterStep(words, j, afterC, stdin) {
	const v = words[j].value;
	const c = afterC || clusterTurnsOn(v, "c");
	const s = stdin || clusterTurnsOn(v, "s");
	if (c === afterC && s === stdin) return { next: j + 1 };
	return { done: readPosixShellOptions(words, j + 1, c, s) };
}

function posixShellReason(words, from, ctx) {
	const end = readPosixShellOptions(words, from);
	if (end.terminal) return verdict(null);
	if (end.unknown !== undefined)
		return verdict(
			broken(
				`shell option ${JSON.stringify(words[end.unknown].value)} before the -c string`,
			),
		);
	if (end.string !== undefined)
		return inner(
			words.slice(end.string, end.string + 1),
			"bash",
			end.string + 1 - from,
			ctx.fed,
		);
	if (end.stdin) return verdict(ctx.isRun ? broken(STDIN_FED) : null);
	const operand = words[end.operand];
	if (operand) return posixOperandReason(operand, ctx.isRun);
	return verdict(ctx.fed && ctx.isRun ? broken(STDIN_FED) : null);
}

// PowerShell accepts any unambiguous prefix of a parameter name.
const abbreviates = (opt, name) => opt !== "" && name.startsWith(opt);

/** Classifies a pwsh/powershell option word (without its dash). Windows
    `powershell -Version <n>` takes a value and starts a session. */
function powershellOption(opt, name) {
	if (PWSH_OPTIONS_WITH_ARG.has(opt)) return "takes-arg";
	if (name === "powershell" && opt === "version") return "takes-arg";
	if (abbreviates(opt, "command")) return "command";
	if (opt === "ec" || abbreviates(opt, "encodedcommand")) return "encoded";
	if (abbreviates(opt, "file")) return "file";
	return "switch";
}

const PWSH_SCRIPT_FILE = "PowerShell script file cannot be inspected";

// `shell`: { words, from, name, isRun, fed } — the wrapper's words from `from`,
// its normalised name, whether it is the command being run, and stdin.

// A positional argument is a script file for `pwsh` (where it is the command
// being run) and an inline command for Windows `powershell`; a computed one is
// analysed only when `powershell` is run (D12 rev. 2).
function powershellPositional(shell, j) {
	const { words, from, isRun } = shell;
	const covered = words.length - from;
	if (shell.name !== "powershell")
		return verdict(isRun ? broken(PWSH_SCRIPT_FILE) : null, covered);
	const rest = words.slice(j);
	if (!isRun && rest.some(isComputed)) return verdict(null, covered);
	return inner(rest, "ps", covered, shell.fed);
}

function powershellCommand({ words, from, fed }, j) {
	const covered = words.length - from;
	if (words[j + 1]?.value === "-") return verdict(broken(STDIN_FED), covered);
	return inner(words.slice(j + 1), "ps", covered, fed);
}

const PWSH_UNINSPECTABLE = {
	encoded: "PowerShell encoded command cannot be inspected",
	file: PWSH_SCRIPT_FILE,
};
// An option word: dashes or a slash, then letters (or `?`).
const PLAIN_PWSH_OPTION = /^(--|-|\/)[A-Za-z?]+$/;

/** Where pwsh/powershell options end: `{ kind, at }` with kind "terminal",
    "positional", "not-plain", "command", "encoded", "file" or "end". Cached. */
function readPowershellOptions(words, from, name) {
	return memoWalk(words, `pwsh/${name}`, from, (j) => {
		if (j >= words.length) return { done: { kind: "end", at: j } };
		const v = words[j].value;
		if (TERMINAL_READS[name].has(v.toLowerCase()))
			return { done: { kind: "terminal", at: j } };
		if (!/^[-/]/.test(v)) return { done: { kind: "positional", at: j } };
		if (!PLAIN_PWSH_OPTION.test(v))
			return { done: { kind: "not-plain", at: j } };
		const kind = powershellOption(
			v.replace(/^(--|-|\/)/, "").toLowerCase(),
			name,
		);
		if (kind === "takes-arg") return { next: j + 2 };
		if (kind === "switch") return { next: j + 1 };
		return { done: { kind, at: j } };
	});
}

function powershellReason(shell) {
	const { words } = shell;
	const end = readPowershellOptions(words, shell.from, shell.name);
	if (end.kind === "terminal") return verdict(null);
	if (end.kind === "positional") return powershellPositional(shell, end.at);
	if (end.kind === "command") return powershellCommand(shell, end.at);
	if (end.kind === "not-plain")
		return verdict(
			broken(
				`PowerShell option ${JSON.stringify(words[end.at].value)} is not plain`,
			),
		);
	if (Object.hasOwn(PWSH_UNINSPECTABLE, end.kind))
		return verdict(broken(PWSH_UNINSPECTABLE[end.kind]));
	return verdict(shell.fed && shell.isRun ? broken(STDIN_FED) : null);
}

const isCmdRunFlag = (word) => /^\/\/?[ck]$/i.test(word.value);

// cmd's quoting is closest to PowerShell's (backslash is literal); `%VAR%` is computed.
function cmdReason(words, from, ctx) {
	// Index of the first `/c` or `/k` at or after each word, cached per segment.
	const flag = suffixTable(
		words,
		"cmd-flag",
		(ws, k, later) => (isCmdRunFlag(ws[k]) ? k : later),
		-1,
	)[from];
	if (flag === -1)
		return verdict(ctx.fed && ctx.isRun ? broken(STDIN_FED) : null);
	const command = words.slice(flag + 1);
	const covered = words.length - from;
	if (command.some((w) => /%[^%\s]+%/.test(w.value)))
		return verdict(broken("wrapped command is computed at run time"), covered);
	return inner(command, "ps", covered, ctx.fed);
}

const NO_COMMAND_STRING = "wrapper has no command string";

// `eval`, `iex` and `[scriptblock]::Create` with no literal string ask broken,
// piped or not (D12 rev. 2).
function invokeExpressionReason(words, from, piped, ctx) {
	const command = words
		.slice(from)
		.filter((w) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w.value));
	if (command.length === 0)
		return verdict(broken(piped ? STDIN_FED : NO_COMMAND_STRING));
	return inner(command, "ps", words.length - from, ctx.fed);
}

function evalReason(words, from, ctx) {
	if (from >= words.length) return verdict(broken(NO_COMMAND_STRING));
	return inner(words.slice(from), "bash", words.length - from, ctx.fed);
}

/** PowerShell `[scriptblock]::Create(<string>)`: a literal string is analysed, a
    computed one asks broken (D12 rev. 2; decides over the argument-expression
    rule). */
function scriptblockReason(word, fed) {
	const segments = word.expression ?? [];
	const only = segments.length === 1 ? segments[0].words : [];
	if (only.length !== 1)
		return broken("scriptblock is built from a computed string");
	return innerReason(only, "ps", fed);
}

// `[scriptblock]::Create(…)`, also followed by member access (`.Invoke()`).
const isScriptblockCreate = (word, mode) =>
	mode === "ps" && /^\[scriptblock\]::create(\.|$)/i.test(word.value);

// Wrappers that run an option's value as a command string (D12 rev. 2).
// `onPositional` says what a positional word is: "skip" (a user or file),
// "second" (sg: the group, then the string), "lock" (flock: the lock, then the
// command words), "rest" (watch: the command words), "first" (trap: the action)
// or "stop" (env: the command; env's other options are a launcher's, so an
// unknown one is not this rule's). `endCommand`: words after `--` are the
// command (runuser, D12 rev. 4).
const STRING_WRAPPERS = {
	su: {
		onPositional: "skip",
		spec: optionSpec({
			flag: "l m p f P h V --login --preserve-environment --pty --fast --help --version",
			value: "s g G w --shell --group --supp-group --whitelist-environment",
			string: "c --command --session-command",
		}),
	},
	runuser: {
		onPositional: "skip",
		endCommand: true,
		spec: optionSpec({
			flag: "l m p f P h V --login --preserve-environment --pty --fast --help --version",
			value:
				"u s g G w --user --shell --group --supp-group --whitelist-environment",
			string: "c --command --session-command",
		}),
	},
	script: {
		onPositional: "skip",
		spec: optionSpec({
			flag: "a e f q r --append --return --flush --quiet --force --help --version",
			value:
				"E I O B T o m --echo --log-in --log-out --log-io --log-timing --logging-format --output-limit",
			optional: "t --timing",
			string: "c --command",
		}),
	},
	flock: {
		onPositional: "lock",
		spec: optionSpec({
			flag: "s x u n o F --shared --exclusive --unlock --nonblock --nb --close --no-fork --verbose --help --version",
			value: "w E --timeout --wait --conflict-exit-code",
			string: "c --command",
		}),
	},
	sg: { onPositional: "second", spec: optionSpec({ string: "c" }) },
	watch: {
		onPositional: "rest",
		spec: optionSpec({
			flag: "b e g c t x p w r --beep --errexit --chgexit --color --no-color --no-title --exec --precise --no-wrap --no-rerun --help --version",
			value: "n q --interval --equexit",
			optional: "d --differences",
		}),
	},
	trap: { onPositional: "first", spec: optionSpec({ flag: "p l" }) },
	env: { onPositional: "stop", unknownOk: true, spec: LAUNCHERS.env },
};

/** Where a string wrapper's options end: `{ string }` (the command-string word,
    or null when it has none), `{ unknown }`, `{ positional }` (the first
    positional that decides; "skip" wrappers walk past theirs), `{ command }`
    (the first word after an `endCommand` wrapper's `--`) or `{}`. Cached. */
function readWrapperOptions(words, from, name) {
	const wrapper = STRING_WRAPPERS[name];
	return memoWalk(words, `wrapper/${name}`, from, (k) => {
		if (k >= words.length) return { done: {} };
		if (!isOptionWord(words[k]))
			return wrapper.onPositional === "skip"
				? { next: k + 1 }
				: { done: { positional: k } };
		const opt = readOption(words, k, wrapper.spec);
		if (opt.unknown) return { done: { unknown: k } };
		if (opt.kind === "end" && wrapper.endCommand)
			return { done: { command: k + 1 } };
		if (opt.kind === "string") return { done: { string: opt.value ?? null } };
		return { next: k + opt.width };
	});
}

/** trap: a literal `-` or empty action resets the signal; a computed one asks. */
const isTrapReset = (word) => !word.dynamic && /^-?$/.test(word.value);

/** What a deciding positional word of a string wrapper runs. */
function wrapperPositional(words, k, wrapper, fed) {
	if (wrapper.onPositional === "stop") return verdict(null);
	if (wrapper.onPositional === "rest" || wrapper.onPositional === "lock")
		return inner(words.slice(k), "bash", words.length, fed);
	if (wrapper.onPositional === "first" && isTrapReset(words[k]))
		return verdict(null);
	return inner([words[k]], "bash", 0, fed);
}

const isEnvSplitString = ({ value }) => /^(-S|--split-string)/.test(value);

/** An option a wrapper does not know, before its string, asks broken. env's
    other options are a launcher's, so for env it asks only when a `-S` /
    `--split-string` string follows (D12 rev. 3). */
function unknownWrapperOptionReason(words, k, name) {
	const unknown = broken(
		`${name} option ${JSON.stringify(words[k].value)} may take the next word`,
	);
	if (!STRING_WRAPPERS[name].unknownOk) return unknown;
	return anyFrom(words, k + 1, "env-split-string", isEnvSplitString)
		? unknown
		: null;
}

function stringWrapperReason(words, from, name, ctx) {
	const wrapper = STRING_WRAPPERS[name];
	let end = readWrapperOptions(words, from, name);
	// sg: the first positional is the group, the second the command string;
	// flock: the first is the lock, the command words follow.
	const twoPositionals = ["second", "lock"].includes(wrapper.onPositional);
	if (twoPositionals && end.positional !== undefined)
		end = readWrapperOptions(words, end.positional + 1, name);
	if (end.unknown !== undefined)
		return verdict(unknownWrapperOptionReason(words, end.unknown, name));
	if (end.string !== undefined)
		return inner(end.string ? [end.string] : [], "bash", 0, ctx.fed);
	if (end.command < words.length)
		return inner(words.slice(end.command), "bash", words.length, ctx.fed);
	if (end.positional === undefined) return verdict(shellFromStdin(name, ctx));
	return wrapperPositional(words, end.positional, wrapper, ctx.fed);
}

// Wrappers that start a shell when given no command string (D12 rev. 3).
const SHELL_STARTING_WRAPPERS = new Set([
	"su",
	"runuser",
	"sg",
	"script",
	"flock",
]);

/** A run, stdin-fed wrapper with no command string starts a shell reading stdin. */
const shellFromStdin = (name, ctx) =>
	SHELL_STARTING_WRAPPERS.has(name) && ctx.isRun && ctx.fed
		? broken(STDIN_FED)
		: null;

// `sudo -s`/`-i` (`--shell`, `--login`) and `doas -s` start a shell.
const ELEVATED_SHELL_OPTION = {
	sudo: /^(-[A-Za-z]*[si]|--shell|--login)$/,
	doas: /^-[A-Za-z]*s$/,
};

/** A stdin-fed `sudo -s|-i` or `doas -s` in the launcher chain, with no command
    after its options, runs a shell reading stdin (D12 rev. 3). */
function elevatedShellReason({ words, from, name, ctx, segment, mode }) {
	if (!ctx.fed) return null;
	if (!runPosition(segment, mode).launchers.includes(from - 1)) return null;
	const end = readOptions(words, from, LAUNCHERS[name]);
	if (end.unknown !== undefined || words[end.next] !== undefined) return null;
	const options = words.slice(from, end.next);
	const startsShell = options.some((w) =>
		ELEVATED_SHELL_OPTION[name].test(w.value),
	);
	return startsShell ? broken(STDIN_FED) : null;
}

// tmux runs strings from these commands, and stores strings that run later in
// the last three (D12 rev. 2).
const TMUX_STRING_COMMANDS = new Set([
	"new-session",
	"new",
	"new-window",
	"neww",
	"split-window",
	"splitw",
	"send-keys",
	"send",
	"run-shell",
	"run",
	"respawn-pane",
	"respawnp",
	"respawn-window",
	"respawnw",
	"if-shell",
	"if",
	"pipe-pane",
	"pipep",
	"display-popup",
	"popup",
	"bind-key",
	"bind",
	"set-hook",
	"command-prompt",
]);
const TMUX_GLOBAL = optionSpec({
	flag: "2 C D l N u U v V",
	value: "f L S T",
	string: "c",
});
const TMUX_RUNS_STRING = "tmux runs a command string";

/** Does any word from `k` on not start with `-`? Cached per segment. */
const nonOptionFrom = (words, k) =>
	suffixTable(
		words,
		"non-option",
		(ws, j, later) => later || !isOptionWord(ws[j]),
		false,
	)[k] ?? false;

/** tmux asks when, after its global options and across `\;` chains, any word is
    a string-running command followed by a non-option word, or tmux is given
    `-c <string>`. */
function tmuxReason(words, from) {
	const globals = readOptions(words, from, TMUX_GLOBAL);
	if (globals.unknown !== undefined)
		return broken(
			`tmux option ${JSON.stringify(words[globals.unknown].value)} may take the next word`,
		);
	if (globals.string !== undefined) return broken(TMUX_RUNS_STRING);
	const runs = suffixTable(
		words,
		"tmux-runs",
		(ws, k, later) =>
			later ||
			(TMUX_STRING_COMMANDS.has(ws[k].value) && nonOptionFrom(ws, k + 1)),
		false,
	);
	return runs[globals.next] ? broken(TMUX_RUNS_STRING) : null;
}

/** `source`/`.` follow the shell stdin-operand rule (D12 rev. 2). */
function sourceReason(words, from, ctx) {
	const operand = words[from];
	return operand ? posixOperandReason(operand, ctx.isRun) : verdict(null);
}

// Wrapper word -> its check, given `w`: { words, from, name, ctx, segment }.
const WRAPPER_CHECKS = new Map([
	...[...POSIX_SHELLS].map((n) => [
		n,
		(w) => posixShellReason(w.words, w.from, w.ctx),
	]),
	...[...POWERSHELLS].map((n) => [
		n,
		(w) =>
			powershellReason({ words: w.words, from: w.from, name: n, ...w.ctx }),
	]),
	["cmd", (w) => cmdReason(w.words, w.from, w.ctx)],
	["eval", (w) => evalReason(w.words, w.from, w.ctx)],
	...[...INVOKE_EXPRESSION].map((n) => [
		n,
		(w) => invokeExpressionReason(w.words, w.from, w.segment.piped, w.ctx),
	]),
	...Object.keys(STRING_WRAPPERS).map((n) => [
		n,
		(w) => stringWrapperReason(w.words, w.from, n, w.ctx),
	]),
	["tmux", (w) => verdict(tmuxReason(w.words, w.from))],
	["sudo", (w) => verdict(elevatedShellReason(w))],
	["doas", (w) => verdict(elevatedShellReason(w))],
	["source", (w) => sourceReason(w.words, w.from, w.ctx)],
	[".", (w) => sourceReason(w.words, w.from, w.ctx)],
]);

function wrapperReason(segment, i, name, mode) {
	const check = WRAPPER_CHECKS.get(name);
	if (check === undefined) return verdict(null);
	const ctx = { fed: isStdinFed(segment), isRun: isRunWord(segment, i, mode) };
	return check({ words: segment.words, from: i + 1, name, ctx, segment, mode });
}

// ---- run-time arguments, aliases and computed words (D5 rev. 1) ---------------------

const SHELLS = new Set([...POSIX_SHELLS, ...POWERSHELLS, "cmd"]);
const RUN_TARGETS = new Set(["git", "gh", ...SHELLS]);
const RUNNERS = new Set(["xargs", "parallel"]);
// Runner option tables (D5 rev. 2): "value" takes the next word unless joined,
// "optional" takes a value only joined (GNU `-e`, `-i`, `-l`, `--eof`, …).
const RUNNER_SPECS = {
	xargs: optionSpec({
		flag: "0 o p r t x --null --interactive --open-tty --no-run-if-empty --show-limits --verbose --exit --help --version",
		value:
			"a d E I L n P s --arg-file --delimiter --max-args --max-procs --process-slot-var --max-chars",
		optional: "e i l --eof --replace --max-lines",
	}),
	parallel: optionSpec({
		flag: "0 k m q r t u v X x --null --keep-order --dry-run --tag --bar --eta --progress --line-buffer --linebuffer --group --ungroup --pipe --quote --verbose --shuf --will-cite --no-notice --xargs --nonall --onall --files --round-robin --help --version",
		value:
			"a C d E I j L N n P S s --jobs --joblog --arg-file --delimiter --max-args --max-replace-args --max-procs --sshlogin --sshloginfile --colsep --results --timeout --delay --retries --halt --block --env --workdir --tmpdir --tagstring --memfree --load --basefile --return --transfer-file --header",
		optional: "e i l --eof --replace --max-lines",
	}),
};
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ALIAS_DEFINERS = {
	bash: new Set(["alias"]),
	ps: new Set(["set-alias", "new-alias", "sal", "nal"]),
};

/** The command a runner (xargs, parallel, find -exec) starts. git, gh or a shell
    gets its arguments at run time; a computed command is unknown; a multi-word
    command word is a command string (D5 rev. 2). An outward reason found
    elsewhere still outranks these. */
function runCommandReason(word, runner) {
	if (word === undefined) return null;
	if (isComputed(word)) return broken(`${runner} runs a computed command`);
	if (/\s/.test(word.value)) return analyzeCommand(word.value, "bash");
	const name = commandName(word.value);
	if (!RUN_TARGETS.has(name) && !isGitDashName(name)) return null;
	return broken(`${runner} supplies the arguments of ${name} at run time`);
}

// parallel's argument separators: with no command before them, each argument or
// input line is itself run as a command.
const PARALLEL_SOURCES = new Set([":::", "::::", ":::+", "::::+"]);

function runnerReason(words, from, runner) {
	const end = readOptions(words, from, RUNNER_SPECS[runner]);
	if (end.unknown !== undefined)
		return broken(
			`${runner} option ${JSON.stringify(words[end.unknown].value)} may take the next word`,
		);
	const command = words[end.next];
	const noCommand =
		command === undefined || PARALLEL_SOURCES.has(command.value);
	if (runner === "parallel" && noCommand)
		return broken("parallel runs its input as commands");
	return runCommandReason(command, runner);
}

const GIT_OR_GH = new Set(["git", "gh"]);

/** A `git-<name>` program: `<name>` is a plain word, so a file name such as
    `git-context.mjs` is not one (D4 rev. 2, D5 rev. 4). */
const isGitDashName = (name) =>
	name.startsWith("git-") && PLAIN_WORD.test(name.slice("git-".length));

/** Does `text`, parsed as a command, contain a git or gh word? */
function mentionsGitOrGh(text) {
	try {
		return tokenize(text, "bash").some((s) =>
			s.words.some((w) => GIT_OR_GH.has(commandName(w.value))),
		);
	} catch (err) {
		if (err instanceof Unparseable) return true;
		throw err;
	}
}

/** `alias g=git`, `Set-Alias g git`: a git/gh alias hides the command word. Scans
    up to the next alias definition, so each word is checked once. */
function aliasDefinitionReason(words, from, mode) {
	for (let k = from; k < words.length; k++) {
		if (ALIAS_DEFINERS[mode].has(commandName(words[k].value))) break;
		const problem = aliasWordProblem(words[k], mode);
		if (problem) return problem;
	}
	return null;
}

/** The alias value in a definition word: Bash `name=value`, or a PowerShell
    non-option argument; undefined when the word defines no value. */
function aliasValue(v, mode) {
	if (mode === "bash")
		return v.includes("=") ? v.slice(v.indexOf("=") + 1) : undefined;
	return v.startsWith("-") ? undefined : v;
}

function aliasWordProblem(word, mode) {
	// A computed alias value may name git or gh (D5 rev. 3).
	if (isComputed(word)) return broken("a shell alias value is computed");
	const value = aliasValue(word.value, mode);
	if (value !== undefined && mentionsGitOrGh(value))
		return broken("a shell alias names git or gh");
	return null;
}

/** A computed word directly followed by words that would make an outward git
    invocation, or an outward write-capable gh invocation, may itself be git/gh. */
function followReason(words, from, mode) {
	// A speculative read: the words after a computed word are not a git commit
	// the commit gate must count (D14).
	const { commits } = decision;
	const asGit = gitInvocationReason(words, from, mode);
	decision.commits = commits;
	if (isOutward(asGit) || ghWouldWrite(words, from))
		return broken("a computed word is followed by an outward git or gh action");
	return null;
}

/** A `[scriptblock]::Create(…)` or computed word's reason, or undefined. A
    computed word's name is not known, even when its decoded part reads as `git`
    (`$'\u'git push`, D5 rev. 2). */
function specialWordReason(segment, i, mode) {
	const word = segment.words[i];
	if (isScriptblockCreate(word, mode))
		return scriptblockReason(word, isStdinFed(segment));
	if (isComputed(word)) return followReason(segment.words, i + 1, mode);
	return undefined;
}

/** The check for a git, gh, runner or alias-defining word, or undefined. */
function commandCheck(name, mode) {
	if (name === "git")
		return (words, i) => gitInvocationReason(words, i + 1, mode);
	if (isGitDashName(name))
		return (words, i) => gitDashReason(name, words, i + 1);
	if (name === "gh") return (words, i) => ghInvocationReason(words, i + 1);
	if (RUNNERS.has(name)) return (words, i) => runnerReason(words, i + 1, name);
	if (ALIAS_DEFINERS[mode].has(name))
		return (words, i) => aliasDefinitionReason(words, i + 1, mode);
	return undefined;
}

function wordReason(segment, i, mode, seen) {
	const { words } = segment;
	const special = specialWordReason(segment, i, mode);
	if (special !== undefined) return verdict(special);
	const name = commandName(words[i].value);
	const check = commandCheck(name, mode);
	if (check) return verdict(check(words, i));
	if (name === "find") seen.find = true;
	if (seen.find && FIND_ACTIONS.has(words[i].value))
		return verdict(runCommandReason(words[i + 1], "find"));
	return wrapperReason(segment, i, name, mode);
}

/** PowerShell `Start-Process` running git or gh reads its arguments from
    `-ArgumentList`; anywhere but straight after the command word, the hook cannot
    pair them with it, so it asks broken (D5 rev. 3). */
function psLaunchedGitReason(segment, mode) {
	if (mode !== "ps") return null;
	const { words } = segment;
	if (!PS_LAUNCHERS.has(commandName(words[0]?.value ?? ""))) return null;
	const run = runPosition(segment, mode).index;
	const name = commandName(words[run]?.value ?? "");
	if (!isGitOrGhName(name)) return null;
	const argList = words.findIndex((w) => PS_ARGUMENT_LIST.test(w.value));
	if (argList === -1 || argList === run + 1) return null;
	return broken(`Start-Process passes -ArgumentList apart from ${name}`);
}

/** Position-independent: any `git`/`gh`/wrapper word in a segment is checked (D5). */
function segmentReason(segment, mode) {
	if (segment.broken) return segment.broken;
	const seen = { find: false };
	// Word spans a wrapper analysed as its command: the safety net already ran
	// on them inside (D5 rev. 4).
	const analysed = [];
	let firstBroken = psLaunchedGitReason(segment, mode);
	for (let i = 0; i < segment.words.length; i++) {
		const { reason, covered } = wordReason(segment, i, mode, seen);
		if (isOutward(reason)) return reason;
		firstBroken ??= reason;
		if (covered > 0) analysed.push([i + 1, i + covered]);
		i += covered;
	}
	const cmd = computedCommandWord(segment, mode);
	if (cmd)
		firstBroken ??= broken(
			`command word ${JSON.stringify(cmd.value)} is computed at run time`,
		);
	return firstBroken ?? unplacedGitWordReason(segment, mode, analysed);
}

/** The computed word a segment runs, if any: its command word, or the D12 run
    position past keywords and launchers (D5 rev. 4). PowerShell runs a computed
    word there only through a launcher. */
function computedCommandWord(segment, mode) {
	const { words } = segment;
	const cmd = words[commandWordIndex(segment, mode)];
	if (cmd?.dynamic) return cmd;
	const run = runPosition(segment, mode);
	if (mode === "ps" && run.launchers.length === 0) return undefined;
	const word = words[run.index];
	return word?.dynamic ? word : undefined;
}

// Commands that never execute their arguments: a git or gh word is safe as
// their operand (D5 rev. 3 safety net).
const SAFE_OPERAND_COMMANDS = new Set([
	"which",
	"type",
	"where",
	"whereis",
	"whatis",
	"apropos",
	"man",
	"help",
	"info",
	"command",
	"get-command",
	"gcm",
	"get-help",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"ag",
	"ack",
	"findstr",
	"select-string",
	"sls",
	"echo",
	"printf",
	"write-host",
	"write-output",
	"ls",
	"dir",
	"cat",
	"cd",
	"head",
	"tail",
	"less",
	"more",
	"wc",
]);

const isGitOrGhName = (name) => GIT_OR_GH.has(name) || isGitDashName(name);

/** Safety net (D5 rev. 3, rev. 4): in a segment the hook otherwise gives no
    opinion on, a git or gh word must be the command being run (exactly the run
    position), an argument after a git/gh command being run, an operand of a
    command that never runs its arguments, or inside a span a wrapper already
    analysed as a command. Anywhere else, what runs it is unknown: broken. */
function unplacedGitWordReason(segment, mode, analysed) {
	const { words } = segment;
	const run = runPosition(segment, mode);
	if (SAFE_OPERAND_COMMANDS.has(commandName(words[run.index]?.value ?? "")))
		return null;
	const inside = analysedWords(words.length, analysed);
	const i = words.findIndex((w, k) => !inside[k] && isLiteralGitOrGh(w));
	// At the run position, every later word is this git/gh command's argument.
	if (i === -1 || i === run.index) return null;
	return broken(
		`${JSON.stringify(words[i].value)} sits where the hook cannot tell what runs it`,
	);
}

const isLiteralGitOrGh = (word) =>
	isGitOrGhName(commandName(word.value)) && !isComputed(word);

/** Marks the words inside the analysed spans. The spans are disjoint (the
    segment scan skips covered words), so marking stays linear. */
function analysedWords(length, analysed) {
	const inside = new Uint8Array(length);
	for (const [from, to] of analysed)
		inside.fill(1, from, Math.min(to + 1, length));
	return inside;
}

// Wrapper and alias re-parsing depth; bounds work on inputs like `eval eval ... x`.
let analysisDepth = 0;

/** `fed`: the command runs inside a stdin-fed wrapper, so every segment of it
    is stdin-fed too (D12 rev. 2). */
function analyzeCommand(command, mode, fed = false) {
	if (analysisDepth >= MAX_NESTING) return broken("wrappers nested too deeply");
	analysisDepth++;
	try {
		const segments = tokenize(command, mode);
		if (fed) for (const segment of segments) segment.inheritedFed = true;
		return analyzeSegments(segments, mode);
	} catch (err) {
		if (err instanceof Unparseable) return broken(err.message);
		throw err;
	} finally {
		analysisDepth--;
	}
}

function analyzeSegments(segments, mode) {
	let firstBroken = null;
	for (const segment of segments) {
		const reason = segmentReason(segment, mode);
		if (isOutward(reason)) return reason;
		firstBroken ??= reason;
	}
	return firstBroken ?? runtimeConfigReason(segments, mode);
}

// Env-supplied git configuration (it can define aliases or includes); other
// GIT_CONFIG_* such as GIT_CONFIG_NOSYSTEM do not count.
const CONFIG_VARIABLE =
	"GIT_CONFIG_(COUNT|KEY_\\d+|VALUE_\\d+|PARAMETERS|GLOBAL|SYSTEM)";
const CONFIG_ASSIGNMENT = new RegExp(`^${CONFIG_VARIABLE}=`);
const CONFIG_ENV_VARIABLE = new RegExp(`^env:${CONFIG_VARIABLE}$`, "i");
const CONFIG_NAME = new RegExp(`^${CONFIG_VARIABLE}$`, "i");
// `git config` keys that define aliases or include other configuration; git
// matches section names case-insensitively (D5 rev. 2).
const CONFIG_KEY = /^(alias\.|include\.path|includeif\.)/i;

/** PowerShell `[Environment]::SetEnvironmentVariable('GIT_CONFIG_…', …)`. */
function setsEnvironmentVariable(word, names = CONFIG_NAME) {
	if (!/::setenvironmentvariable$/i.test(word.value)) return false;
	const first = word.expression?.[0]?.words[0]?.value ?? "";
	return names.test(first.split(",")[0]);
}

// Bash assignments and `export`; PowerShell `$env:`/`${env:}`, `Set-Item` or
// `New-Item` on `env:…`, and `SetEnvironmentVariable`.
const setsGitConfig = (word) =>
	CONFIG_ASSIGNMENT.test(word.value) ||
	CONFIG_ENV_VARIABLE.test(word.value) ||
	(word.vars ?? []).some((v) => CONFIG_ENV_VARIABLE.test(v)) ||
	setsEnvironmentVariable(word);

/** Does the git word at `i` run `git config` naming an alias/include key? */
function writesGitConfigKey(words, i, mode) {
	const read = readGitOptions(words, i + 1, mode);
	if (read.reason || words[read.sub]?.value.toLowerCase() !== "config")
		return false;
	return anyFrom(words, read.sub + 1, "config-key", (w) =>
		CONFIG_KEY.test(w.value),
	);
}

/** Git configuration supplied at run time anywhere in a command that also
    contains a git word; a `git config` alias/include write needs another git
    word to act on. */
function runtimeConfigReason(segments, mode) {
	// Counted per decision: a wrapper string's git word and the configuration
	// set around the wrapper belong to one command (D5 rev. 3).
	for (const { words } of segments)
		words.forEach((word, i) => {
			decision.configSet ||= setsGitConfig(word);
			if (commandName(word.value) !== "git") return;
			decision.gitWords++;
			decision.configWrite ||= writesGitConfigKey(words, i, mode);
		});
	const { configSet, configWrite, gitWords } = decision;
	const supplied = (configSet && gitWords > 0) || (configWrite && gitWords > 1);
	return supplied ? broken(RUNTIME_CONFIG) : null;
}

const SHELL_MODES = { Bash: "bash", PowerShell: "ps" };
const MAX_COMMAND_LENGTH = 64 * 1024;

const isPlainObject = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v);

function decide(input) {
	if (!isPlainObject(input)) return broken("hook event is not a JSON object");
	const toolName = input.tool_name;
	if (typeof toolName !== "string") return broken("tool_name is missing");
	if (toolName.startsWith("mcp__")) return classifyMcp(toolName);
	// Own properties only: an inherited `constructor` is not a shell (D3).
	if (!Object.hasOwn(SHELL_MODES, toolName)) return null;
	const mode = SHELL_MODES[toolName];
	const command = input.tool_input?.command;
	return (
		shellCommandReason(command, mode) ??
		commitGateReason(command, mode, input.cwd)
	);
}

/** State shared by every analysis of one hook decision, including literal
    wrapper strings analysed in nested calls (D5 rev. 3). */
const newDecision = () => ({
	commits: 0,
	aliasExpansions: 0,
	gitWords: 0,
	configSet: false,
	configWrite: false,
});
let decision = newDecision();

function shellCommandReason(command, mode) {
	if (typeof command !== "string")
		return broken("tool_input.command is missing");
	if (command.length > MAX_COMMAND_LENGTH)
		return broken(`command longer than ${MAX_COMMAND_LENGTH} characters`);
	decision = newDecision();
	return analyzeCommand(command, mode) ?? markerReason(command, mode);
}

// ---- approved branches (D14, S2) -----------------------------------------------------

const MARKER_KEY = /rpivapproved/i;

/** Only the developer may approve or unapprove a branch: any command naming the
    marker key asks — in its text or in a word as the shell decodes it
    (`rpiv''Approved`) — and a computed `git config` argument, which may
    assemble the key at run time, asks broken (D14 S2 rev. 1). */
function markerReason(command, mode) {
	const segments = tokenize(command, mode);
	const named =
		MARKER_KEY.test(command) ||
		segments.some(({ words }) => words.some((w) => MARKER_KEY.test(w.value)));
	if (named) return "approval marker: the command names the rpivApproved key";
	return segments.some(({ words }) => computedConfigArgument(words, mode))
		? broken("a git config argument is computed")
		: null;
}

/** Does a `git config` invocation in `words` have a computed argument? */
function computedConfigArgument(words, mode) {
	return words.some((_, i) => {
		const from = configArgumentsFrom(words, i, mode);
		return (
			from !== null && anyFrom(words, from, "computed-config-arg", isComputed)
		);
	});
}

/** Where the arguments of a `git config` at `i` start — directly, through an
    inline alias (the alias's own arguments), or as a `git-config` program word
    (D14 S2 rev. 2) — or null when `i` is not one. */
function configArgumentsFrom(words, i, mode) {
	const name = commandName(words[i].value);
	if (name === "git-config") return i + 1;
	if (name !== "git" || resolvedGitSub(words, i, mode) !== "config")
		return null;
	const read = readGitOptions(words, i + 1, mode);
	return read.reason ? null : read.sub + 1;
}

const commitGate = (detail) => `commit off an approved branch: ${detail}`;

/** A command that commits asks unless HEAD is on an approved branch where each
    commit runs. A commit the analysis met but the walk cannot place (inside a
    quoted wrapper string) asks. */
function commitGateReason(command, mode, cwd) {
	if (decision.commits === 0) return null;
	// The commit's directory starts at the event's cwd; without one it is unknown.
	if (typeof cwd !== "string") return broken("the event has no cwd");
	const segments = tokenize(command, mode);
	const stateProblem = shellStateProblem(segments, mode);
	if (stateProblem) return broken(stateProblem);
	const commits = [];
	forEachGitInvocation(segments, mode, cwd, (git) => {
		if (git.sub === "commit") commits.push(git);
	});
	return placementReason(commits) ?? approvedDirsReason(commits);
}

/** A commit the hook cannot place, or whose HEAD may move first, asks. */
function placementReason(commits) {
	if (commits.length < decision.commits)
		return commitGate("a commit runs inside a string the hook cannot place");
	for (const { place, headMoved } of commits) {
		if (place.problem) return broken(place.problem);
		if (headMoved)
			return commitGate(
				"git switch, checkout, symbolic-ref or bisect runs before the commit",
			);
	}
	return null;
}

/** Each directory is read once, and only a few: every read runs git, and the
    decision must stay inside the hook timeout (D13). */
function approvedDirsReason(commits) {
	const dirs = new Set(commits.map(({ place }) => place.dir));
	if (dirs.size > MAX_COMMIT_DIRS)
		return broken(`commits run in more than ${MAX_COMMIT_DIRS} directories`);
	limitGitTime(GIT_BUDGET_MS);
	for (const dir of dirs) {
		const reason = branchGateReason(dir);
		if (reason) return reason;
	}
	return null;
}

const MAX_COMMIT_DIRS = 8;
// All git queries of one decision; past it a branch reads as unreadable.
const GIT_BUDGET_MS = 5_000;

// Commands that change the shell's directory (D14); `popd` leaves it unknown.
const DIR_CHANGERS = {
	bash: new Set(["cd", "pushd"]),
	ps: new Set(["cd", "pushd", "chdir", "sl", "set-location", "push-location"]),
};
const DIR_RESTORERS = new Set(["popd", "pop-location"]);
const GIT_LOCATION_ENV = /^(\$?env:)?GIT_(DIR|WORK_TREE)(=|$)/i;

// Subcommands after which HEAD may point elsewhere (D14, S2 rev. 1).
const HEAD_MOVERS = new Set(["switch", "checkout", "symbolic-ref", "bisect"]);

/** Calls `visit({ sub, args, place, headMoved })` for every git and
    `git-<name>` word of `segments` in order, with the directory it runs in
    (`place.dir`, or `place.problem`) and whether an earlier invocation may
    have moved HEAD. */
function forEachGitInvocation(segments, mode, cwd, visit) {
	let place = { dir: cwd };
	let headMoved = false;
	for (const segment of segments) {
		place = placeAfter(segment, mode, place);
		const { words } = segment;
		// Each git word re-reads its own `-C` options; past a bound the place is
		// not computed, so the walk stays linear (D13).
		const crowded = countGitWords(words) > MAX_GIT_WORDS;
		for (let i = 0; i < words.length; i++) {
			const git = gitInvocationAt(words, i, mode, crowded ? CROWDED : place);
			if (git === null) continue;
			visit({ ...git, headMoved });
			if (HEAD_MOVERS.has(git.sub)) headMoved = true;
		}
	}
}

const MAX_GIT_WORDS = 64;
const CROWDED = {
	problem: `more than ${MAX_GIT_WORDS} git invocations in one command`,
};

const countGitWords = (words) =>
	words.reduce((n, w) => (commandName(w.value) === "git" ? n + 1 : n), 0);

/** `{ sub, args, place }` of the git or `git-<name>` word at `i`, or null. */
function gitInvocationAt(words, i, mode, place) {
	const name = commandName(words[i].value);
	if (isGitDashName(name))
		return {
			sub: name.slice("git-".length),
			args: { words, from: i + 1 },
			place,
		};
	if (name !== "git") return null;
	return {
		sub: resolvedGitSub(words, i, mode),
		args: gitArguments(words, i, mode),
		place: place.problem ? place : gitPlace(words, i, mode, place),
	};
}

/** The directory after `segment` runs: a literal `cd` moves it; anything the
    hook cannot follow turns it into a problem. */
function placeAfter(segment, mode, place) {
	const { words } = segment;
	if (words.some(setsGitLocation))
		return { problem: "GIT_DIR or GIT_WORK_TREE is set for the commit" };
	const run = runPosition(segment, mode).index;
	const name = commandName(words[run]?.value ?? "");
	if (DIR_RESTORERS.has(name))
		return { problem: `${name} leaves the directory unknown` };
	if (!DIR_CHANGERS[mode].has(name) || place.problem) return place;
	if (!isPlainCommand(segment, mode))
		return { problem: `${name} runs where it cannot move the shell` };
	return changedPlace(segment, run, name, place);
}

/** A top-level command the shell runs itself (D14 S2 rev. 1): no launcher, not
    in a group, a pipeline, a background job or a substitution. */
function isPlainCommand(segment, mode) {
	const plainEnding = segment.ending === "list" || segment.ending === undefined;
	return (
		runPosition(segment, mode).launchers.length === 0 &&
		!segment.group &&
		!segment.piped &&
		plainEnding &&
		(segment.depth ?? 1) === 1
	);
}

// Words that can change the shell's directory or state when they run: only a
// plain directory change is followed; with a gated commit, these ask broken.
const SHELL_STATE_WORDS = new Set([
	"eval",
	"source",
	".",
	"builtin",
	"function",
	"alias",
	"exec",
	"invoke-expression",
	"iex",
]);

/** A directory-changing word the walk does not follow, or a shell-state word
    run as a command, anywhere in the command (D14 S2 rev. 1). */
function shellStateProblem(segments, mode) {
	for (const segment of segments) {
		const problem = segmentStateProblem(segment, mode);
		if (problem) return problem;
	}
	return null;
}

function segmentStateProblem(segment, mode) {
	const run = runPosition(segment, mode).index;
	for (const [i, word] of segment.words.entries()) {
		// Off the run position only the whole word counts: `ci/cd` is a path,
		// not `cd` (D14 S2 rev. 2).
		const name = i === run ? commandName(word.value) : word.value.toLowerCase();
		if (/^CDPATH=/.test(word.value)) return "CDPATH is set";
		const followed = i === run && isPlainCommand(segment, mode);
		if (isDirectoryWord(name, mode) && !followed)
			return `${name} is not a plain directory change`;
		if (i === run && SHELL_STATE_WORDS.has(name))
			return `${name} may change the shell's directory or state`;
	}
	return null;
}

const isDirectoryWord = (name, mode) =>
	DIR_CHANGERS[mode].has(name) || DIR_RESTORERS.has(name);

/** Where a literal `cd`-like command at `run` moves the directory. */
function changedPlace(segment, run, name, place) {
	// The path is the only non-option word (`Set-Location -Path <dir>`); with
	// more than one, the shell refuses the change (D14 S2 rev. 2).
	const operands = segment.words.slice(run + 1).filter((w) => !isOptionWord(w));
	if (operands.length > 1)
		return { problem: `${name} with more than one operand does not run` };
	const [target] = operands;
	if (target === undefined)
		return { problem: `${name} without a path leaves the directory unknown` };
	if (isComputed(target)) return { problem: "the directory is computed" };
	if (segment.group || segment.piped)
		return { problem: `${name} inside a group or pipeline` };
	return { dir: resolveDir(place.dir, target.value) };
}

// PowerShell `[Environment]::SetEnvironmentVariable('GIT_DIR', …)`.
const LOCATION_NAME = /^GIT_(DIR|WORK_TREE)$/i;

const setsGitLocation = (word) =>
	GIT_LOCATION_ENV.test(word.value) ||
	(word.vars ?? []).some((v) => GIT_LOCATION_ENV.test(v)) ||
	setsEnvironmentVariable(word, LOCATION_NAME);

/** `~`, Git Bash drive paths (`/c/Users/…`) and relative paths, from `base`. */
function resolveDir(base, path) {
	let target = path.replace(/^~(?=\/|\\|$)/, homedir());
	if (process.platform === "win32")
		target = target.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
	return resolve(base, target);
}

/** Where the git invocation at `i` runs: `-C` moves it; `--git-dir` and
    `--work-tree` make it unknown. */
function gitPlace(words, i, mode, place) {
	const { sub } = readGitOptions(words, i + 1, mode);
	let at = place;
	for (let k = i + 1; k < (sub ?? words.length); k++) {
		const [name] = words[k].value.split("=", 1);
		if (name === "--git-dir" || name === "--work-tree")
			return { problem: `git ${name} sets where the commit runs` };
		if (name !== "-C" || words[k + 1] === undefined) continue;
		at = gitDirectoryOption(at, words[k + 1]);
		k++;
	}
	return at;
}

function gitDirectoryOption(place, word) {
	if (isComputed(word)) return { problem: "git -C names a computed directory" };
	return place.problem ? place : { dir: resolveDir(place.dir, word.value) };
}

/** The subcommand the git word at `i` runs, through inline aliases; null for a
    `!` alias or when it cannot be read. */
function resolvedGitSub(words, i, mode) {
	const read = readGitOptions(words, i + 1, mode);
	let sub = read.reason ? undefined : words[read.sub]?.value.toLowerCase();
	for (let n = 0; sub !== undefined && read.aliases.has(sub); n++) {
		const value = read.aliases.get(sub);
		if (n >= MAX_NESTING || value.startsWith("!")) return null;
		sub = tokenize(value, "bash")[0]?.words[0]?.value.toLowerCase();
	}
	return sub ?? null;
}

/** `{ words, from, aliased }`: where the arguments of the git subcommand at `i`
    start, without copying (D13); `from` is past the end when there are none or
    an inline alias renames the subcommand (`aliased`: its own arguments are
    not these). */
function gitArguments(words, i, mode) {
	const read = readGitOptions(words, i + 1, mode);
	const subWord = read.reason ? undefined : words[read.sub];
	const alias = subWord && read.aliases.get(subWord.value.toLowerCase());
	const aliased = alias !== undefined;
	const none = subWord === undefined || aliased;
	return {
		words,
		from: none ? words.length : read.sub + 1,
		aliased,
		aliasValue: alias,
	};
}

/** The commit gate for a commit running in `dir`. */
function branchGateReason(dir) {
	const head = headState(dir);
	// Fail closed (D13): an unreadable branch is never an approved one.
	if (head.problem)
		return broken(`cannot read the branch of the commit: ${head.problem}`);
	if (head.branch === null) return commitGate("HEAD is detached");
	if (!head.born)
		return commitGate(`branch "${head.branch}" has no commit yet`);
	const marker = approval(dir, head.branch);
	if (marker.problem)
		return broken(`cannot read the branch of the commit: ${marker.problem}`);
	return marker.approved
		? null
		: commitGate(`branch "${head.branch}" is not approved`);
}

// Git time for the before-note, kept apart from the commit gate's budget (D13).
const NOTE_BUDGET_MS = 2_000;

/** For the approval recorder: the branch names that exist, before the command
    runs, where it creates branches by literal names — keyed by the tool call
    (D14 S2 rev. 1). */
function noteBranchesBefore(input) {
	const shell = noteableShellCommand(input);
	if (shell === null) return;
	const { command, mode, cwd } = shell;
	const dirs = creationDirs(tokenize(command, mode), mode, cwd);
	if (dirs.size === 0 || dirs.size > MAX_COMMIT_DIRS) return;
	limitGitTime(NOTE_BUDGET_MS);
	const note = {};
	for (const dir of dirs) note[dir] = branchNames(dir).names ?? null;
	writeBeforeNote(input.tool_use_id, note);
}

/** `{ command, mode, cwd }` of a Bash/PowerShell event worth a note, or null. */
function noteableShellCommand(input) {
	const tool = input?.tool_name ?? "";
	if (!Object.hasOwn(SHELL_MODES, tool)) return null;
	const command = input.tool_input?.command;
	if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH)
		return null;
	if (typeof input.cwd !== "string") return null;
	return { command, mode: SHELL_MODES[tool], cwd: input.cwd };
}

/** The directories where `segments` create branches by literal names. */
function creationDirs(segments, mode, cwd) {
	const dirs = new Set();
	forEachGitInvocation(segments, mode, cwd, (git) => {
		if (createsLiteralBranch(git) && git.place.dir) dirs.add(git.place.dir);
	});
	return dirs;
}

/** Does the git invocation create a branch whose name is literal? */
function createsLiteralBranch(git) {
	const word = createdNameWord(git.sub, git.args);
	return word !== undefined && !isComputed(word);
}

/** Fail closed (D13): an exception must never become an unprompted run. */
function safeDecide(input) {
	try {
		return input === undefined
			? broken("hook event is not valid JSON")
			: decide(input);
	} catch (err) {
		return broken(`internal error: ${err?.message ?? err}`);
	}
}

function readEvent() {
	try {
		return JSON.parse(readFileSync(0, "utf-8"));
	} catch {
		return undefined;
	}
}

function main() {
	const input = readEvent();
	const reason = safeDecide(input);
	// The decision is written first, so the note's git work can never delay it
	// (D14 S2 rev. 2).
	if (reason)
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "ask",
					permissionDecisionReason: `[rpiv-hook] ${reason}`,
				},
			}),
		);
	try {
		noteBranchesBefore(input);
	} catch {
		// The note only serves the recorder, which reports a missing note.
	}
}

/** Run as the hook, not when the approval recorder imports this file (D14). */
function isEntryPoint() {
	try {
		// No script path (`node -e …`): cannot tell, so decide (D14 S2 rev. 2).
		if (!process.argv[1]) return true;
		const self = realpathSync(fileURLToPath(import.meta.url));
		return realpathSync(process.argv[1]) === self;
	} catch {
		// Cannot tell: decide anyway, so the hook never goes silent (D13).
		return true;
	}
}

// Returns normally: no `process.exit`, so a pending stdout write is never dropped
// (D13). Nothing else keeps the event loop alive, so the process exits with 0.
if (isEntryPoint()) main();

export { forEachGitInvocation, isComputed, tokenize };
