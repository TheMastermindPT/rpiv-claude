// reprove-red.mjs — re-proves a slice's red (D23 of the risk-lanes design, S14, FR13).
// Rebuilds the slice commit's parent in a scratch copy, writes the slice's changed test
// and fixture files over it (in a Python run, its whole changed test tree; see below),
// runs the given command there and reports the outcome. The real index, HEAD, branch and
// working tree are never touched. The scratch copy is a fresh, short folder in the
// system's temporary folder (never under the git dir: Windows' 260-character limit) and
// a git work tree checked out at the base, its objects borrowed from the repository, so a
// test that runs git there sees a repository; the runner never gets the caller's GIT_DIR
// and its kin. The log and the report stay under the git dir (rpiv issue drafts
// 20261123-151137-84f5c6f8, 20261123-151137-3491b4f7). A caller's folder outside the top
// folder (a junction to it, outside a Python run) is a broken call.
//
// CLI, run only as the entry point:
//   node reprove-red.mjs --commit <rev> [--base <rev>] [--test <path>::<name>]...
//                        [--link <path>]... [--timeout <seconds>] -- <executable> [args...]
// --base rebuilds that revision instead of the commit's parent: a red observed at an
// amended-away candidate (S19/D39), or the base of a slice of several commits. The
// applied tests are the diff from the merge base of that revision and the commit to the
// commit: the parent → commit diff for a one-commit slice or an amended-away sibling,
// and every commit's tests for a slice of several.
// prints `reprove-red:`, `base:`, `test:`/`fixture:`, `exit:`, `log:` and last
// `result: red | green | no-tests | broken: <why>`, exit 0. Outside a Python run any
// non-zero exit is red. In a Python run (S1-pytest-report: its runner tests are `.py`
// only) the line follows pytest's exit code: exit 5 prints `result: no-tests` after its
// `exit:` line, and exits 2, 3, 4, any unknown code, and exit 1 with no readable report
// print `result: broken: <why>`; a named test that report lacks then reads
// `unavailable`. A broken call (bad arguments, an unknown revision, a timeout, runner
// tests in Python and another language, a temporary folder inside the checkout) prints
// `reprove-red: broken: <detail>` on stderr and exits 2, with nothing on stdout.
//
// A Python run (S2-scratch-copy) copies wider: every changed test-tree file — tests,
// fixtures, `conftest.py` anywhere, and test-tree support outside a `src` folder — is
// written from the commit and printed as `test:` or `fixture:`, each deleted one is
// removed (`removed:`), and a submodule entry is left as the base had it
// (`diagnostic: submodule not copied:`). In a Python run `{tests}` expands to the Python
// runner tests only. Its runner gets the import guard (import-guard.mjs): a fresh guard
// folder outside the checkout first on PYTHONPATH, the run folder's `src/` second, and
// PYTHONDONTWRITEBYTECODE=1. Every guarded Python process records the modules it loaded,
// and the run line becomes `result: broken: imported from the checkout: <path>` when one
// came from a checkout folder of the repository, `result: broken: import guard did not
// run` when no record exists, and `result: broken: import record incomplete: pid <n>`
// when a record is unfinished, whatever pytest's exit code. A guarded process records a
// module when it opens its file for import as well as at exit (S2b-guard-proof), and a
// temporary folder inside the checkout is refused before the guard folder is made.
// In a Python run (S2c-copy-modes) a changed symlink is left as the base had it
// (`diagnostic: symlink not copied:`), a changed test-tree path inside a `src` folder that
// the copy does not take is named (`diagnostic: production test folder not copied:`), a
// folder replaced by a file is written as the file, and `--link` targets are placed by
// real paths. Outside a Python run the copy, the header and `{tests}` stay as they were.
// A call that names tests (S3 report, rpiv issue draft 20261123-174308-8fd52ed1) keeps its
// own log and report, named with a short hash of the named tests; in a Python run its
// `{tests}` is only the named tests' pytest node ids. When the run is red while a named
// test passed or was skipped, a `diagnostic:` line says the red came from the whole run.
//
// Importable: exitCodeOf.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	checkoutFolders,
	createGuard,
	guardEnv,
	importVerdict,
	realOf,
	within,
} from "./import-guard.mjs";
import { isMain } from "./is-main.mjs";
import {
	extOf,
	isFixture,
	isManifest,
	isPythonTest,
	isPythonTestSupport,
	isSource,
	isTest,
	isTestData,
	isTestTree,
} from "./source-vocab.mjs";

/** git's stdout as text, run in `cwd` with `env` (default: the caller's); a failure
    throws one line naming git. */
