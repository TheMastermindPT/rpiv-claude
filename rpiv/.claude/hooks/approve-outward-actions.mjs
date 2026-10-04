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

function newSegmentBuilder(p) {
	let words = [];
	let word = null;
	let piped = false;
	let called = false;
	return {
		get inWord() {
			return word !== null;
		},
		get current() {
			return word?.value ?? "";
		},
		append(text) {
			word ??= { value: "", dynamic: false };
			word.value += text;
		},
		/** The current word's value is only known at run time (`$x`, `$(...)`). */
		markDynamic() {
			this.append("");
			word.dynamic = true;
		},
		endWord() {
			if (word !== null) words.push(word);
			word = null;
		},
		endSegment({ nextPiped = false, nextCalled = false } = {}) {
			this.endWord();
			if (words.length > 0) p.segments.push({ words, piped, called });
			words = [];
			piped = nextPiped;
			called = nextCalled;
		},
	};
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
		seg.append(ch);
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
	else if (ch === "$") return readExpansion(p, seg, next);
	else if (ch === "`" && p.mode === "bash") readBacktick(p, seg);
	else if (ch === "@" && startsHereString(p, seg))
		seg.append(readHereString(p));
	else return false;
	return true;
}

/** PowerShell block comments, heredocs and process substitution `<(`/`>(`. */
function stepRedirection(p, seg, ch, next) {
	if (ch !== "<" && ch !== ">") return false;
	if (next === "(") {
		seg.endWord();
		p.i++;
		return true;
	}
	return ch === "<" && stepLessThan(p, seg, next);
}

function stepLessThan(p, seg, next) {
	const opens = { ps: "#", bash: "<" }[p.mode];
	if (next !== opens) return false;
	if (p.mode === "bash") readHeredocStart(p, seg);
	else if (seg.inWord) return false;
	else skipBlockComment(p);
	return true;
}

/** Segment separators: `&`, `|`, `;` and grouping. */
function stepSeparator(p, seg, ch, next) {
	if (ch === "&") stepAmpersand(p, seg, next);
	else if (ch === "|") {
		seg.endSegment({ nextPiped: next !== "|" });
		p.i += next === "|" ? 2 : 1;
	} else if (GROUPING.has(ch)) {
		seg.endSegment();
		p.i++;
	} else return false;
	return true;
}

function stepAmpersand(p, seg, next) {
	// Redirections (`2>&1`, `&>file`) keep `&` inside the word.
	if (/[<>]$/.test(seg.current) || next === ">") {
		seg.append("&");
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
function readExpansion(p, seg, next) {
	if (next === "(") {
		p.i += 2;
		seg.markDynamic();
		parseList(p, ")");
		return true;
	}
	if (next === undefined || !VARIABLE_START[p.mode].test(next)) return false;
	seg.markDynamic();
	if (next === "{") {
		const close = p.src.indexOf("}", p.i + 2);
		if (close === -1) throw new Unparseable("unterminated ${...}");
		p.i = close + 1;
		return true;
	}
	p.i += 2;
	while (p.i < p.src.length && /[A-Za-z0-9_:]/.test(p.src[p.i])) p.i++;
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

function stepDoubleQuoted(p, seg, ch, next) {
	if (ch === '"') {
		seg.append('"');
		p.i += 2;
	} else if (ch === ESCAPE_CHAR[p.mode] && escapesInDoubleQuotes(p, next))
		seg.append(readEscape(p));
	else if (ch === "$" && readExpansion(p, seg, next)) return;
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
	return p.src.slice(bodyStart, close).replace(/\r$/, "");
}

function readHeredocStart(p, seg) {
	if (p.src[p.i + 2] === "<") {
		seg.append("<<<");
		p.i += 3;
		return;
	}
	seg.endWord();
	p.i += 2;
	const strip = p.src[p.i] === "-";
	if (strip) p.i++;
	while (p.src[p.i] === " " || p.src[p.i] === "\t") p.i++;
	let delim = "";
	while (p.i < p.src.length && !/[\s;|&<>()]/.test(p.src[p.i])) {
		const ch = p.src[p.i];
		if (ch === "'") delim += readSingleQuoted(p);
		else if (ch === '"') {
			const sink = newSegmentBuilder(p);
			readDoubleQuoted(p, sink);
			delim += sink.current;
		} else {
			delim += ch;
			p.i++;
		}
	}
	p.heredocs.push({ delim, strip });
}

/** After a newline, skip the bodies of heredocs opened on the previous line. */
function consumeHeredocs(p) {
	for (const { delim, strip } of p.heredocs) {
		while (p.i < p.src.length) {
			const nl = p.src.indexOf("\n", p.i);
			const end = nl === -1 ? p.src.length : nl;
			let line = p.src.slice(p.i, end).replace(/\r$/, "");
			if (strip) line = line.replace(/^\t+/, "");
			p.i = nl === -1 ? p.src.length : nl + 1;
			if (line === delim) break;
		}
	}
	p.heredocs = [];
}

// ---- git -------------------------------------------------------------------------

const BRANCH = "branch creation";

// Short-option clusters are matched letter by letter (`-fc` contains `c`).
const isCluster = (arg) => /^-[a-zA-Z]+$/.test(arg);
const clusterHas = (arg, letters) =>
	isCluster(arg) && [...arg.slice(1)].some((ch) => letters.includes(ch));
const hasLongOption = (arg, names) =>
	names.some((n) => arg === n || arg.startsWith(`${n}=`));

/** Arguments up to a `--` path separator. */
const optionArgs = (args) => {
	const end = args.indexOf("--");
	return end === -1 ? args : args.slice(0, end);
};

function switchCreates(args) {
	return optionArgs(args).some(
		(a) =>
			clusterHas(a, "cCt") ||
			hasLongOption(a, ["--create", "--force-create", "--orphan", "--track"]),
	);
}

function checkoutCreates(args) {
	return optionArgs(args).some(
		(a) => clusterHas(a, "bBt") || hasLongOption(a, ["--orphan", "--track"]),
	);
}

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

function branchCreates(args) {
	const opts = optionArgs(args);
	if (
		opts.some(
			(a) => clusterHas(a, "cCmM") || hasLongOption(a, BRANCH_RENAME_COPY),
		)
	)
		return true;
	if (
		opts.some((a) => clusterHas(a, "dDalrvu") || hasLongOption(a, BRANCH_QUERY))
	)
		return false;
	return args.some((a) => !a.startsWith("-"));
}

const pushesVia = (args) => args.includes("push");

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
	stash: [BRANCH, (args) => args[0] === "branch"],
	worktree: ["worktree creation", (args) => args[0] === "add"],
};

function classifyGit(sub, args) {
	const rule = Object.hasOwn(GIT_OUTWARD, sub) ? GIT_OUTWARD[sub] : undefined;
	return rule?.[1](args) ? rule[0] : null;
}

// git options that consume the next word when written without `=`.
const GIT_OPTIONS_WITH_ARG = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--super-prefix",
	"--config-env",
]);
const ALIAS_SETTING = /^alias\.([^=]+)=(.*)$/is;

