// slice-preflight.mjs — the deterministic checks a committed slice candidate passes
// before any reviewer runs (candidate-workflow.md **Lanes**). It needs no test runner:
// every test the slice's Test Contract names exists in the candidate commit, by file
// and title, or for a whole-file test (no title named) as a file the slice changed
// (a pin's file need only exist); a behavior with no Test line has at least one test
// titled `<id>: …` in a test file the slice changed; every Expected-red revision resolves; every evidence
// log exists and names the slice's base or candidate. Contract paths resolve against
// the repository root, never the run folder. The base must be an ancestor of the
// candidate; the slice may span several commits. It also prints the re-proof plan for
// reprove-red.mjs, always with a `--base` (pins are never re-proved).
//
// CLI, run only as the entry point, inside the repository:
//   node slice-preflight.mjs --artifact <brief.md> --slice <slice-id>
//                            --base <rev> --candidate <rev> [--evidence <path>]...
// Prints `preflight: clean` (exit 0), `preflight: partial` (exit 0: some Test lines
// could not be read and are listed as `unchecked:`, never reported clean) or
// `preflight: findings` (exit 1), then `finding:`, `unchecked:`, `diagnostic:` and
// `reprove:` lines. A broken call prints `slice-preflight: broken: <detail>` on stderr
// and exits 2, never a result. A contract of TDD-exempt items only (a docs slice) is
// checked like any other, with a `diagnostic:` line saying so and no `reprove:` lines;
// a contract with neither behaviors nor exemptions is a broken call.
//
// Importable: parseTestContract (pure).

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isMain } from "./is-main.mjs";
import { isTest } from "./source-vocab.mjs";
import { parseTestContract } from "./test-contract.mjs";

// The parser lives in test-contract.mjs, which owns the Test line grammar.
export { parseTestContract };

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

/** git's NUL-separated path list for `args` run at `root`; throws when git fails. */
const pathList = (root, args) => {
	const res = git(root, args);
	if (res.status !== 0)
		throw new Error(
			`git ${args[0]} failed: ${res.stderr.trim().split("\n")[0]}`,
		);
	return res.stdout.split("\0").filter(Boolean);
};

/** The text of root-relative `path` at `commit` (a file the tree listing holds). */
const fileAt = (root, commit, path) => {
	const res = git(root, ["show", `${commit}:${path}`]);
	return res.status === 0 ? res.stdout : null;
};

const depth = (path) => path.split("/").length;

/** The shallowest of `paths` when exactly one is shallowest, else null. */
const shallowest = (paths) => {
	const least = Math.min(...paths.map(depth));
	const top = paths.filter((p) => depth(p) === least);
	return top.length === 1 ? top[0] : null;
};

/** Where a contract path lives at the candidate, the same from any folder: the exact
    root-relative file; else the one file whose path ends with it (a contract written
    inside a plugin folder, or a bare file name); among several, the ones the slice
    changed, then the single shallowest (a generated mirror sits deeper). Returns
    `{ path, also }`, `{ missing }` or `{ ambiguous: [paths] }`. The run folder is never
    used. */