const gitIn = (cwd, args, { env = process.env } = {}) => {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		const why = String(error.stderr ?? error.message)
			.trim()
			.split("\n")[0];
		throw new Error(`git ${args[0]} failed: ${why}`);
	}
};

const DEFAULT_TIMEOUT_SECONDS = 600;

/** One `--test <path>::<name>` value as `{ path, name, id }`. */
const parseTest = (value) => {
	const at = value.indexOf("::");
	if (at <= 0 || at + 2 >= value.length) {
		throw new Error(`--test needs <path>::<name>, got: ${value}`);
	}
	return {
		path: value.slice(0, at).replace(/\\/g, "/"),
		name: value.slice(at + 2),
		id: value,
	};
};

/** A `--timeout` value as whole seconds; anything but a positive whole number is broken. */
const parseTimeout = (value) => {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error(
			`--timeout needs a positive whole number of seconds, got: ${value}`,
		);
	}
	return Number(value);
};

/** How each option stores its value. */
const OPTIONS = {
	"--commit": (parsed, value) => {
		parsed.commit = value;
	},
	"--base": (parsed, value) => {
		parsed.base = value;
	},
	"--test": (parsed, value) => {
		parsed.tests.push(parseTest(value));
	},
	"--link": (parsed, value) => {
		parsed.links.push(value);
	},
	"--timeout": (parsed, value) => {
		parsed.timeout = parseTimeout(value);
	},
};

/** A parsed call missing its commit or command, or naming tests with no report, is broken. */
const requireComplete = ({ commit, tests, command, promisesReport }) => {
	if (commit === undefined) throw new Error("missing --commit <rev>");
	if (command.length === 0) throw new Error("missing command after --");
	if (tests.length > 0 && !promisesReport) {
		throw new Error("--test needs {junit} in the command");
	}
};

/** The arguments before `--` as options, the rest as the command. Every option takes
    a value; an unknown option, a missing value or a bad value is broken. */
const parseArgs = (argv) => {
	const split = argv.indexOf("--");
	const options = split === -1 ? argv : argv.slice(0, split);
	const parsed = {
		commit: undefined,
		base: undefined,
		tests: [],
		links: [],
		timeout: DEFAULT_TIMEOUT_SECONDS,
		command: split === -1 ? [] : argv.slice(split + 1),
	};
	for (let i = 0; i < options.length; i += 2) {
		const [name, value] = [options[i], options[i + 1]];
		const store = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
		if (!store) throw new Error(`unknown option: ${name}`);
		if (value === undefined) throw new Error(`${name} needs a value`);
		store(parsed, value);
	}
	// One answer to "does the command promise a report": `--test` needs it, and a Python
	// run's exit 1 is red only when it is kept (D8).
	parsed.promisesReport = parsed.command.some((arg) => arg.includes("{junit}"));
	requireComplete(parsed);
	return parsed;
};