/** Skips git's own options; returns the subcommand, its args and `-c alias.*`. */
function gitInvocation(values) {
	const aliases = new Map();
	let j = 0;
	while (j < values.length && values[j].startsWith("-")) {
		if (!GIT_OPTIONS_WITH_ARG.has(values[j])) {
			j++;
			continue;
		}
		const alias = values[j] === "-c" && ALIAS_SETTING.exec(values[j + 1] ?? "");
		if (alias) aliases.set(alias[1].toLowerCase(), alias[2]);
		j += 2;
	}
	return { sub: values[j]?.toLowerCase(), args: values.slice(j + 1), aliases };
}

const gitReason = (sub, args) => outward(classifyGit(sub, args));

/** `values` are the words after `git`. Returns a reason or null. */
function gitWordsReason(values) {
	const { sub, args, aliases } = gitInvocation(values);
	if (sub === undefined) return null;
	const alias = aliases.get(sub);
	if (alias === undefined) return gitReason(sub, args);
	if (alias.startsWith("!")) return analyzeCommand(alias.slice(1), "bash");
	const expanded = tokenize(alias, "bash")[0]?.words.map((w) => w.value) ?? [];
	const inner = gitInvocation([...expanded, ...args]);
	return inner.sub === undefined ? null : gitReason(inner.sub, inner.args);
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
const GH_REPO_FLAGS = new Set(["-R", "--repo"]);
const GH_API_FIELD_FLAGS = ["-f", "-F", "--field", "--raw-field", "--input"];

/** Positional words of a gh invocation, skipping options and `-R <repo>`. */
function ghPositionals(args) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		if (GH_REPO_FLAGS.has(args[i])) i++;
		else if (!args[i].startsWith("-")) out.push(args[i]);
	}
	return out;
}

/** HTTP method of `gh api`: explicit -X/--method, else POST when fields are sent. */
function ghApiMethod(args) {
	let method = null;
	let hasFields = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-X" || a === "--method") method = args[++i] ?? "";
		else if (a.startsWith("--method=")) method = a.slice("--method=".length);
		else if (a.startsWith("-X")) method = a.slice(2).replace(/^=/, "");
		else if (hasLongOption(a, GH_API_FIELD_FLAGS)) hasFields = true;
	}
	return (method ?? (hasFields ? "POST" : "GET")).toUpperCase();
}

