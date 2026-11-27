// tests/import-guard.test.mjs — contract tests for skills/_shared/import-guard.mjs, the
// record reader and checkout test of a Python re-run (slice S2-scratch-copy of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md), called directly.

import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	git,
	newRepo,
	put,
	ROOT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

// import-guard.mjs is loaded inside the tests, so a re-proof at a base without it reads
// per-test failures, not a file that fails to load (D26, S2b-guard-proof).
let checkoutFolders;
let importVerdict;
let realOf;
let guardScript;
beforeEach(async () => {
	({ checkoutFolders, importVerdict, realOf, guardScript } = await import(
		"../skills/_shared/import-guard.mjs"
	));
});

const slash = (path) => path.replaceAll("\\", "/");
const CHECKOUT = "result: broken: imported from the checkout: ";

/** A checkout folder, its scratch copy (under the git dir), a guard folder, a folder
    outside every checkout, and the records folder the guard writes into. */
const world = () => {
	const top = realOf(tempDir());
	const scratch = join(top, ".git/rpiv/reprove-red/abc");
	mkdirSync(scratch, { recursive: true });
	const guard = realOf(tempDir());
	const records = join(guard, "records");
	mkdirSync(records);
	const outside = realOf(tempDir());
	return { top, scratch, guard, records, outside };
};

/** One record file's text: `start:`, `role:` and `ppid:`, the package and module lines,
    `end:` (left out when `end` is false). */
const record = ({
	modules = [],
	packages = [],
	pid = 10,
	role = "root",
	eol = "\n",
	end = true,
}) =>
	[
		`start: ${pid}`,
		`role: ${role}`,
		"ppid: 1",
		...packages.map((path) => `package: ${path}`),
		...modules.map((path) => `module: ${path}`),
		...(end ? [`end: ${pid}`] : []),
		"",
	].join(eol);

/** Writes `files` (`{ name: text }`) into the world's records folder and `claim` (the
    root claim's text; null for none) beside it; returns the judge's inputs. */
const judged = (
	w,
	files,
	{ checkouts = [w.top], links = [], claim = "10" },
) => {
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(w.records, name), text);
	}
	if (claim !== null) writeFileSync(join(w.guard, "root"), claim);
	return {
		recordsDir: w.records,
		checkouts,
		exempt: [w.scratch, w.guard, ...links],
		top: w.top,
	};
};

/** The verdict on `files` written into the world's records folder (see judged). */
const verdictOn = (w, files, options = {}) =>
	importVerdict(judged(w, files, options));

const SRC_INIT = `${CHECKOUT}src/demo/__init__.py`;
// B18: [label, the row's inputs in a fresh world, expected verdict (undefined: S1's line)]
const B18_ROWS = [
	[
		"checkout, first in reading order",
		(w) => ({
			modules: [
				join(w.top, "src/demo/util.py"),
				join(w.top, "src/demo/__init__.py"),
			],
		}),
		`${CHECKOUT}src/demo/util.py`,
	],
	[
		"checkout",
		(w) => ({ modules: [join(w.top, "src/demo/__init__.py")] }),
		SRC_INIT,
	],
	[
		"scratch",
		(w) => ({ modules: [join(w.scratch, "src/demo/__init__.py")] }),
		undefined,
	],
	[
		"guard",
		(w) => ({ modules: [join(w.guard, "sitecustomize.py")] }),
		undefined,
	],
	[
		"link target",
		(w) => ({
			modules: [join(w.top, ".venv/Lib/site-packages/x.py")],
			links: [join(w.top, ".venv")],
		}),
		undefined,
	],
	[
		"package folder inside the checkout",
		(w) => ({
			modules: [join(w.top, ".venv/Lib/site-packages/x.py")],
			packages: [join(w.top, ".venv/Lib/site-packages")],
		}),
		undefined,
	],
	[
		"checkout beside an inner package folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [join(w.top, ".venv/Lib/site-packages")],
		}),
		SRC_INIT,
	],
	[
		"a venv made in the top folder",
		(w) => ({
			modules: [join(w.top, "Lib/site-packages/_pytest/x.py")],
			packages: [join(w.top, "Lib/site-packages")],
		}),
		undefined,
	],
	[
		"package folder equal to the top folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [w.top],
		}),
		SRC_INIT,
	],
	[
		"package folder holding the top folder",
		(w) => ({
			modules: [join(w.top, "src/demo/__init__.py")],
			packages: [dirname(w.top)],
		}),
		SRC_INIT,
	],
	["sibling folder", (w) => ({ modules: [`${w.top}2/x.py`] }), undefined],
	[
		"outside the repository",
		(w) => ({ modules: [join(w.outside, "x.py")] }),
		undefined,
	],
	[
		"a folder named ..cache in the checkout",
		(w) => ({ modules: [join(w.top, "..cache/x.py")] }),
		`${CHECKOUT}..cache/x.py`,
	],
];