/** The full SHA of the commit `rev` names; an unknown revision is broken. */
const resolveRevision = (cwd, rev) => {
	let sha;
	try {
		sha = gitIn(cwd, [
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${rev}^{commit}`,
		]).trim();
	} catch {
		sha = "";
	}
	if (!sha) throw new Error(`unknown revision: ${rev}`);
	return sha;
};

/** The full SHA of `rev` and its only parent; any other parent count is broken. */
const resolveCommit = (cwd, rev) => {
	const commit = resolveRevision(cwd, rev);
	const parents = gitIn(cwd, ["rev-list", "--parents", "-n", "1", commit])
		.trim()
		.split(" ")
		.slice(1);
	if (parents.length === 0) throw new Error(`${commit} has no parent`);
	if (parents.length > 1)
		throw new Error(`${commit} has ${parents.length} parents`);
	return { commit, parent: parents[0] };
};

/** The changes of `parent` → commit, one `{ status, path, submodule }` each; a
    submodule entry has mode 160000 on either side. */
const changesOf = (top, parent, commit) => {
	const fields = gitIn(top, [
		"diff-tree",
		"-r",
		"-z",
		"--no-commit-id",
		"--no-renames",
		parent,
		commit,
	])
		.split("\0")
		.filter(Boolean);
	const changes = [];
	for (let i = 0; i < fields.length; i += 2) {
		// `:<old mode> <new mode> <old sha> <new sha> <status>`, then the path.
		const [oldMode, newMode, , , status] = fields[i].slice(1).split(" ");
		const either = (mode) => oldMode === mode || newMode === mode;
		changes.push({
			status,
			path: fields[i + 1],
			submodule: either("160000"),
			symlink: either("120000"),
		});
	}
	return changes;
};

/** Changed paths that a re-run applies: tests and fixtures. */
const slicePaths = (changes) => {
	const tests = [];
	const fixtures = [];
	const manifests = [];
	for (const { status, path } of changes) {
		if (isManifest(path)) manifests.push(path);
		if (status === "D") continue;
		if (isTest(path)) tests.push(path);
		else if (isFixture(path)) fixtures.push(path);
	}
	return {
		tests: tests.sort(),
		fixtures: fixtures.sort(),
		manifests: manifests.sort(),
	};
};

/** A Python run's copy (FR8, D16, D17, D28): every changed test-tree path, written from
    the commit or removed when deleted; a submodule entry or a symlink is neither, only
    named. A test-tree path inside a `src` folder that the copy does not take is named
    too (B27). */
const pythonCopy = (changes) => {
	const inSet = ({ path }) => isFixture(path) || isPythonTestSupport(path);
	const set = changes.filter(inSet);
	const sorted = (list) => list.map(({ path }) => path).sort();
	const plain = set.filter((c) => !c.submodule && !c.symlink);
	return {
		written: sorted(plain.filter((c) => c.status !== "D")),
		removed: sorted(plain.filter((c) => c.status === "D")),
		submodules: sorted(set.filter((c) => c.submodule)),
		symlinks: sorted(set.filter((c) => c.symlink && !c.submodule)),
		production: sorted(changes.filter((c) => !inSet(c) && isTestTree(c.path))),
	};
};

/** What the scratch copy takes, what `{tests}` expands to and what the header lists:
    today's tests and fixtures outside a Python run (D13); in one, the wider Python copy
    and only the Python runner tests in `{tests}` (D14). Each path is listed once. */
const copyPlan = (changes, { tests, fixtures, manifests }, python) => {
	const dependencies = manifests.map(
		(path) => `diagnostic: dependencies changed: ${path}`,
	);
	if (!python) {
		return {
			tests,
			paths: [...tests, ...fixtures],
			removed: [],
			lines: [
				...tests.map((path) => `test: ${path}`),
				...fixtures.map((path) => `fixture: ${path}`),
				...dependencies,
			],
		};
	}
	const runners = tests.filter(
		(path) => !isTestData(path) && isPythonTest(path),
	);
	const { written, removed, submodules, symlinks, production } =
		pythonCopy(changes);
	const named = (what, list) =>
		list.map((path) => `diagnostic: ${what} not copied: ${path}`);
	return {
		tests: runners,
		paths: written,
		removed,
		lines: [
			...runners.map((path) => `test: ${path}`),
			...written
				.filter((path) => !runners.includes(path))
				.map((path) => `fixture: ${path}`),
			...removed.map((path) => `removed: ${path}`),
			...named("submodule", submodules),
			...named("symlink", symlinks),
			...named("production test folder", production),
			...dependencies,
		],
	};
};

/** Makes the empty folder `scratch` a git repository checked out at `parent`: its own
    `.git` (no hooks; the repository's objects borrowed, nothing copied), HEAD detached at
    `parent` and an index matching the files, so a test that runs git there (`git
    check-ignore`) sees a work tree like the real one. The files are written with the
    repository's own settings, long paths allowed. */
const checkoutBase = (top, scratch, parent) => {
	const objects = resolve(
		top,
		gitIn(top, ["rev-parse", "--git-path", "objects"]).trim(),
	);
	// Never the caller's GIT_DIR: init and update-ref would act on the real repository.
	const own = { env: runnerEnv(process.env) };
	gitIn(scratch, ["init", "--quiet", "--template="], own);
	writeFileSync(
		join(scratch, ".git", "objects", "info", "alternates"),
		`${objects.replace(/\\/g, "/")}\n`,
	);
	gitIn(scratch, ["update-ref", "--no-deref", "HEAD", parent], own);
	const env = {
		...process.env,
		GIT_INDEX_FILE: join(scratch, ".git", "index"),
	};
	gitIn(top, ["read-tree", parent], { env });
	gitIn(
		top,
		[
			"-c",
			"core.longpaths=true",
			`--work-tree=${scratch}`,
			"checkout-index",
			"-a",
			"-f",
		],
		{ env },
	);
};

/** Checks the parent's tree out into the empty folder `scratch` (checkoutBase), removes
    the slice's deleted paths, then writes the slice's files over it from the commit. */
const buildScratch = (top, scratch, { parent, commit, paths, removed }) => {
	checkoutBase(top, scratch, parent);
	for (const path of removed) {
		rmSync(join(scratch, path), { recursive: true, force: true });
	}
	for (const path of paths) {
		const bytes = execFileSync(
			"git",
			["cat-file", "blob", `${commit}:${path}`],
			{
				cwd: top,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		const at = join(scratch, path);
		mkdirSync(dirname(at), { recursive: true });
		// A folder replaced by a file in a Python run (B29); only removals empty it.
		if (removed.length > 0 && lstatSafe(at)?.isDirectory()) {
			rmSync(at, { recursive: true, force: true });
		}
		writeFileSync(at, bytes);
	}
};

/** The folders a link must stay out of: `.git` at the top, the git dir, the common git dir. */
const gitFolders = (top) => [
	join(top, ".git"),
	...["--absolute-git-dir", "--git-common-dir"].map((flag) =>
		resolve(top, gitIn(top, ["rev-parse", flag]).trim()),
	),
];

/** One link, checked alone: its target exists, lies inside the repository (not the
    repository folder itself), stays out of the git folders, and holds no tracked file. */
const checkLink = (link, { cwd, top, gitDirs }) => {
	const target = resolve(cwd, link);
	if (!existsSync(target)) throw new Error(`link target missing: ${link}`);
	const inside = relative(top, target);
	if (!inside || !within(top, target)) {
		throw new Error(`link target outside the repository: ${link}`);
	}
	if (gitDirs.some((dir) => within(dir, target))) {
		throw new Error(`link target inside the git folder: ${link}`);
	}
	const tracked = gitIn(top, [
		"ls-files",
		"-z",
		"--",
		inside.replace(/\\/g, "/"),
	]);
	if (tracked) throw new Error(`link target holds tracked files: ${link}`);
	return { link, target, inside };
};

/** Two links where one target is or holds the other would let one link's placement
    reach through the other into the checkout, so they are broken. */
const refuseOverlaps = (links) => {
	links.forEach((a, i) => {
		for (const b of links.slice(i + 1)) {
			if (within(a.target, b.target) || within(b.target, a.target)) {
				throw new Error(`link targets overlap: ${a.link}, ${b.link}`);
			}
		}
	});
};

/** The links to place, checked before anything is removed or created, so a link never
    maps outside the scratch copy, reaches the checkout, or hides predecessor code. */
const checkLinks = (linkArgs, { cwd, top }) => {
	const gitDirs = gitFolders(top);
	const links = linkArgs.map((link) => checkLink(link, { cwd, top, gitDirs }));
	refuseOverlaps(links);
	return links;
};

/** Directory links from `scratch` to the checkout's folders (Windows: junctions). */
const placeLinks = (links, scratch) => {
	for (const { target, inside } of links) {
		const at = join(scratch, inside);
		rmSync(at, { recursive: true, force: true });
		mkdirSync(dirname(at), { recursive: true });
		symlinkSync(target, at, "junction");
	}
};

/** Removes the scratch copy: links first, so a removal never reaches a link target. */
const removeScratch = (scratch, links) => {
	for (const { inside } of links) {
		const at = join(scratch, inside);
		if (isLink(at)) unlinkSync(at);
	}
	rmSync(scratch, { recursive: true, force: true });
};

/** The lstat of `path`, or undefined when it does not exist. */
const lstatSafe = (path) => {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
};

const isLink = (path) => lstatSafe(path)?.isSymbolicLink() ?? false;

/** The exit code of a `spawnSync` result. A command that cannot start or outlives
    `timeout` seconds is broken. */
export const exitCodeOf = (result, command, timeout) => {
	if (result.error?.code === "ETIMEDOUT")
		throw new Error(`timed out after ${timeout}s`);
	if (result.error)
		throw new Error(
			`cannot start: ${command[0]} (${result.error.code ?? result.error.message})`,
		);
	// A runner killed by a signal has no exit code (POSIX; Windows reports a code).
	if (result.status === null) {
		throw new Error(`runner ended without an exit code (${result.signal})`);
	}
	return result.status;
};

// The variables that point git at a repository. The runner runs in the scratch copy, so a
// test that runs git there must find the scratch repository, never the caller's (a git
// hook sets GIT_INDEX_FILE and GIT_DIR).
const GIT_LOCATION = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
	"GIT_NAMESPACE",
]);

/** `env` without the GIT_LOCATION variables (any case). */
const runnerEnv = (env) =>
	Object.fromEntries(
		Object.entries(env).filter(([key]) => !GIT_LOCATION.has(key.toUpperCase())),
	);

/** Runs the command (`args`) without a shell in `runDir` with `env`, its output in
    `log`; returns the exit code (see exitCodeOf). */
const runCommand = ({ args, log, timeout }, runDir, env) => {
	const fd = openSync(log, "w");
	try {
		const result = spawnSync(args[0], args.slice(1), {
			cwd: runDir,
			env,
			stdio: ["ignore", fd, fd],
			timeout: timeout * 1000,
			windowsHide: true,
		});
		return exitCodeOf(result, args, timeout);
	} finally {
		closeSync(fd);
	}
};

// ---- JUnit report (mechanical per-test buckets; no judgment of failure reasons) ----

const ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** Text with XML character and entity references decoded. */
const decode = (text) =>
	text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
		if (ref[0] !== "#") return ENTITIES[ref] ?? whole;
		const hex = ref[1].toLowerCase() === "x";
		return String.fromCodePoint(
			Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10),
		);
	});

/** The attributes of one start tag's text, decoded. */
const attributes = (text) =>
	Object.fromEntries(
		[...text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [
			m[1],
			decode(m[2] ?? m[3]),
		]),
	);

const CASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const FAULT_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;

/** The first line of a `<failure>`/`<error>`: its message, else its text. */
const faultMessage = ([, , attrText, inner = ""]) =>
	(attributes(attrText).message || decode(inner))
		.trim()
		.split(/\r?\n/)[0]
		.trim();

/** The `<testcase>` records of a JUnit report; a text with no suite element is broken.
    `fault` keeps a `<failure>`/`<error>`'s message attribute and decoded body. */
const parseJunit = (text) => {
	if (!/<testsuites?\b/.test(text))
		throw new Error("no <testsuites> or <testsuite> element");
	if (!/<\/testsuites?>\s*$/.test(text)) throw new Error("unterminated report");
	return [...text.matchAll(CASE_RE)].map(([, attrText, body = ""]) => {
		const { classname = "", name = "" } = attributes(attrText);
		const fault = body.match(FAULT_RE);
		return {
			classname: classname.replace(/\\/g, "/"),
			name,
			failure: fault ? faultMessage(fault) : undefined,
			fault: fault && {
				message: attributes(fault[2]).message ?? "",
				body: decode(fault[3] ?? ""),
			},
			skipped: /<skipped\b/.test(body),
		};
	});
};

// A pytest traceback marker line: `E` then whitespace or nothing, never `E:\…` (D9).
const PYTEST_MARKER = /^E(\s|$)/;

/** A pytest load failure's reason (D9): the last marker line with text after the
    marker, else the body's first non-blank line, else the fault's message's first
    line, so a reason is always one stdout line. */
const pytestFaultReason = ({ message, body }) => {
	const bodyLines = body.split("\n").map((line) => line.replace(/\r$/, ""));
	const marked = bodyLines
		.filter((line) => PYTEST_MARKER.test(line))
		.map((line) => line.slice(1).replace(/^\s+/, ""))
		.filter((text) => text.trim() !== "");
	if (marked.length > 0) return marked.at(-1);
	const first = bodyLines.find((line) => line.trim() !== "");
	return (first ?? message).trim().split(/\r?\n/)[0].trim();
};

const outcomeOf = (record) =>
	record.failure !== undefined
		? "failed"
		: record.skipped
			? "skipped"
			: "passed";

// A test runner's title placeholders (vitest/jest `it.each`): printf-style and
// `$name` / `$a.b` interpolation; `%%` is a literal percent (S19, D39).
const PLACEHOLDER = /%%|%[sdifjoOp#]|\$[A-Za-z_][\w.]*/g;
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeRegExp = (text) => text.replace(REGEXP_SPECIAL, (ch) => `\\${ch}`);

// One placeholder's value: one or more characters, never across a ` > ` nesting
// (S19 revision 1).
const PLACEHOLDER_VALUE = "(?:(?! > ).)+";

/** Whether a report case's name, in the file `path`, is the test `wanted` names: the
    whole name or the part after a ` > `; each placeholder in `wanted` stands for one
    or more characters, and never matches the file-level load record (name = path),
    so a load failure stays `failed-to-load` (S19 revision 1). */
const nameMatcher = (wanted, path) => {
	const found = [...wanted.matchAll(PLACEHOLDER)];
	if (found.length === 0) {
		return (name) => name === wanted || name.endsWith(` > ${wanted}`);
	}
	let pattern = "";
	let last = 0;
	for (const match of found) {
		pattern += escapeRegExp(wanted.slice(last, match.index));
		pattern += match[0] === "%%" ? "%" : PLACEHOLDER_VALUE;
		last = match.index + match[0].length;
	}
	pattern += escapeRegExp(wanted.slice(last));
	const title = new RegExp(`^(?:.* > )?${pattern}$`, "s");
	return (name) => name !== path && title.test(name);
};

/** A vitest/jest record of the test: its classname is the file path. */
const pathRecordMatcher = ({ path, name }) => {
	const isNamed = nameMatcher(name, path);
	return (r) => r.classname === path && isNamed(r.name);
};

/** A `.py` test path's dotted form: `src/pkg/test_mod.py` → `src.pkg.test_mod`. */
const dottedOf = (path) => path.slice(0, -".py".length).replaceAll("/", ".");

/** A pytest record of the test, matched forward from the `--test` path (D1): the
    classname is the path's dotted form, plus the classes when the name gives them; the
    function's name may carry a `[…]` case id unless the wanted name has its own. */
const pytestRecordMatcher = ({ path, name }) => {
	const dotted = dottedOf(path);
	// Split on `::` only before the first `[`: a case id may hold `::` itself.
	const bracket = name.indexOf("[");
	const head = bracket < 0 ? name : name.slice(0, bracket);
	const parts = head.split("::");
	const fn = parts.at(-1) + name.slice(head.length);
	const classes = parts.slice(0, -1);
	const inClass =
		classes.length === 0
			? (c) => c === dotted || c.startsWith(`${dotted}.`)
			: (c) => c === [dotted, ...classes].join(".");
	const isNamed = fn.includes("[")
		? (n) => n === fn
		: (n) => n === fn || (n.startsWith(`${fn}[`) && n.endsWith("]"));
	return (r) => inClass(r.classname) && isNamed(r.name);
};

/** The reason a vitest file failed to load: a failed record named after the file, whose
    classname is the file too; undefined when the file loaded. */
const pathLoadReason = (records, { path }) =>
	records.find(
		(r) => r.failure !== undefined && r.classname === path && r.name === path,
	)?.failure;

/** The reason a pytest file failed to load: a record with an empty classname, named
    after the file's dotted form, holding a fault (D9); undefined when the file loaded. */
const pytestLoadReason = (records, { path }) => {
	const dotted = dottedOf(path);
	const load = records.find(
		(r) => r.fault && r.classname === "" && r.name === dotted,
	);
	return load && pytestFaultReason(load.fault);
};

// How a named test is found in the report, chosen by its path's extension (D2).
const PYTEST_DIALECT = {
	matcher: pytestRecordMatcher,
	loadReason: pytestLoadReason,
};
const PATH_DIALECT = { matcher: pathRecordMatcher, loadReason: pathLoadReason };
const dialectOf = (test) =>
	extOf(test.path) === "py" ? PYTEST_DIALECT : PATH_DIALECT;

/** The bucket of one named test: its matching records agree, disagree (`mixed`), or
    none exists — then the file's load failure, if any, is `failed-to-load`. */
const bucketOf = (records, test) => {
	const dialect = dialectOf(test);
	const matches = records.filter(dialect.matcher(test));
	if (matches.length === 0) {
		const reason = dialect.loadReason(records, test);
		return reason === undefined
			? { bucket: "not-found" }
			: { bucket: "failed-to-load", reason };
	}
	const outcomes = new Set(matches.map(outcomeOf));
	if (outcomes.size > 1) return { bucket: "mixed" };
	const [bucket] = outcomes;
	return bucket === "failed"
		? { bucket, reason: matches[0].failure }
		: { bucket };
};

/** The report at `junit`, read once: `{ records }`, or `{ line }` naming why it cannot
    be read (`report: missing`, `report: broken: <why>`). */
const readReport = (junit) => {
	if (!existsSync(junit)) return { line: "report: missing" };
	try {
		return { records: parseJunit(readFileSync(junit, "utf-8")) };
	} catch (error) {
		return {
			line: `report: broken: ${String(error?.message ?? error).split("\n")[0]}`,
		};
	}
};

/** The `report:` line and one `test-result:` (plus `reason:`) per named test. A missing
    or unparsable report makes every named test `unavailable`, never a pass. Under a
    `broken` run line, a named test the report lacks is `unavailable`, not `not-found`. */
const reportLines = (junit, report, named, broken) => {
	const unavailable = named.map(({ id }) => `test-result: unavailable ${id}`);
	if (!report.records) return [report.line, ...unavailable];
	const { records } = report;
	return [
		`report: ${junit}`,
		...named.flatMap((test) => {
			const { bucket: found, reason } = bucketOf(records, test);
			const bucket = broken && found === "not-found" ? "unavailable" : found;
			const result = `test-result: ${bucket} ${test.id}`;
			return reason === undefined
				? [result]
				: [result, `reason: ${test.id}: ${reason}`];
		}),
	];
};

const lines = (list) => list.map((line) => `${line}\n`).join("");

// ---- pytest dialect (S1-pytest-report) ----

/** The language of a slice's runner tests (changed tests that are not test data):
    `python` (Python only), `mixed` (Python and another source language) or `other`. */
const runnerLanguage = (tests) => {
	const runners = tests.filter((path) => !isTestData(path));
	const python = runners.some(isPythonTest);
	const other = runners.some((path) => extOf(path) !== "py" && isSource(path));
	if (!python) return "other";
	return other ? "mixed" : "python";
};

// pytest's exit codes 2–4 (pytest.ExitCode); 0, 1 and 5 have run lines of their own.
const PYTEST_EXIT = {
	2: "collection error or interrupted",
	3: "internal error",
	4: "usage error",
};

/** A Python run's run line, from pytest's exit code. An exit 1 is red only when the
    report it promised can be read (`readable`). */
const pytestRunLine = (code, readable) => {
	if (code === 0) return "result: green";
	if (code === 5) return "result: no-tests";
	if (code === 1) {
		return readable
			? "result: red"
			: "result: broken: exit 1 (pytest: no readable report)";
	}
	const why = Object.hasOwn(PYTEST_EXIT, code)
		? PYTEST_EXIT[code]
		: "unknown exit code";
	return `result: broken: exit ${code} (pytest: ${why})`;
};

/** The run line: pytest's meanings for a Python run, else non-zero is red. */
const runLineOf = (code, { python, promisesReport, report }) =>
	python
		? pytestRunLine(code, !promisesReport || report.records !== undefined)
		: `result: ${code === 0 ? "green" : "red"}`;

/** The top folder and the caller's folder that the run folder and `{tests}` are placed
    by: real paths in a Python run, so a caller in a junction to the top folder runs inside
    the copy with matching `{tests}`; as given otherwise, as before S2. */
const placesOf = (top, cwd, python) =>
	python ? { top: realOf(top), cwd: realOf(cwd) } : { top, cwd };

/** Builds the scratch copy in a fresh folder of the system's temporary folder (short,
    outside the git dir), places the links and runs the command in the caller's folder of
    it (`place`, see placesOf); returns `{ code, verdict }`. A Python run gets a fresh guard folder and the guarded environment (D11, D18), and a
    temporary folder inside a checkout folder is broken before anything is made (D23); its
    records are judged before cleanup (`verdict`: the guard's run line, or undefined). The
    scratch copy and the guard folder are removed whatever happens, the guard folder even
    when the scratch removal throws. */
const rerun = ({ top, place, build, links, python, run }) => {
	const checkouts = python ? checkoutFolders(top) : [];
	const keep = links.map(({ target }) => target);
	const guard = python ? createGuard(checkouts, keep) : undefined;
	let scratch;
	try {
		scratch = realOf(mkdtempSync(join(tmpdir(), "rpiv-rr-")));
		buildScratch(top, scratch, build);
		placeLinks(links, scratch);
		const runDir = join(scratch, relative(place.top, place.cwd));
		const env = runnerEnv(
			guard
				? guardEnv(guard, { runDir, hasSrc: existsSync(join(runDir, "src")) })
				: process.env,
		);
		const code = runCommand(run, runDir, env);
		const verdict =
			guard &&
			importVerdict({
				recordsDir: join(guard, "records"),
				checkouts,
				exempt: [scratch, guard, ...links.map(({ target }) => target)],
				top,
			});
		return { code, verdict };
	} finally {
		try {
			if (scratch) removeScratch(scratch, links);
		} finally {
			if (guard) rmSync(guard, { recursive: true, force: true });
		}
	}
};

/** The log and report path stem, under the git dir: one per commit, plus the base when
    `--base` names one, plus a short hash of the named tests when there are any, so two
    calls naming different tests on one pair never share a log (rpiv issue draft
    20261123-174308-8fd52ed1). */
const outputOf = (cwd, { commit, base, baseRev, named }) => {
	const pair = baseRev === undefined ? commit : `${commit}-${base}`;
	const ids = named.map(({ id }) => id).sort();
	const suffix = ids.length
		? `-${createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 8)}`
		: "";
	const stem = `rpiv/reprove-red/${pair}${suffix}`;
	return resolve(cwd, gitIn(cwd, ["rev-parse", "--git-path", stem]).trim());
};

/** What `{tests}` expands to, relative to the caller's folder: the plan's tests; in a
    Python run that names tests, only those tests as pytest node ids (`<path>::<name>`), so
    the run, its report and its run line cover what was named. */
const selectionOf = (planTests, named, { place, python }) => {
	const fromCwd = (path) =>
		relative(place.cwd, join(place.top, path)).replace(/\\/g, "/");
	if (!python || named.length === 0) return planTests.map(fromCwd);
	return [
		...new Set(named.map(({ path, name }) => `${fromCwd(path)}::${name}`)),
	];
};

const PASSED_OR_SKIPPED = /^test-result: (?:passed|skipped) (.*)$/;

/** A `diagnostic:` line when the run is red but a named test passed or was skipped: the
    run line is the whole run's, so that red came from other tests and the named test is
    not re-proved red (rpiv issue draft 20261123-174308-8fd52ed1). */
const redElsewhere = (results, runLine) => {
	if (runLine !== "result: red") return [];
	const notRed = results
		.map((line) => PASSED_OR_SKIPPED.exec(line)?.[1])
		.filter(Boolean);
	return notRed.length
		? [
				`diagnostic: result: red is the whole run's; these named tests passed or were skipped, so they are not re-proved red: ${notRed.join(", ")}`,
			]
		: [];
};

/** The places (placesOf) and the checked links of a run. A Python run checks and places
    links by real paths, like its run folder (D29). The run folder is the caller's folder
    inside the scratch copy, so a caller outside the top folder (a junction to it, outside
    a Python run) is broken: it would run somewhere else. */
const checkedPlaces = ({ top, cwd, python, linkArgs }) => {
	const place = placesOf(top, cwd, python);
	const links = checkLinks(linkArgs, place);
	if (!within(place.top, place.cwd)) {
		throw new Error(`caller's folder outside the top folder: ${place.cwd}`);
	}
	return { place, links };
};

const runCli = (argv, cwd) => {
	const {
		commit: rev,
		base: baseRev,
		tests: named,
		links: linkArgs,
		timeout,
		command,
		promisesReport,
	} = parseArgs(argv);
	const top = resolve(cwd, gitIn(cwd, ["rev-parse", "--show-toplevel"]).trim());
	const { commit, parent } = resolveCommit(cwd, rev);
	const base = baseRev === undefined ? parent : resolveRevision(cwd, baseRev);
	const from =
		baseRev === undefined
			? parent
			: gitIn(cwd, ["merge-base", base, commit]).trim();
	const changes = changesOf(top, from, commit);
	const sliced = slicePaths(changes);
	const { tests } = sliced;
	const language = runnerLanguage(tests);
	if (language === "mixed") {
		throw new Error(
			"tests in Python and another language need one run per runner",
		);
	}
	const plan = copyPlan(changes, sliced, language === "python");
	const header = [`reprove-red: ${commit}`, `base: ${base}`, ...plan.lines];
	const output = outputOf(cwd, { commit, base, baseRev, named });
	const python = language === "python";
	const { place, links } = checkedPlaces({ top, cwd, python, linkArgs });
	if (tests.length === 0) return lines([...header, "result: no-tests"]);
	mkdirSync(dirname(output), { recursive: true });
	const log = `${output}.log`;
	const junit = `${output}.junit.xml`;
	const selected = selectionOf(plan.tests, named, { place, python });
	const args = command.flatMap((arg) =>
		arg === "{tests}" ? selected : [arg.split("{junit}").join(junit)],
	);
	rmSync(junit, { force: true }); // a report from an earlier run is never read
	const { code, verdict } = rerun({
		top,
		place,
		build: { parent: base, commit, paths: plan.paths, removed: plan.removed },
		links,
		python,
		run: { args, log, timeout },
	});
	const report = readReport(junit);
	// The guard's line wins over pytest's in a Python run (S2-scratch-copy).
	const runLine =
		verdict ?? runLineOf(code, { python, promisesReport, report });
	const results =
		named.length > 0
			? reportLines(junit, report, named, runLine.startsWith("result: broken:"))
			: [];
	return lines([
		...header,
		`exit: ${code}`,
		`log: ${log}`,
		...results,
		...redElsewhere(results, runLine),
		runLine,
	]);
};

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (error) {
		// A broken call never prints a result (degrade-distinguishes-broken).
		const detail = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`reprove-red: broken: ${detail}\n`);
		process.exitCode = 2;
	}
}
