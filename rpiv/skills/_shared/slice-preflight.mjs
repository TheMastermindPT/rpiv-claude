// slice-preflight.mjs — the deterministic checks a committed slice candidate passes
// before any reviewer runs (candidate-workflow.md **Lanes**). It needs no test runner:
// every test the slice's Test Contract names exists, by file and title, in the
// candidate commit; every Expected-red revision resolves; every evidence log exists and
// names the slice's base or candidate. It also prints the re-proof plan for
// reprove-red.mjs (pins are never re-proved).
//
// CLI, run only as the entry point, inside the repository:
//   node slice-preflight.mjs --artifact <brief.md> --slice <slice-id>
//                            --base <rev> --candidate <rev> [--evidence <path>]...
// Prints `preflight: clean` (exit 0), `preflight: partial` (exit 0: some Test lines
// could not be read and are listed as `unchecked:`, never reported clean) or
// `preflight: findings` (exit 1), then `finding:`, `unchecked:`, `diagnostic:` and
// `reprove:` lines. A broken call prints `slice-preflight: broken: <detail>` on stderr
// and exits 2, never a result.
//
// Importable: parseTestContract (pure).

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { parseFences } from "./fences.mjs";
import { isMain } from "./is-main.mjs";

const HEADING = /^(#{2,6})\s+(.*)$/;
// `**Behavior B1**: x`, also with a parenthetical after the ID and/or the colon inside
// the bold (`**Behavior B1 (X-1):** x`), as briefs from the design skill write it. The
// word Behavior may be left out (`**B1: x**`) when the ID holds a digit, so a bold
// label such as `**Note:**` is never read as a behavior.
const BEHAVIOR =
	/^- \*\*(?:Behavior ([A-Za-z0-9-]+)|([A-Za-z]+-?\d[A-Za-z0-9-]*))(?: \(.*?\))?(?:\*\*:|:\*\*|:) (.+)$/;
const EXEMPT = /^- \*\*TDD-exempt\*\*/;
const SUB = /^ {2}- (Tests?|Expected red[^:]*):\s*(.*)$/;
// One item of the nested list under a `Tests:` sub-bullet, read as its own Test clause.
const NESTED = /^ {4,}- (.*)$/;
const RED_AT = /\bat `?([0-9a-f]{7,40})`?/gi;
const PIN = /^none\s*[—-]\s*pin\b/i;

/** Lines outside fenced code blocks (fences.mjs owns fence parsing), 1-based. */
const unfenced = (text) => {
	const lines = text.split(/\r?\n/);
	const { fences, unterminated } = parseFences(text);
	const inside = new Set();
	const mark = (start, end) => {
		for (let no = start; no <= end; no++) inside.add(no);
	};
	for (const fence of fences) mark(fence.start, fence.end);
	if (unterminated)
		throw new Error(
			`unterminated code fence opened at line ${unterminated.start} of the brief`,
		);
	return lines
		.map((line, i) => ({ line, no: i + 1 }))
		.filter(({ no }) => !inside.has(no));
};

/** The section lines of `### Test Contract: <sliceId>`; throws unless exactly one. */
const contractSection = (lines, sliceId) => {
	const starts = lines
		.map((entry, i) => ({ ...entry, i, h: HEADING.exec(entry.line) }))
		.filter((e) => e.h && e.h[2].trim() === `Test Contract: ${sliceId}`);
	if (starts.length === 0)
		throw new Error(`no \`### Test Contract: ${sliceId}\` section`);
	if (starts.length > 1)
		throw new Error(
			`${starts.length} \`### Test Contract: ${sliceId}\` sections`,
		);
	const level = starts[0].h[1].length;
	const body = [];
	for (const entry of lines.slice(starts[0].i + 1)) {
		const h = HEADING.exec(entry.line);
		if (h && h[1].length <= level) break;
		body.push(entry);
	}
	return body;
};

const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The parenthesis depth and code-span state after reading `ch`. */
const scan = (state, ch) => {
	if (ch === "`") return { ...state, code: !state.code };
	if (state.code) return state;
	if (ch === "(") return { ...state, depth: state.depth + 1 };
	if (ch === ")") return { ...state, depth: Math.max(0, state.depth - 1) };
	return state;
};

/** True when `text[i]` is a clause-separating `; ` outside parentheses and code. */
const splitsAt = (state, text, i) =>
	!state.code &&
	state.depth === 0 &&
	text[i] === ";" &&
	/\s/.test(text[i + 1] ?? "");

/** A Test line's clauses: split on `; ` only outside parentheses and code spans. */
const clauses = (text) => {
	const out = [];
	let state = { depth: 0, code: false };
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (splitsAt(state, text, i)) {
			out.push(text.slice(start, i));
			start = i + 1;
		} else state = scan(state, text[i]);
	}
	out.push(text.slice(start));
	return out.map((c) => c.trim()).filter(Boolean);
};
const withoutParens = (text) =>
	text.replace(/`[^`]*`|\([^()]*\)/g, (m) => (m.startsWith("`") ? m : " "));

