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

import { readFileSync } from "node:fs";

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
	const p = { src, i: 0, mode, segments: [], heredocs: [], depth: 0 };
	parseList(p, null);
	return p.segments;
}

function parseList(p, terminator) {
	if (++p.depth > MAX_NESTING)
		throw new Unparseable("substitutions nested too deeply");
	const seg = newSegmentBuilder(p);
	// Unquoted `(` opened in this list; a `)` closing one of them is grouping,
	// not the end of a `$(...)` substitution.
	let parens = 0;
	while (p.i < p.src.length) {
		const ch = p.src[p.i];
		if (ch === terminator && parens === 0) {
			p.i++;
			seg.endSegment();
			p.depth--;
			return;
		}
		parens += parenDelta(ch, parens);
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
// be told apart from quoted text.
function newSegmentBuilder(p) {
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
			if (word !== null && !targetPending) words.push(word);
			if (word !== null) targetPending = false;
			word = null;
		},
		endSegment({ nextPiped = false, nextCalled = false } = {}) {
			this.endWord();
			if (words.length > 0)
				p.segments.push({
					words,
					piped,
					called,
					stdinRedirect,
					groups: [...groups],
				});
			words = [];
			piped = nextPiped;
			called = nextCalled;
			stdinRedirect = false;
			targetPending = false;
			closedGroup = null;
		},
		openGroup() {
			const fed = piped && empty();
			this.endSegment();
			groups.push({ fed });
		},
		closeGroup() {
			this.endSegment();
			closedGroup = groups.pop() ?? null;
		},
	};
}

/** Is the segment's stdin a pipe, a `<`/`<<`/`<<<` redirection or a fed group? */
const isStdinFed = (segment) =>
	segment.piped ||
	segment.stdinRedirect ||
	(segment.groups ?? []).some((g) => g.fed);

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

/** Bash `<(…)` / `>(…)`: parsed like `$(…)`, standing as one computed word. */
function readProcessSubstitution(p, seg) {
	seg.endWord();
	p.i += 2;
	seg.markProcessSubstitution();
	parseList(p, ")");
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
		seg.endSegment({ nextPiped: next !== "|" });
		p.i += next === "|" ? 2 : 1;
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
	if (ch === "(" || ch === "{") seg.openGroup();
	else seg.closeGroup();
	p.i++;
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
	seg.endSegment({ nextCalled: p.mode === "ps" && next !== "&" });
	p.i += next === "&" ? 2 : 1;
}