function ghIsRead(args) {
	const [top, second] = ghPositionals(args);
	if (top === undefined) return true;
	if (top === "api") return ghApiMethod(args) === "GET";
	const reads = GH_READS[top];
	if (reads === undefined) return false;
	return reads === "*" || second === undefined || reads.includes(second);
}

function classifyGh(args) {
	if (ghIsRead(args)) return null;
	return `gh ${ghPositionals(args).slice(0, 2).join(" ")}`;
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

function posixShellReason(rest, fedByStdin) {
	for (let j = 0; j < rest.length; j++) {
		const v = rest[j].value;
		if (isCluster(v) && v.includes("c"))
			return inner(rest.slice(j + 1, j + 2), "bash", j + 2);
		if (POSIX_SHELL_OPTIONS_WITH_ARG.has(v)) j++;
		// A script operand is outside the guarantee (D11 residual risk).
		else if (!v.startsWith("-") && !v.startsWith("+")) return verdict(null);
	}
	return verdict(fedByStdin ? broken(STDIN_FED) : null);
}

// PowerShell accepts any unambiguous prefix of a parameter name.
const abbreviates = (opt, name) => opt !== "" && name.startsWith(opt);

/** Classifies a pwsh/powershell option word (without its dash). */
function powershellOption(opt) {
	if (PWSH_OPTIONS_WITH_ARG.has(opt)) return "takes-arg";
	if (abbreviates(opt, "command")) return "command";
	if (opt === "ec" || abbreviates(opt, "encodedcommand")) return "encoded";
	if (abbreviates(opt, "file")) return "file";
	return "switch";
}

function powershellReason(rest, fedByStdin) {
	for (let j = 0; j < rest.length; j++) {
		const v = rest[j].value;
		if (!/^[-/]/.test(v)) return inner(rest.slice(j), "ps", rest.length);
		const kind = powershellOption(v.replace(/^(--|-|\/)/, "").toLowerCase());
		if (kind === "takes-arg") j++;
		else if (kind === "command")
			return inner(rest.slice(j + 1), "ps", rest.length);
		else if (kind === "encoded")
			return verdict(broken("PowerShell encoded command cannot be inspected"));
		else if (kind === "file")
			return verdict(broken("PowerShell script file cannot be inspected"));
	}
	return verdict(fedByStdin ? broken(STDIN_FED) : null);
}

// cmd's quoting is closest to PowerShell's (backslash is literal); `%VAR%` is computed.
function cmdReason(rest, fedByStdin) {
	const flag = rest.findIndex((w) => /^\/\/?[ck]$/i.test(w.value));
	if (flag === -1) return verdict(fedByStdin ? broken(STDIN_FED) : null);
	const words = rest.slice(flag + 1);
	if (words.some((w) => /%[^%\s]+%/.test(w.value)))
		return verdict(
			broken("wrapped command is computed at run time"),
			rest.length,
		);
	return inner(words, "ps", rest.length);
}

function invokeExpressionReason(rest, piped) {
	const words = rest.filter(
		(w) => !/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(w.value),
	);
	if (words.length === 0) return verdict(piped ? broken(STDIN_FED) : null);
	return inner(words, "ps", rest.length);
}

function wrapperReason(segment, i, name) {
	const rest = () => segment.words.slice(i + 1);
	const lead = segment.words.findIndex((w) => !ASSIGNMENT.test(w.value));
	const fedByStdin = segment.piped || i === lead;
	if (POSIX_SHELLS.has(name)) return posixShellReason(rest(), fedByStdin);
	if (POWERSHELLS.has(name)) return powershellReason(rest(), fedByStdin);
	if (name === "cmd") return cmdReason(rest(), fedByStdin);
	if (name === "eval") {
		const words = rest();
		return words.length === 0
			? verdict(null)
			: inner(words, "bash", words.length);
	}
	if (INVOKE_EXPRESSION.has(name))
		return invokeExpressionReason(rest(), segment.piped);
	return verdict(null);
}

function wordReason(segment, values, i) {
	const name = commandName(values[i]);
	if (name === "git") return verdict(gitWordsReason(values.slice(i + 1)));
	if (name === "gh") return verdict(outward(classifyGh(values.slice(i + 1))));
	return wrapperReason(segment, i, name);
}

/** Position-independent: any `git`/`gh`/wrapper word in a segment is checked (D5). */
function segmentReason(segment, mode) {
	const values = segment.words.map((w) => w.value);
	let firstBroken = null;
	for (let i = 0; i < values.length; i++) {
		const { reason, covered } = wordReason(segment, values, i);
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
	return firstBroken;
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
	const mode = SHELL_MODES[toolName];
	return mode === undefined
		? null
		: shellCommandReason(input.tool_input?.command, mode);
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

main();
process.exit(0);