/** One `;`-separated clause of a Test line → its tests, or null when unreadable. */
/** `T` [and `T`]* -> `P`: every title before the last arrow, one path after it. */
const arrowClause = (clause, arrow) => {
	const titles = ticked(withoutParens(clause.slice(0, arrow)));
	const path = ticked(clause.slice(arrow + 2))[0];
	const readable = titles.length && path && titles.every((t) => t.trim());
	return readable ? titles.map((title) => ({ title, path })) : null;
};

const IN_FORM = /^`([^`]+)`\s+in\s+`([^`]+)`/;
const REWRITE_FORM = /^rewrite in `([^`]+)`\s*\(`([^`]+)`\)/;

/** `T` in `P`, or rewrite in `P` (`T`). */
const wordClause = (clause) => {
	const inForm = IN_FORM.exec(clause);
	if (inForm) return [{ title: inForm[1], path: inForm[2] }];
	const rewrite = REWRITE_FORM.exec(clause);
	return rewrite ? [{ title: rewrite[2], path: rewrite[1] }] : null;
};

const readClause = (clause) => {
	if (clause.includes("``")) return null;
	const arrow = clause.lastIndexOf("->");
	return arrow === -1 ? wordClause(clause) : arrowClause(clause, arrow);
};

/** Record a Test sub-bullet's tests, or its unreadable clauses as unchecked. */
const addTests = (behavior, text, no) => {
	const parts = clauses(text);
	if (parts.length === 0) return;
	behavior.hasTest = true;
	for (const clause of parts) {
		const tests = readClause(clause);
		if (tests) behavior.tests.push(...tests);
		else behavior.unchecked.push({ line: no, text: clause });
	}
};

/** Record an Expected-red sub-bullet: a pin marker and the revisions it names. */
const addRed = (behavior, text) => {
	if (PIN.test(text)) behavior.pin = true;
	// "none observable … at <sha>" names a revision where red was NOT seen: no re-proof.
	if (/^none\b/i.test(text)) return;
	for (const m of text.matchAll(RED_AT)) {
		const sha = m[1].toLowerCase();
		if (!behavior.redAt.includes(sha)) behavior.redAt.push(sha);
	}
};

const newBehavior = (id, line) => ({
	id,
	line,
	tests: [],
	unchecked: [],
	pin: false,
	redAt: [],
	hasTest: false,
});

/** Apply one contract-section line to the behaviors and TDD exemptions read so far. */
const readLine = (parsed, entry) => {
	const nested = parsed.listing && NESTED.exec(entry.line);
	if (nested) {
		addTests(parsed.current, nested[1], entry.no);
		return;
	}
	parsed.listing = false;
	readEntry(parsed, entry);
};

/** A behavior header, TDD exemption, or Test / Expected-red sub-bullet. */
const readEntry = (parsed, { line, no }) => {
	const b = BEHAVIOR.exec(line);
	if (b) {
		parsed.current = newBehavior(b[1] ?? b[2], no);
		parsed.behaviors.push(parsed.current);
		return;
	}
	if (EXEMPT.test(line)) {
		parsed.exempt.push(no);
		parsed.current = null;
		return;
	}
	const sub = SUB.exec(line);
	if (!sub || !parsed.current) return;
	if (!sub[1].startsWith("Test")) return addRed(parsed.current, sub[2]);
	addTests(parsed.current, sub[2], no);
	parsed.listing = true;
};

/** The Test Contract of `sliceId` in brief `text`:
    `{ behaviors: [{ id, line, tests: [{ title, path }], unchecked: [{ line, text }],
    pin, redAt: [sha] }], exempt: [line] }`. Throws on a missing or duplicate section. */
export const parseTestContract = (text, sliceId) => {
	const parsed = { behaviors: [], exempt: [], current: null, listing: false };
	for (const entry of contractSection(unfenced(text), sliceId))
		readLine(parsed, entry);
	return { behaviors: parsed.behaviors, exempt: parsed.exempt };
};

const git = (root, args) =>
	spawnSync("git", args, { cwd: root, encoding: "utf-8" });

/** The full SHA of `rev` as a commit, or null when it does not name one. */
const commitOf = (root, rev) => {
	const res = git(root, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${rev}^{commit}`,
	]);
	return res.status === 0 ? res.stdout.trim() : null;
};

/** The text of `path` at `commit`, or null when the commit has no such file. A contract
    names paths relative to the folder it is run from (a plugin folder inside a larger
    repository, or the root), so `./` makes git resolve them from `dir`. */
const fileAt = (dir, commit, path) => {
	const res = git(dir, ["show", `${commit}:./${path.replace(/^\.\//, "")}`]);
	return res.status === 0 ? res.stdout : null;
};

/** True when `source` holds `title` as a whole string literal in any quote style
    (its own quote escaped), so a shorter title never matches a longer test name. */
const hasTitle = (source, title) =>
	[
		["'", "\\'"],
		['"', '\\"'],
		["`", "\\`"],
	].some(([quote, escaped]) =>
		source.includes(quote + title.replaceAll(quote, escaped) + quote),
	);

const OPTIONS = {
	"--artifact": "artifact",
	"--slice": "slice",
	"--base": "base",
	"--candidate": "candidate",
};

/** The value after `flag`; throws when the flag is unknown or has no value. */
const flagValue = (flag, value) => {
	if (flag !== "--evidence" && !(flag in OPTIONS))
		throw new Error(`unknown option: ${flag}`);
	if (value === undefined || value.startsWith("--"))
		throw new Error(`${flag} needs a value`);
	return value;
};

const parseArgs = (argv) => {
	const options = { evidence: [] };
	for (let i = 0; i < argv.length; i += 2) {
		const value = flagValue(argv[i], argv[i + 1]);
		if (argv[i] === "--evidence") options.evidence.push(value);
		else options[OPTIONS[argv[i]]] = value;
	}
	const missing = Object.keys(OPTIONS).find(
		(flag) => options[OPTIONS[flag]] === undefined,
	);
	if (missing) throw new Error(`${missing} is required`);
	return options;
};

/** Findings for the contract's tests at the candidate. */
/** The finding for one named test, or null when its file holds its title. */
const testFinding = (id, { title, path }, source) => {
	if (source === null) return `missing-test-file: ${id} ${path}`;
	return hasTitle(source, title)
		? null
		: `missing-test-title: ${id} ${path} :: ${title}`;
};

const testFindings = (dir, candidate, behaviors) => {
	const files = new Map();
	const sourceOf = (path) => {
		if (!files.has(path)) files.set(path, fileAt(dir, candidate, path));
		return files.get(path);
	};
	const findings = behaviors.flatMap((b) => [
		...(b.hasTest ? [] : [`no-test-line: ${b.id}`]),
		...b.tests.map((test) => testFinding(b.id, test, sourceOf(test.path))),
	]);
	return [...new Set(findings.filter(Boolean))];
};

/** Findings for Expected-red revisions that do not resolve. */
const redFindings = (root, behaviors) =>
	behaviors.flatMap((b) =>
		b.redAt
			.filter((sha) => commitOf(root, sha) === null)
			.map((sha) => `unresolved-red-revision: ${b.id} ${sha}`),
	);

/** Findings for evidence logs: missing, or naming neither the base nor the candidate. */
/** True when `text` names a revision that is a prefix of one of `shas`. */
const namesRevision = (text, shas) =>
	(text.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((t) =>
		shas.some((sha) => sha.startsWith(t)),
	);

/** The finding for one evidence log, or null when it exists and names the slice. */
const evidenceFinding = (path, shas) => {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (!stat) return `missing-evidence: ${path}`;
	if (!stat.isFile()) throw new Error(`evidence is not a file: ${path}`);
	return namesRevision(readFileSync(path, "utf-8"), shas)
		? null
		: `evidence-unbound: ${path}`;
};

const evidenceFindings = (paths, shas) =>
	paths.map((path) => evidenceFinding(path, shas)).filter(Boolean);

/** reprove-red.mjs calls for the contract's non-pin tests: one per named red revision. */
const reprovePlan = (candidate, behaviors) =>
	behaviors
		.filter((b) => !b.pin)
		.flatMap((b) =>
			b.tests.flatMap(({ title, path }) =>
				(b.redAt.length ? b.redAt : [null]).map(
					(sha) =>
						`reprove: --commit ${candidate}${sha ? ` --base ${sha}` : ""} --test ${path}::${title}`,
				),
			),
		);

/** The repository root and the full base and candidate SHAs; throws when any is missing. */
const resolveRepo = (cwd, options) => {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.status !== 0) throw new Error("not inside a git repository");
	const root = top.stdout.trim();
	const commit = (flag, rev) => {
		const sha = commitOf(root, rev);
		if (sha === null) throw new Error(`${flag} ${rev} does not name a commit`);
		return sha;
	};
	const candidate = commit("--candidate", options.candidate);
	const base = commit("--base", options.base);
	if (candidate === base)
		throw new Error(
			"--candidate equals --base: the slice has no commit of its own",
		);
	return { root, candidate, base };
};

/** The slice's behaviors; throws when the contract has none. */
const loadBehaviors = (options) => {
	const { behaviors } = parseTestContract(
		readFileSync(options.artifact, "utf-8"),
		options.slice,
	);
	if (behaviors.length === 0)
		throw new Error(
			`\`### Test Contract: ${options.slice}\` has no Behavior entries`,
		);
	return behaviors;
};

const headline = (findings, unchecked) => {
	if (findings.length) return "findings";
	return unchecked.length ? "partial" : "clean";
};

/** The CLI's stdout and exit code for `argv`, run in `cwd`; throws on a broken call. */
const runCli = (argv, cwd) => {
	const options = parseArgs(argv);
	const { root, candidate, base } = resolveRepo(cwd, options);
	const behaviors = loadBehaviors(options);
	const findings = [
		...testFindings(cwd, candidate, behaviors),
		...redFindings(root, behaviors),
		...evidenceFindings(options.evidence, [base, candidate]),
	];
	const unchecked = behaviors.flatMap((b) =>
		b.unchecked.map((u) => `unchecked: ${b.id} line ${u.line}: ${u.text}`),
	);
	const diagnostics =
		commitOf(root, `${candidate}^`) === base
			? []
			: [
					"diagnostic: the candidate's parent is not the base; reprove-red re-proves against the parent",
				];
	const lines = [
		`preflight: ${headline(findings, unchecked)}`,
		...findings.map((f) => `finding: ${f}`),
		...unchecked,
		...diagnostics,
		...reprovePlan(candidate, behaviors),
	];
	return {
		text: lines.map((l) => `${l}\n`).join(""),
		exitCode: findings.length ? 1 : 0,
	};
};

if (isMain(import.meta.url)) {
	try {
		const { text, exitCode } = runCli(process.argv.slice(2), process.cwd());
		process.stdout.write(text);
		process.exitCode = exitCode;
	} catch (error) {
		// A broken call never prints a result (degrade-distinguishes-broken).
		const detail = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`slice-preflight: broken: ${detail}\n`);
		process.exitCode = 2;
	}
}