const DID_NOT_RUN = "result: broken: import guard did not run";
// From S2b on the incomplete line names the pid (D24, B25).
const INCOMPLETE = "result: broken: import record incomplete: pid ";
// B19 and B25: [label, the row's record files in a fresh world, expected verdict]
const B19_ROWS = [
	["none", () => ({}), DID_NOT_RUN],
	["one empty file", () => ({ a: "" }), `${INCOMPLETE}unknown`],
	["only start", () => ({ a: "start: 10\n" }), `${INCOMPLETE}10`],
	[
		"a clean file and one with no end",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }),
			b: `start: 11\nmodule: ${join(w.scratch, "y.py")}\n`,
		}),
		`${INCOMPLETE}11`,
	],
	[
		"garbage before end",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }).replace(
				"end: 10",
				"garbage\nend: 10",
			),
		}),
		`${INCOMPLETE}10`,
	],
	[
		"end with another pid",
		() => ({ a: "start: 10\nend: 11\n" }),
		`${INCOMPLETE}10`,
	],
	[
		"two incomplete files name the first in name order",
		() => ({ a: "start: 12\n", b: "start: 11\n" }),
		`${INCOMPLETE}12`,
	],
	[
		"a first line that is not a start line",
		() => ({ a: "start: x\nend: 10\n" }),
		`${INCOMPLETE}unknown`,
	],
	[
		"an unfinished file naming a checkout module",
		(w) => ({
			a: `start: 10\nmodule: ${join(w.top, "src/demo/__init__.py")}\n`,
		}),
		SRC_INIT,
	],
	[
		"two clean files, a root and a child",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }),
			b: record({ modules: [join(w.scratch, "y.py")], pid: 11, role: "child" }),
		}),
		undefined,
	],
	[
		"a clean file with CRLF lines",
		(w) => ({ a: record({ modules: [join(w.scratch, "x.py")], eol: "\r\n" }) }),
		undefined,
	],
];

describe("import guard: record reader and checkout test (S2-scratch-copy)", () => {
	it("B18: a module from any checkout folder makes the run broken; the scratch copy, the guard, links, inner package folders, siblings and outside files do not", () => {
		for (const [label, inputs, want] of B18_ROWS) {
			const w = world();
			const { modules, packages = [w.outside], links = [] } = inputs(w);
			expect
				.soft(
					verdictOn(w, { a: record({ modules, packages }) }, { links }),
					label,
				)
				.toBe(want);
		}

		// Another worktree of the same repository: an absolute path with `/`.
		const w = world();
		const other = realOf(tempDir());
		expect
			.soft(
				verdictOn(
					w,
					{
						a: record({
							modules: [join(other, "src/demo/__init__.py")],
							packages: [w.outside],
						}),
					},
					{ checkouts: [w.top, other] },
				),
				"another worktree",
			)
			.toBe(`${CHECKOUT}${slash(other)}/src/demo/__init__.py`);

		// A path reaching the checkout through a symlink (Windows: a junction) outside it.
		const j = world();
		put(j.top, "src/demo/__init__.py", "");
		const link = join(j.outside, "linked-demo");
		symlinkSync(join(j.top, "src/demo"), link, "junction");
		expect
			.soft(
				verdictOn(j, {
					a: record({
						modules: [join(link, "__init__.py")],
						packages: [j.outside],
					}),
				}),
				"through a link",
			)
			.toBe(`${CHECKOUT}src/demo/__init__.py`);
	});

	it("B18: a failing git worktree list is a broken call naming the git error", () => {
		expect(() => checkoutFolders(tempDir())).toThrow(
			/^git worktree failed: fatal: not a git repository/,
		);
	});

	it("B19: no record file reads import guard did not run, an incomplete one reads import record incomplete, and a checkout module wins over both", () => {
		for (const [label, files, want] of B19_ROWS) {
			const w = world();
			expect.soft(verdictOn(w, files(w)), label).toBe(want);
		}
	});

	it("B25: the incomplete line names the pid of the first incomplete record file, or unknown", () => {
		const rows = B19_ROWS.filter(([, , want]) => want?.startsWith(INCOMPLETE));
		expect(rows.length).toBeGreaterThanOrEqual(7);
		for (const [label, files, want] of rows) {
			const w = world();
			expect.soft(verdictOn(w, files(w)), label).toBe(want);
		}
	});

	it("B22: the generated guard adds an audit hook and records a cached pyc as its source", () => {
		const text = guardScript(realOf(tempDir()));
		expect.soft(text).toContain("sys.addaudithook");
		expect.soft(text).toContain("source_from_cache");
		for (const path of [
			"skills/_shared/import-guard.mjs",
			"opencode/generated/skills/_shared/import-guard.mjs",
		]) {
			const lines = readFileSync(join(ROOT, path), "utf-8").split(/\r?\n/);
			const end = lines.findIndex((line) => !line.startsWith("//"));
			const header = lines.slice(0, end).join(" ");
			expect.soft(header, path).toContain("audit hook");
		}
	});

	it("B26: the records folder literal of the generated guard reads back as the guard folder for a name with a space, an apostrophe and a non-ASCII letter", () => {
		const dir = join(realOf(tempDir()), "it's a café");
		const literal = /_RECORDS = os\.path\.join\((.*), "records"\)/.exec(
			guardScript(dir),
		)?.[1];
		expect(literal).toBeDefined();
		expect(JSON.parse(literal)).toBe(dir.replaceAll("\\", "/"));
	});

	it("odin#22: the generated guard claims the root role with an exclusive file beside records/ and writes role and ppid after start", () => {
		const dir = realOf(tempDir());
		const text = guardScript(dir);
		const literal = /_CLAIM = os\.path\.join\((.*), "root"\)/.exec(text)?.[1];
		expect.soft(literal && JSON.parse(literal)).toBe(dir.replaceAll("\\", "/"));
		expect.soft(text).toContain("os.O_CREAT | os.O_EXCL");
		expect.soft(text).toContain("except FileExistsError");
		expect.soft(text).toContain('"role: "');
		expect.soft(text).toContain('"ppid: "');
		expect.soft(text).toContain("F_DUPFD_CLOEXEC");
		expect.soft(text).toContain('_start("child")');
	});

	it("B26: a listed worktree whose folder was deleted does not break the checkout folders", () => {
		const repo = newRepo();
		put(repo, "a.txt", "a\n");
		commitAll(repo, "base");
		const gone = join(tempDir(), "gone");
		git(repo, "worktree", "add", "-q", gone);
		rmSync(gone, { recursive: true, force: true });
		const folders = checkoutFolders(repo);
		expect.soft(folders).toContain(realOf(repo));
		expect.soft(folders).toHaveLength(2);
	});
});