const VARIABLE_START = { bash: /[A-Za-z0-9_@*#?$!{-]/, ps: /[A-Za-z_{?:^$]/ };

/** `$` at p.i: a substitution or variable marks the word dynamic. Returns false
    for a literal `$`. */
function readExpansion(p, seg, next, inDouble = false) {
	if (next === "(") {
		p.i += 2;
		seg.markDynamic();
		parseList(p, ")");
		return true;
	}
	if (next === undefined || !VARIABLE_START[p.mode].test(next)) return false;
	seg.markDynamic();
	if (next === "{") {
		p.i += 2;
		if (p.mode === "bash") skipParameterBody(p, inDouble);
		else skipPast(p, "}", "unterminated ${...}");
		return true;
	}
	const nameStart = p.i + 1;
	p.i += 2;
	while (p.i < p.src.length && /[A-Za-z0-9_:]/.test(p.src[p.i])) p.i++;
	seg.noteVariable(p.src.slice(nameStart, p.i));
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
	const q = { ...p, src: body, i: 0, heredocs: [] };
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
const BRANCH_QUERY = [
	"--list",
	"--all",
	"--remotes",
	"--verbose",
	"--show-current",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--format",
	"--sort",
	"--column",
	"--no-column",
	"--delete",
	"--set-upstream-to",
	"--unset-upstream",
	"--edit-description",
];

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
		clusterHas(value, "dDalrvu") || hasLongOption(value, BRANCH_QUERY);
	if (anyBeforeDashDash(words, from, "branch-query", queries)) return false;
	return anyFrom(
		words,
		from,
		"non-option",
		({ value }) => !value.startsWith("-"),
	);
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

/** `-c <name>=<value>`: returns the option's width, or a broken reason. */
function readGitConfigOption(valueWord, aliases) {
	if (valueWord === undefined) return 1;
	if (isComputed(valueWord)) return broken("git -c setting is computed");
	const [, rawKey, value] = /^([^=]*)=?(.*)$/s.exec(valueWord.value);
	const key = rawKey.toLowerCase();
	if (key === "include.path" || key.startsWith("includeif."))
		return broken(RUNTIME_CONFIG);
	if (key.startsWith("alias.")) aliases.set(key.slice("alias.".length), value);
	return 2;
}

/** Width (1 or 2 words) of the git option at `j`, or a broken reason. */
function gitOptionWidth(words, j, aliases) {
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
	if (name === "-c") return readGitConfigOption(words[j + 1], aliases);
	return GIT_PATH_OPTIONS.has(name) && !joined ? 2 : 1;
}

/** Skips git's own options from `start`: `{ sub, aliases }` with the index of the
    subcommand, or `{ reason }` when a deciding word fails closed. */
function readGitOptions(words, start, mode) {
	const aliases = new Map();
	let j = start;
	while (j < words.length && /^-./.test(words[j].value)) {
		if (mode === "ps" && PS_ARGUMENT_LIST.test(words[j].value)) {
			j++;
			continue;
		}
		const width = gitOptionWidth(words, j, aliases);
		if (typeof width === "string") return { reason: width };
		j += width;
	}
	return { sub: j, aliases };
}

/** The git invocation whose words start at `start` (just after `git`). */
function gitInvocationReason(words, start, mode) {
	const read = readGitOptions(words, start, mode);
	if (read.reason) return read.reason;
	const subWord = words[read.sub];
	if (subWord === undefined) return null;
	if (isComputed(subWord)) return broken("the git subcommand is computed");
	if (!PLAIN_WORD.test(subWord.value))
		return broken(
			`git subcommand ${JSON.stringify(subWord.value)} is not a plain word`,
		);
	const sub = subWord.value.toLowerCase();
	const alias = read.aliases.get(sub);
	if (alias === undefined) return gitSubcommandReason(sub, words, read.sub + 1);
	if (alias.startsWith("!")) return analyzeCommand(alias.slice(1), "bash");
	const expanded = tokenize(alias, "bash")[0]?.words ?? [];
	return gitInvocationReason(
		[...expanded, ...words.slice(read.sub + 1)],
		0,
		mode,
	);
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

/** Indexes of the first two positional words from `start`, skipping options and
    `-R <repo>`. */
function ghPositionalIndexes(words, start) {
	const out = [];
	for (let k = start; k < words.length && out.length < 2; k++) {
		if (GH_REPO_FLAGS.has(words[k].value)) k++;
		else if (!words[k].value.startsWith("-") || isComputed(words[k]))
			out.push(k);
	}
	return out;
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
	let k = from;
	while (k < words.length && words[k].value.startsWith("-")) {
		const width = GH_API_OPTIONS_WITH_ARG.has(words[k].value) ? 2 : 1;
		const optionWords = words.slice(k, k + width);
		if (optionWords.some(isComputed))
			return { reason: broken("a gh api option is computed") };
		k += width;
	}
	return { end: k };
}

function ghIsRead(top, second) {
	// Own properties only: `gh constructor` is not a read (D3).
	if (!Object.hasOwn(GH_READS, top)) return false;
	const reads = GH_READS[top];
	return reads === "*" || second === undefined || reads.includes(second);
}

/** The gh invocation whose words start at `start` (just after `gh`). */
function ghInvocationReason(words, start) {
	const [first, second] = ghPositionalIndexes(words, start);
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

/** Would words from `start` form an outward gh invocation of a write-capable
    top-level command? */
function ghWouldWrite(words, start) {
	const [first] = ghPositionalIndexes(words, start);
	if (first === undefined) return false;
	if (!GH_WRITE_CAPABLE.has(words[first].value.toLowerCase())) return false;
	return isOutward(ghInvocationReason(words, start));
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
const POSIX_SHELL_OPTIONS_WITH_ARG = new Set([
	"-o",
	"+o",
	"--rcfile",
	"--init-file",
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

/** A literal inner command is analysed like any other; a computed one asks. */
function innerReason(words, mode) {
	if (words.length === 0) return broken("wrapper has no command string");
	if (words.some((w) => w.dynamic))
		return broken("wrapped command is computed at run time");
	return analyzeCommand(words.map((w) => w.value).join(" "), mode);
}

const STDIN_FED = "shell reads its commands from stdin";

// Word checks return { reason, covered }: `covered` counts the following words an
// inner analysis already inspected, so the segment scan skips them. Without the
// skip, `eval eval ... x` re-analyses every suffix and the hook can time out.
const verdict = (reason, covered = 0) => ({ reason, covered });
const inner = (words, mode, covered) =>
	verdict(innerReason(words, mode), covered);

// ---- which word a segment runs (D12 rev. 1) -----------------------------------------

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
// Launchers that run their operand, with the options that take a value.
const LAUNCHERS = {
	sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "-R"],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	command: [],
	exec: ["-a"],
	nohup: [],
	time: ["-f", "-o", "--format", "--output"],
	nice: ["-n", "--adjustment"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
	setsid: [],
};
const LAUNCHER_NUMBER = /^\d+(\.\d+)?[smhd]?$/;

/** Index past a launcher's options, option values, numbers and assignments. */
function skipLauncherArgs(words, k, takesValue) {
	while (k < words.length) {
		const v = words[k].value;
		if (ASSIGNMENT.test(v) || LAUNCHER_NUMBER.test(v)) k++;
		else if (v.startsWith("-")) k += takesValue.includes(v) ? 2 : 1;
		else break;
	}
	return k;
}

/** Index of the word the segment runs: the first non-assignment word, or the
    operand of the launchers above. Computed once per segment. */
function runIndex(segment) {
	if (segment.runIndex !== undefined) return segment.runIndex;
	const { words } = segment;
	let k = 0;
	while (isLeadingWord(words[k])) k++;
	for (
		let launcher = launcherOf(words[k]);
		launcher;
		launcher = launcherOf(words[k])
	)
		k = skipLauncherArgs(words, k + 1, launcher);
	segment.runIndex = k;
	return k;
}

/** An assignment or shell keyword before the command word. */
const isLeadingWord = (word) =>
	word !== undefined &&
	(ASSIGNMENT.test(word.value) || SHELL_KEYWORDS.has(word.value));

/** The launcher's value-taking options, or undefined when `word` is none. */
function launcherOf(word) {
	if (word === undefined) return undefined;
	const name = commandName(word.value);
	return Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined;
}

// Shell reads that never run commands, valid only before a command string or
// operand (`bash -c "git push" --version` still pushes).
const TERMINAL_READS = {
	posix: new Set(["--version", "--help"]),
	pwsh: new Set(["-version", "--version", "-help", "--help", "-?"]),
	powershell: new Set(["-help", "-?", "/?"]),
};
const STDIN_OPERANDS = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

/** A POSIX shell operand: stdin (`-`, `/dev/stdin`, `<(…)`) asks when the shell
    is run; a file operand is D11 residual risk. */
function posixOperandReason(word, isRun) {
	const readsStdin = STDIN_OPERANDS.has(word.value) || word.processSubstitution;
	return verdict(readsStdin && isRun ? broken(STDIN_FED) : null);
}

// Wrapper checks read the segment's words from `from` (just after the wrapper
// word) in place, without copying them: every shell word in a long segment would
// otherwise copy the rest of it (D13: cost stays linear).

function posixShellReason(words, from, fedByStdin, isRun) {
	for (let j = from; j < words.length; j++) {
		const decided = posixWordVerdict(words, j, from, isRun);
		if (decided) return decided;
		if (POSIX_SHELL_OPTIONS_WITH_ARG.has(words[j].value)) j++;
	}
	return verdict(fedByStdin && isRun ? broken(STDIN_FED) : null);
}

/** A verdict when words[j] decides what the shell runs, else null. */
function posixWordVerdict(words, j, from, isRun) {
	const v = words[j].value;
	if (TERMINAL_READS.posix.has(v)) return verdict(null);
	if (clusterHas(v, "c"))
		return inner(words.slice(j + 1, j + 2), "bash", j + 2 - from);
	// `-s`: read commands from stdin.
	if (clusterHas(v, "s")) return verdict(isRun ? broken(STDIN_FED) : null);
	if (POSIX_SHELL_OPTIONS_WITH_ARG.has(v)) return null;
	if (words[j].processSubstitution || !/^[-+]./.test(v))
		return posixOperandReason(words[j], isRun);
	return null;
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

// `shell`: { words, from, name, isRun, fedByStdin } — the wrapper's words from
// `from`, its normalised name, whether it is the command being run, and stdin.

// A positional argument is a script file for `pwsh` (where it is the command
// being run) and an inline command for Windows `powershell`.
function powershellPositional(shell, j) {
	const covered = shell.words.length - shell.from;
	if (shell.name === "powershell")
		return inner(shell.words.slice(j), "ps", covered);
	return verdict(shell.isRun ? broken(PWSH_SCRIPT_FILE) : null, covered);
}

function powershellCommand({ words, from }, j) {
	const covered = words.length - from;
	if (words[j + 1]?.value === "-") return verdict(broken(STDIN_FED), covered);
	return inner(words.slice(j + 1), "ps", covered);
}

const PWSH_UNINSPECTABLE = {
	encoded: "PowerShell encoded command cannot be inspected",
	file: PWSH_SCRIPT_FILE,
};

function powershellReason(shell) {
	const { words, name } = shell;
	for (let j = shell.from; j < words.length; j++) {
		const v = words[j].value;
		if (TERMINAL_READS[name].has(v.toLowerCase())) return verdict(null);
		if (!/^[-/]/.test(v)) return powershellPositional(shell, j);
		const kind = powershellOption(
			v.replace(/^(--|-|\/)/, "").toLowerCase(),
			name,
		);
		if (kind === "takes-arg") j++;
		else if (kind === "command") return powershellCommand(shell, j);
		else if (Object.hasOwn(PWSH_UNINSPECTABLE, kind))
			return verdict(broken(PWSH_UNINSPECTABLE[kind]));
	}
	return verdict(shell.fedByStdin && shell.isRun ? broken(STDIN_FED) : null);
}

const isCmdRunFlag = (word) => /^\/\/?[ck]$/i.test(word.value);

// cmd's quoting is closest to PowerShell's (backslash is literal); `%VAR%` is computed.
function cmdReason(words, from, fedByStdin, isRun) {
	// Index of the first `/c` or `/k` at or after each word, cached per segment.
	const flag = suffixTable(
		words,
		"cmd-flag",
		(ws, k, later) => (isCmdRunFlag(ws[k]) ? k : later),
		-1,
	)[from];
	if (flag === -1)
		return verdict(fedByStdin && isRun ? broken(STDIN_FED) : null);
	const command = words.slice(flag + 1);
	const covered = words.length - from;
	if (command.some((w) => /%[^%\s]+%/.test(w.value)))
		return verdict(broken("wrapped command is computed at run time"), covered);
	return inner(command, "ps", covered);
}

function invokeExpressionReason(words, from, piped) {
	const command = words
		.slice(from)
		.filter((w) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w.value));
	if (command.length === 0) return verdict(piped ? broken(STDIN_FED) : null);
	return inner(command, "ps", words.length - from);
}

function evalReason(words, from) {
	if (from >= words.length) return verdict(null);
	return inner(words.slice(from), "bash", words.length - from);
}

function wrapperReason(segment, i, name) {
	const { words } = segment;
	const fedByStdin = isStdinFed(segment);
	const isRun = i === runIndex(segment);
	if (POSIX_SHELLS.has(name))
		return posixShellReason(words, i + 1, fedByStdin, isRun);
	if (POWERSHELLS.has(name))
		return powershellReason({ words, from: i + 1, name, isRun, fedByStdin });
	if (name === "cmd") return cmdReason(words, i + 1, fedByStdin, isRun);
	if (name === "eval") return evalReason(words, i + 1);
	if (INVOKE_EXPRESSION.has(name))
		return invokeExpressionReason(words, i + 1, segment.piped);
	return verdict(null);
}

// ---- run-time arguments, aliases and computed words (D5 rev. 1) ---------------------

const SHELLS = new Set([...POSIX_SHELLS, ...POWERSHELLS, "cmd"]);
const RUN_TARGETS = new Set(["git", "gh", ...SHELLS]);
const RUNNERS = new Set(["xargs", "parallel"]);
const RUNNER_OPTIONS_WITH_ARG = new Set([
	"-a",
	"-d",
	"-E",
	"-I",
	"-L",
	"-n",
	"-N",
	"-P",
	"-s",
	"-j",
	"-S",
	"--arg-file",
	"--delimiter",
	"--eof",
	"--replace",
	"--max-lines",
	"--max-args",
	"--max-procs",
	"--max-chars",
	"--jobs",
	"--process-slot-var",
]);
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const ALIAS_DEFINERS = {
	bash: new Set(["alias"]),
	ps: new Set(["set-alias", "new-alias", "sal", "nal"]),
};

/** git, gh or a shell run by xargs, parallel or find gets its arguments at run
    time; an outward reason found elsewhere still outranks this. */
function runTargetReason(word, runner) {
	if (word === undefined) return null;
	const name = commandName(word.value);
	if (!RUN_TARGETS.has(name)) return null;
	return broken(`${runner} supplies the arguments of ${name} at run time`);
}

function runnerReason(words, from, runner) {
	let k = from;
	while (k < words.length && words[k].value.startsWith("-"))
		k += RUNNER_OPTIONS_WITH_ARG.has(words[k].value) ? 2 : 1;
	return runTargetReason(words[k], runner);
}

const GIT_OR_GH = new Set(["git", "gh"]);

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
		const v = words[k].value;
		if (ALIAS_DEFINERS[mode].has(commandName(v))) break;
		const value = mode === "bash" ? v.slice(v.indexOf("=") + 1) : v;
		if (mode === "bash" && !v.includes("=")) continue;
		if (mode === "ps" && v.startsWith("-")) continue;
		if (mentionsGitOrGh(value)) return broken("a shell alias names git or gh");
	}
	return null;
}

/** A computed word directly followed by words that would make an outward git
    invocation, or an outward write-capable gh invocation, may itself be git/gh. */
function followReason(words, from, mode) {
	if (
		isOutward(gitInvocationReason(words, from, mode)) ||
		ghWouldWrite(words, from)
	)
		return broken("a computed word is followed by an outward git or gh action");
	return null;
}

function wordReason(segment, i, mode, seen) {
	const words = segment.words;
	const name = commandName(words[i].value);
	if (name === "git") return verdict(gitInvocationReason(words, i + 1, mode));
	if (name === "gh") return verdict(ghInvocationReason(words, i + 1));
	if (isComputed(words[i])) return verdict(followReason(words, i + 1, mode));
	if (RUNNERS.has(name)) return verdict(runnerReason(words, i + 1, name));
	if (name === "find") seen.find = true;
	if (seen.find && FIND_ACTIONS.has(words[i].value))
		return verdict(runTargetReason(words[i + 1], "find"));
	if (ALIAS_DEFINERS[mode].has(name))
		return verdict(aliasDefinitionReason(words, i + 1, mode));
	return wrapperReason(segment, i, name);
}

/** Position-independent: any `git`/`gh`/wrapper word in a segment is checked (D5). */
function segmentReason(segment, mode) {
	if (segment.broken) return segment.broken;
	const seen = { find: false };
	let firstBroken = null;
	for (let i = 0; i < segment.words.length; i++) {
		const { reason, covered } = wordReason(segment, i, mode, seen);
		if (isOutward(reason)) return reason;
		firstBroken ??= reason;
		i += covered;
	}
	const cmd = segment.words[commandWordIndex(segment, mode)];
	if (cmd?.dynamic)
		firstBroken ??= broken(
			`command word ${JSON.stringify(cmd.value)} is computed at run time`,
		);
	return firstBroken;
}

// Wrapper and alias re-parsing depth; bounds work on inputs like `eval eval ... x`.
let analysisDepth = 0;

function analyzeCommand(command, mode) {
	if (analysisDepth >= MAX_NESTING) return broken("wrappers nested too deeply");
	analysisDepth++;
	try {
		return analyzeSegments(tokenize(command, mode), mode);
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
	return firstBroken ?? runtimeConfigReason(segments);
}

// Env-supplied git configuration (it can define aliases or includes); other
// GIT_CONFIG_* such as GIT_CONFIG_NOSYSTEM do not count.
const CONFIG_VARIABLE =
	"GIT_CONFIG_(COUNT|KEY_\\d+|VALUE_\\d+|PARAMETERS|GLOBAL|SYSTEM)";
const CONFIG_ASSIGNMENT = new RegExp(`^${CONFIG_VARIABLE}=`);
const CONFIG_ENV_VARIABLE = new RegExp(`^env:${CONFIG_VARIABLE}$`, "i");

const setsGitConfig = (word) =>
	CONFIG_ASSIGNMENT.test(word.value) ||
	(word.vars ?? []).some((v) => CONFIG_ENV_VARIABLE.test(v));

/** Git configuration supplied at run time anywhere in a command that also
    contains a git word. */
function runtimeConfigReason(segments) {
	const words = segments.flatMap((s) => s.words);
	if (!words.some(setsGitConfig)) return null;
	if (!words.some((w) => commandName(w.value) === "git")) return null;
	return broken(RUNTIME_CONFIG);
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
	return shellCommandReason(input.tool_input?.command, SHELL_MODES[toolName]);
}

function shellCommandReason(command, mode) {
	if (typeof command !== "string")
		return broken("tool_input.command is missing");
	if (command.length > MAX_COMMAND_LENGTH)
		return broken(`command longer than ${MAX_COMMAND_LENGTH} characters`);
	return analyzeCommand(command, mode);
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
	if (!reason) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: `[rpiv-hook] ${reason}`,
			},
		}),
	);
}

// Returns normally: no `process.exit`, so a pending stdout write is never dropped
// (D13). Nothing else keeps the event loop alive, so the process exits with 0.
main();
