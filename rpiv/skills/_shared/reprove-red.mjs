// reprove-red.mjs — re-proves a slice's red (D23 of the risk-lanes design, S14, FR13).
// Rebuilds the slice commit's parent in a scratch copy under the git dir, writes only
// the slice's changed test and fixture files over it, runs the given command there and
// reports the outcome. The real index, HEAD, branch and working tree are never touched.
//
// CLI, run only as the entry point:
//   node reprove-red.mjs --commit <rev> [--base <rev>] [--test <path>::<name>]...
//                        [--link <path>]... [--timeout <seconds>] -- <executable> [args...]
// --base rebuilds that revision instead of the commit's parent (a red observed at an
// amended-away candidate, S19/D39); the applied tests stay the parent → commit diff.
// prints `reprove-red:`, `base:`, `test:`/`fixture:`, `exit:`, `log:` and last
// `result: red | green | no-tests`, exit 0. A broken call prints
// `reprove-red: broken: <detail>` on stderr and exits 2, never a result.
//
// Importable: exitCodeOf.

import { execFileSync, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { isFixture, isManifest, isTest } from "./source-vocab.mjs";

/** git's stdout as text, run in `cwd`; a failure throws one line naming git. */
const gitIn = (cwd, args, { env } = {}) => {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			env: env ? { ...process.env, ...env } : process.env,
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
const requireComplete = ({ commit, tests, command }) => {
	if (commit === undefined) throw new Error("missing --commit <rev>");
	if (command.length === 0) throw new Error("missing command after --");
	const hasReport = command.some((arg) => arg.includes("{junit}"));
	if (tests.length > 0 && !hasReport) {
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

/** Changed paths of parent → commit that a re-run applies: tests and fixtures. */
const slicePaths = (top, parent, commit) => {
	const fields = gitIn(top, [
		"diff-tree",
		"-r",
		"-z",
		"--no-commit-id",
		"--no-renames",
		"--name-status",
		parent,
		commit,
	])
		.split("\0")
		.filter(Boolean);
	const tests = [];
	const fixtures = [];
	const manifests = [];
	for (let i = 0; i < fields.length; i += 2) {
		const [status, path] = [fields[i], fields[i + 1]];
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

/** Checks the parent's tree out into `scratch` through a temporary index, then writes
    the slice's files over it from the commit. */
const buildScratch = (top, scratch, { parent, commit, paths }) => {
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	const env = { GIT_INDEX_FILE: `${scratch}.index` };
	gitIn(top, ["read-tree", parent], { env });
	gitIn(top, [`--work-tree=${scratch}`, "checkout-index", "-a", "-f"], { env });
	rmSync(env.GIT_INDEX_FILE, { force: true });
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
		mkdirSync(dirname(join(scratch, path)), { recursive: true });
		writeFileSync(join(scratch, path), bytes);
	}
};

/** True when `path` is `folder` or lies inside it. */
const within = (folder, path) => {
	const rel = relative(folder, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
const checkLink = (link, { cwd, top, scratch, gitDirs }) => {
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
	return { link, target, at: join(scratch, inside) };
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
const checkLinks = (linkArgs, { cwd, top, scratch }) => {
	const gitDirs = gitFolders(top);
	const links = linkArgs.map((link) =>
		checkLink(link, { cwd, top, scratch, gitDirs }),
	);
	refuseOverlaps(links);
	return links;
};

/** Directory links from `scratch` to the checkout's folders (Windows: junctions). */
const placeLinks = (links) => {
	for (const { target, at } of links) {
		rmSync(at, { recursive: true, force: true });
		mkdirSync(dirname(at), { recursive: true });
		symlinkSync(target, at, "junction");
	}
};

/** Removes the scratch copy: links first, so a removal never reaches a link target. */
const removeScratch = (scratch, links) => {
	for (const { at } of links) {
		if (isLink(at)) unlinkSync(at);
	}
	rmSync(scratch, { recursive: true, force: true });
};

const isLink = (path) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

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

/** Runs the command without a shell in `runDir`, its output in `log`; returns the exit
    code (see exitCodeOf). */
const runCommand = (command, runDir, log, timeout) => {
	const fd = openSync(log, "w");
	try {
		const result = spawnSync(command[0], command.slice(1), {
			cwd: runDir,
			stdio: ["ignore", fd, fd],
			timeout: timeout * 1000,
			windowsHide: true,
		});
		return exitCodeOf(result, command, timeout);
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

/** The `<testcase>` records of a JUnit report; a text with no suite element is broken. */
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
			skipped: /<skipped\b/.test(body),
		};
	});
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

/** The bucket of one named test: its matching records agree, disagree (`mixed`), or
    none exists — then a file-level failure (name = classname = path) is a load failure. */
const bucketOf = (records, { path, name }) => {
	const isNamed = nameMatcher(name, path);
	const matches = records.filter(
		(r) => r.classname === path && isNamed(r.name),
	);
	if (matches.length === 0) {
		const load = records.find(
			(r) => r.failure !== undefined && r.classname === path && r.name === path,
		);
		return load
			? { bucket: "failed-to-load", reason: load.failure }
			: { bucket: "not-found" };
	}
	const outcomes = new Set(matches.map(outcomeOf));
	if (outcomes.size > 1) return { bucket: "mixed" };
	const [bucket] = outcomes;
	return bucket === "failed"
		? { bucket, reason: matches[0].failure }
		: { bucket };
};

/** The `report:` line and one `test-result:` (plus `reason:`) per named test. A missing
    or unparsable report makes every named test `unavailable`, never a pass. */
const reportLines = (junit, named) => {
	const unavailable = named.map(({ id }) => `test-result: unavailable ${id}`);
	if (!existsSync(junit)) return ["report: missing", ...unavailable];
	let records;
	try {
		records = parseJunit(readFileSync(junit, "utf-8"));
	} catch (error) {
		return [
			`report: broken: ${String(error?.message ?? error).split("\n")[0]}`,
			...unavailable,
		];
	}
	return [
		`report: ${junit}`,
		...named.flatMap((test) => {
			const { bucket, reason } = bucketOf(records, test);
			const result = `test-result: ${bucket} ${test.id}`;
			return reason === undefined
				? [result]
				: [result, `reason: ${test.id}: ${reason}`];
		}),
	];
};

const lines = (list) => list.map((line) => `${line}\n`).join("");

const runCli = (argv, cwd) => {
	const {
		commit: rev,
		base: baseRev,
		tests: named,
		links: linkArgs,
		timeout,
		command,
	} = parseArgs(argv);
	const top = resolve(cwd, gitIn(cwd, ["rev-parse", "--show-toplevel"]).trim());
	const { commit, parent } = resolveCommit(cwd, rev);
	const base = baseRev === undefined ? parent : resolveRevision(cwd, baseRev);
	const { tests, fixtures, manifests } = slicePaths(top, parent, commit);
	const header = [
		`reprove-red: ${commit}`,
		`base: ${base}`,
		...tests.map((path) => `test: ${path}`),
		...fixtures.map((path) => `fixture: ${path}`),
		...manifests.map((path) => `diagnostic: dependencies changed: ${path}`),
	];
	const scratch = resolve(
		cwd,
		gitIn(cwd, [
			"rev-parse",
			"--git-path",
			// A run on another base keeps its own scratch copy, log and report.
			`rpiv/reprove-red/${baseRev === undefined ? commit : `${commit}-${base}`}`,
		]).trim(),
	);
	const links = checkLinks(linkArgs, { cwd, top, scratch });
	if (tests.length === 0) return lines([...header, "result: no-tests"]);
	const log = `${scratch}.log`;
	const junit = `${scratch}.junit.xml`;
	const testsFromCwd = tests.map((path) =>
		relative(cwd, join(top, path)).replace(/\\/g, "/"),
	);
	const args = command.flatMap((arg) =>
		arg === "{tests}" ? testsFromCwd : [arg.split("{junit}").join(junit)],
	);
	let code;
	rmSync(junit, { force: true }); // a report from an earlier run is never read
	try {
		buildScratch(top, scratch, {
			parent: base,
			commit,
			paths: [...tests, ...fixtures],
		});
		placeLinks(links);
		code = runCommand(args, join(scratch, relative(top, cwd)), log, timeout);
	} finally {
		removeScratch(scratch, links);
	}
	return lines([
		...header,
		`exit: ${code}`,
		`log: ${log}`,
		...(named.length > 0 ? reportLines(junit, named) : []),
		`result: ${code === 0 ? "green" : "red"}`,
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