// odin#22: a child Python process that ends without atexit (os._exit, a kill, a crash)
// leaves an unfinished record. Only the runner's own (root) record must finish; an
// unfinished child record is a diagnostic, and the run line stays the runner's.
const CHILD_DIAG = (pid) =>
	`diagnostic: child import record incomplete: pid ${pid} (child exited without atexit: os._exit, killed, or a crash); its module list is partial`;
const ODIN22_ROWS = [
	// [label, record files, options, expected verdict, expected diagnostics]
	[
		"a clean root and an unfinished child",
		(w) => ({
			a: record({ modules: [join(w.scratch, "x.py")] }),
			b: record({ pid: 11, role: "child", end: false }),
		}),
		{},
		undefined,
		[CHILD_DIAG(11)],
	],
	[
		"two unfinished children, in name order",
		() => ({
			a: record({}),
			b: record({ pid: 12, role: "child", end: false }),
			c: record({ pid: 11, role: "child", end: false }),
		}),
		{},
		undefined,
		[CHILD_DIAG(12), CHILD_DIAG(11)],
	],
	[
		"an unfinished root",
		() => ({
			a: record({ end: false }),
			b: record({ pid: 11, role: "child" }),
		}),
		{},
		`${INCOMPLETE}10`,
		[],
	],
	[
		"a missing claim",
		() => ({ a: record({}) }),
		{ claim: null },
		"result: broken: import guard root claim missing",
		[],
	],
	[
		"an invalid claim",
		() => ({ a: record({}) }),
		{ claim: "ten" },
		"result: broken: import guard root claim invalid",
		[],
	],
	[
		"a claim naming no root record",
		() => ({ a: record({ role: "child" }) }),
		{},
		"result: broken: import guard root record missing: claim pid 10, 0 root records",
		[],
	],
	[
		"a root record whose pid is not the claim's",
		() => ({ a: record({ pid: 11 }) }),
		{},
		"result: broken: import guard root record missing: claim pid 10, 1 root records",
		[],
	],
	[
		"two root records",
		() => ({ a: record({}), b: record({ pid: 11 }) }),
		{},
		"result: broken: import guard root record missing: claim pid 10, 2 root records",
		[],
	],
	[
		"an unfinished record with an unknown role",
		() => ({
			a: record({}),
			b: record({ pid: 11, role: "other", end: false }),
		}),
		{},
		`${INCOMPLETE}11`,
		[],
	],
	[
		"an unfinished child naming a checkout module",
		(w) => ({
			a: record({}),
			b: record({
				pid: 11,
				role: "child",
				end: false,
				modules: [join(w.top, "src/demo/__init__.py")],
			}),
		}),
		{},
		SRC_INIT,
		[],
	],
	[
		"a missing claim with an unfinished child",
		() => ({
			a: record({}),
			b: record({ pid: 11, role: "child", end: false }),
		}),
		{ claim: null },
		"result: broken: import guard root claim missing",
		[],
	],
];

describe("import guard: root and child records (odin#22)", () => {
	it("an unfinished child record is a diagnostic; an unfinished root, a bad claim, a bad role or a checkout module is broken", async () => {
		const { importJudgement } = await import(
			"../skills/_shared/import-guard.mjs"
		);
		for (const [label, files, options, verdict, diagnostics] of ODIN22_ROWS) {
			const w = world();
			const inputs = judged(w, files(w), options);
			expect.soft(importJudgement?.(inputs), label).toEqual({
				verdict,
				diagnostics,
			});
			expect
				.soft(importVerdict(inputs), `${label} (importVerdict)`)
				.toBe(verdict);
		}
	});
});