const resolveTestPath = (repo, written) => {
	const wanted = written.replaceAll("\\", "/").replace(/^\.\//, "");
	if (repo.tree.has(wanted)) return { path: wanted, also: [] };
	const matches = [...repo.tree].filter((f) => f.endsWith(`/${wanted}`));
	if (matches.length === 0) return { missing: true };
	if (matches.length === 1) return { path: matches[0], also: [] };
	const touched = matches.filter((f) => repo.changed.has(f));
	const pool = touched.length ? touched : matches;
	const path = pool.length === 1 ? pool[0] : shallowest(pool);
	if (path === null) return { ambiguous: pool.sort() };
	return { path, also: matches.filter((f) => f !== path).sort() };
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

/** The finding for one test at its resolved file, or null when it holds. A titled test
    needs its title in the file; a whole-file test of a non-pin behavior needs the slice
    to have changed the file, since no title says what the slice wrote. */
const resolvedFinding = (repo, b, { title, path: written }, path) => {
	if (title === undefined)
		return b.pin || repo.changed.has(path)
			? null
			: `untouched-test-file: ${b.id} ${written}`;
	return hasTitle(repo.sourceOf(path), title)
		? null
		: `missing-test-title: ${b.id} ${written} :: ${title}`;
};

/** The finding and diagnostic for one contract test at the candidate. */
const testOutcome = (repo, b, test) => {
	const where = resolveTestPath(repo, test.path);
	if (where.missing)
		return { finding: `missing-test-file: ${b.id} ${test.path}` };
	if (where.ambiguous)
		return {
			finding: `ambiguous-test-path: ${b.id} ${test.path} (${where.ambiguous.join(", ")})`,
		};
	return {
		finding: resolvedFinding(repo, b, test, where.path),
		diagnostic: where.also.length
			? `diagnostic: test path ${test.path} resolved to ${where.path} (also matched ${where.also.join(", ")})`
			: null,
	};
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every test title in `source` that starts with `<id>:` (`'B3: rejects …'`), as written. */
const titlesStartingWith = (source, id) => {
	const quoted = new RegExp(
		`(['"\`])(${escapeRegExp(id)}:[^'"\`\\n]*)\\1`,
		"g",
	);
	return [...source.matchAll(quoted)].map((m) => m[2]);
};

/** A behavior's tests when its contract names none: the titles starting with its ID in
    the test files the slice changed. Only changed files are searched, so the same ID in
    another feature's tests never counts. */
const testsById = (repo, b) =>
	[...repo.changed]
		.filter((path) => isTest(path) && repo.tree.has(path))
		.flatMap((path) =>
			titlesStartingWith(repo.sourceOf(path) ?? "", b.id).map((title) => ({
				title,
				path,
			})),
		);

/** The behavior with its tests: the contract's, or else the ones found by ID. */
const withTests = (repo, b) =>
	b.hasTest ? b : { ...b, tests: testsById(repo, b) };

/** The finding and diagnostic outcomes for one behavior at the candidate. A behavior
    with neither a Test line nor a changed test titled by its ID has no test. */
const behaviorOutcomes = (repo, b) => {
	if (!b.hasTest)
		return b.tests.length ? [] : [{ finding: `no-test-line: ${b.id}` }];
	return b.tests.map((test) => testOutcome(repo, b, test));
};

/** Findings and diagnostics for the contract's tests at the candidate, plus the
    behaviors with the tests found by ID filled in (the re-proof plan needs them). */
const testChecks = (repo, behaviors) => {
	const resolved = behaviors.map((b) => withTests(repo, b));
	const outcomes = resolved.flatMap((b) => behaviorOutcomes(repo, b));
	const unique = (key) => [
		...new Set(outcomes.map((o) => o[key]).filter(Boolean)),
	];
	return {
		findings: unique("finding"),
		diagnostics: unique("diagnostic"),
		behaviors: resolved,
	};
};

/** The candidate's file tree and the files the slice changed, root-relative. */
const repoView = (root, base, candidate) => {
	const files = new Map();
	return {
		tree: new Set(
			pathList(root, [
				"ls-tree",
				"-r",
				"-z",
				"--name-only",
				"--full-tree",
				candidate,
			]),
		),
		changed: new Set(
			pathList(root, [
				"diff",
				"--name-only",
				"-z",
				"--no-renames",
				base,
				candidate,
			]),
		),
		sourceOf: (path) => {
			if (!files.has(path)) files.set(path, fileAt(root, candidate, path));
			return files.get(path);
		},
	};
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

/** One behavior's reprove-red.mjs calls on one revision: a `--test` per titled test,
    and one call without `--test` (every test the slice changed) for whole-file tests. */
const reproveAt = (candidate, b, sha) => {
	const call = `reprove: --commit ${candidate} --base ${sha}`;
	const titled = b.tests.filter((t) => t.title !== undefined);
	return [
		...titled.map(({ title, path }) => `${call} --test ${path}::${title}`),
		...(titled.length < b.tests.length ? [call] : []),
	];
};

/** reprove-red.mjs calls for the contract's non-pin tests, on each named red revision
    or else on the slice's base, so a slice of several commits re-proves all of them. */
const reprovePlan = (candidate, base, behaviors) => [
	...new Set(
		behaviors
			.filter((b) => !b.pin)
			.flatMap((b) =>
				(b.redAt.length ? b.redAt : [base]).flatMap((sha) =>
					reproveAt(candidate, b, sha),
				),
			),
	),
];

/** Throws unless the base is an ancestor of the candidate: a slice of several commits
    is fine, a base from another line of history is a broken call. */
const requireAncestor = (root, base, candidate, options) => {
	const ancestry = git(root, ["merge-base", "--is-ancestor", base, candidate]);
	if (ancestry.status === 1)
		throw new Error(
			`--base ${options.base} is not an ancestor of --candidate ${options.candidate}`,
		);
	if (ancestry.status !== 0)
		throw new Error(`git merge-base failed: ${ancestry.stderr.trim()}`);
};

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
	requireAncestor(root, base, candidate, options);
	return { root, candidate, base };
};

/** The slice's behaviors and TDD exemptions; throws when the contract has neither. A
    contract of TDD-exempt items only (a docs slice) has no behaviors and is checkable. */
const loadBehaviors = (options) => {
	const { behaviors, exempt } = parseTestContract(
		readFileSync(options.artifact, "utf-8"),
		options.slice,
	);
	if (behaviors.length === 0 && exempt.length === 0)
		throw new Error(
			`\`### Test Contract: ${options.slice}\` has no Behavior entries and no TDD-exempt item`,
		);
	return {
		behaviors,
		diagnostics: behaviors.length
			? []
			: [
					"diagnostic: every item of the contract is TDD-exempt: no test to check or re-prove",
				],
	};
};

const headline = (findings, unchecked) => {
	if (findings.length) return "findings";
	return unchecked.length ? "partial" : "clean";
};

/** The CLI's stdout and exit code for `argv`, run in `cwd`; throws on a broken call. */
const runCli = (argv, cwd) => {
	const options = parseArgs(argv);
	const { root, candidate, base } = resolveRepo(cwd, options);
	const { behaviors, diagnostics } = loadBehaviors(options);
	const tests = testChecks(repoView(root, base, candidate), behaviors);
	const findings = [
		...tests.findings,
		...redFindings(root, behaviors),
		...evidenceFindings(options.evidence, [base, candidate]),
	];
	const unchecked = behaviors.flatMap((b) =>
		b.unchecked.map((u) => `unchecked: ${b.id} line ${u.line}: ${u.text}`),
	);
	const lines = [
		`preflight: ${headline(findings, unchecked)}`,
		...findings.map((f) => `finding: ${f}`),
		...unchecked,
		...diagnostics,
		...tests.diagnostics,
		...reprovePlan(candidate, base, tests.behaviors),
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
