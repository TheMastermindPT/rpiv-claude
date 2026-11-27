// tests/reprove-red-child-records.test.mjs — a re-proof whose test starts a child Python
// process that ends without atexit (odin#22). The runner (pytest) claims the root role of
// the import guard; a child's unfinished record adds a `diagnostic: child import record
// incomplete:` line before the run line, which stays pytest's, with exit 0. The first
// cases use the node recorder as the runner (it writes the records and the root claim);
// the last ones run real pytest and need RPIV_TEST_PYTHON to name an interpreter with
// pytest (each skips, naming why, otherwise).

import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	lastLine,
	NODE,
	newRepo,
	put,
	RECORDER,
	runHelper,
	TEST_TIMEOUT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

// ---- the node recorder ----

const ADD = "tests/test_ok.py::test_b1_add";
const DIAG =
	"diagnostic: child import record incomplete: pid 11 (child exited without atexit: os._exit, killed, or a crash); its module list is partial";

/** A record file's text (`end:` left out when `end` is false); `{cwd}` is the run
    folder, `{guard}` the guard folder. The recorder claims the root role for pid 10. */
const recordText = ({ modules = [], pid = 10, role = "root", end = true }) =>
	[
		`start: ${pid}`,
		`role: ${role}`,
		"ppid: 1",
		"package: {guard}",
		...modules.map((path) => `module: ${path}`),
		...(end ? [`end: ${pid}`] : []),
		"",
	].join("\n");

/** A slice adding `tests/test_ok.py` over a base holding the recorder and `src/demo`. */
const recorderSlice = () => {
	const repo = newRepo();
	put(repo, "rec.mjs", RECORDER);
	put(repo, "src/demo/__init__.py", "X = 1\n");
	commitAll(repo, "base");
	put(repo, "tests/test_ok.py", "def test_b1_add():\n    pass\n");
	return { repo, slice: commitAll(repo, "slice") };
};

/** The helper on the slice naming `ADD`, the recorder writing `records` and a report
    that lacks `ADD`, with exit `code`; `--no-claim` when `noClaim`. */
const recorded = ({ repo, slice }, { records, code, noClaim = false }) => {
	const spec = join(tempDir(), "records.json");
	writeFileSync(
		spec,
		JSON.stringify(
			Object.entries(records).map(([name, text]) => ({ name, text })),
		),
	);
	const report = join(tempDir(), "report.xml");
	writeFileSync(
		report,
		'<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest"><testcase classname="tests.test_ok" name="other"/></testsuite></testsuites>',
	);
	return runHelper(
		[
			"--commit",
			slice,
			"--test",
			ADD,
			"--",
			NODE,
			join(repo, "rec.mjs"),
			"--copy",
			report,
			"--junitxml={junit}",
			"--records",
			spec,
			"--code",
			String(code),
			...(noClaim ? ["--no-claim"] : []),
		],
		repo,
	);
};

describe("through the CLI with the recorder (odin#22)", () => {
	it(
		"an unfinished child record adds a diagnostic before the run line and keeps the run line, the buckets and exit 0",
		() => {
			const s = recorderSlice();
			const root = recordText({ modules: ["{cwd}/x.py"] });
			const child = recordText({ pid: 11, role: "child", end: false });
			const both = { a: root, b: child };
			const leak = recordText({
				pid: 11,
				role: "child",
				end: false,
				modules: [join(realpathSync.native(s.repo), "src/demo/__init__.py")],
			});
			const ROWS = [
				// [label, records, exit, bucket, the lines after the bucket]
				["red", both, 1, "not-found", [DIAG, "result: red"]],
				// Never masks a run that is not red: green and not-found stay as they are.
				["green", both, 0, "not-found", [DIAG, "result: green"]],
				["no-tests", both, 5, "not-found", [DIAG, "result: no-tests"]],
				[
					"unfinished root",
					{ a: recordText({ end: false }), b: child },
					1,
					"unavailable",
					["result: broken: import record incomplete: pid 10"],
				],
				[
					"checkout module in an unfinished child",
					{ a: root, b: leak },
					1,
					"unavailable",
					["result: broken: imported from the checkout: src/demo/__init__.py"],
				],
				// A clean run prints no child line (its output is as before odin#22).
				["clean", { a: root }, 1, "not-found", ["result: red"]],
			];
			for (const [label, records, code, bucket, after] of ROWS) {
				const run = recorded(s, { records, code });
				expect.soft(run.status, label).toBe(0);
				const at = run.lines.indexOf(`test-result: ${bucket} ${ADD}`);
				expect.soft(at, label).toBeGreaterThan(0);
				expect.soft(run.lines.slice(at + 1), label).toEqual(after);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"a run whose root claim is missing is broken",
		() => {
			const run = recorded(recorderSlice(), {
				records: { a: recordText({}) },
				code: 1,
				noClaim: true,
			});
			expect.soft(run.status).toBe(0);
			expect
				.soft(lastLine(run.lines))
				.toBe("result: broken: import guard root claim missing");
		},
		TEST_TIMEOUT,
	);
});

// ---- real pytest ----

const PYTHON = process.env.RPIV_TEST_PYTHON ?? "";

/** Skips the test, naming why, when no interpreter is named or it has no pytest. */
const needPytest = (ctx) => {
	if (!PYTHON) ctx.skip("unavailable: RPIV_TEST_PYTHON not set");
	const probe = spawnSync(PYTHON, ["-c", "import pytest"], {
		encoding: "utf-8",
	});
	if (probe.error) throw probe.error;
	if (probe.status !== 0) ctx.skip("unavailable: pytest not importable");
};

const ID = "tests/test_child.py::test_child";
const CHILD_DIAG =
	/^diagnostic: child import record incomplete: pid \d+ \(child exited without atexit: os\._exit, killed, or a crash\); its module list is partial$/;

/** A test that starts `child` the reporter's way (sys.executable, capture_output, an env
    rebuilt from scratch with PYTHONPATH, PATH, SYSTEMROOT and one app variable), then
    asserts `check`. */
const testOf = (child, check) =>
	[
		"import os, subprocess, sys",
		"import demo",
		"",
		`SCRIPT = ${JSON.stringify(child)}`,
		"",
		"",
		"def test_child():",
		'    env = {k: os.environ[k] for k in ("PYTHONPATH", "PATH", "SYSTEMROOT") if k in os.environ}',
		'    env["APP_VAR"] = "1"',
		'    subprocess.run([sys.executable, "-c", SCRIPT, "arg"], capture_output=True, text=True, check=False, timeout=120, env=env)',
		`    assert ${check}`,
		"",
	].join("\n");

/** The helper on a slice that adds `test`, the base holding `src/demo`, with real
    pytest as the runner. */
const reprove = (test) => {
	const repo = newRepo();
	put(repo, "src/demo/__init__.py", "X = 1\n");
	commitAll(repo, "base");
	put(repo, "src/demo/__init__.py", "X = 1\nNEW = 2\n");
	put(repo, "tests/test_child.py", test);
	const slice = commitAll(repo, "slice");
	return runHelper(
		[
			"--commit",
			slice,
			"--test",
			ID,
			"--",
			PYTHON,
			"-m",
			"pytest",
			"-p",
			"no:cacheprovider",
			"--junitxml={junit}",
			"{tests}",
		],
		repo,
	);
};

/** The lines after the named test's result (and its reason). */
const tailOf = (run) =>
	run.lines.slice(
		run.lines.findIndex((line) => line.startsWith("test-result: ")) + 1,
	);

describe("real pytest: a child that ends without atexit (odin#22)", () => {
	it(
		"the reporter's shape, forced: the child closes fd 2, imports the code, prints and ends through os._exit; the named test fails as expected and the run reads red with a child diagnostic",
		(ctx) => {
			needPytest(ctx);
			const run = reprove(
				testOf(
					"import os\nos.close(2)\nimport demo\nprint('ok', flush=True)\nos._exit(0)",
					"demo.NEW == 2",
				),
			);
			expect.soft(run.status, run.stderr).toBe(0);
			expect.soft(run.lines).toContain(`test-result: failed ${ID}`);
			const tail = tailOf(run).filter((line) => !line.startsWith("reason: "));
			expect.soft(tail).toHaveLength(2);
			expect.soft(tail[0]).toMatch(CHILD_DIAG);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it.runIf(process.platform === "win32")(
		"Windows, the reporter's real case: the child closes fd 2, imports, prints, then writes to stderr and dies without atexit; the run reads red with a child diagnostic, not broken",
		(ctx) => {
			needPytest(ctx);
			const run = reprove(
				testOf(
					"import os, sys\nos.close(2)\nimport demo\nprint('ok')\nprint('e', file=sys.stderr)",
					"demo.NEW == 2",
				),
			);
			expect.soft(run.status, run.stderr).toBe(0);
			expect.soft(run.lines).toContain(`test-result: failed ${ID}`);
			expect.soft(run.lines.some((line) => CHILD_DIAG.test(line))).toBe(true);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"a named test that passes beside an unfinished child still reads passed and green: the diagnostic never turns it into red",
		(ctx) => {
			needPytest(ctx);
			const run = reprove(
				testOf("import os\nimport demo\nos._exit(0)", "demo.X == 1"),
			);
			expect.soft(run.status, run.stderr).toBe(0);
			expect.soft(run.lines).toContain(`test-result: passed ${ID}`);
			expect.soft(run.lines.some((line) => CHILD_DIAG.test(line))).toBe(true);
			expect.soft(lastLine(run.lines)).toBe("result: green");
		},
		TEST_TIMEOUT,
	);

	it(
		"a child that closes fd 2 and exits normally leaves no diagnostic: the run reads red as before",
		(ctx) => {
			needPytest(ctx);
			const run = reprove(
				testOf(
					"import os\nos.close(2)\nimport demo\nprint('ok')",
					"demo.NEW == 2",
				),
			);
			expect.soft(run.status, run.stderr).toBe(0);
			expect.soft(run.lines).toContain(`test-result: failed ${ID}`);
			expect
				.soft(run.lines.filter((line) => line.startsWith("diagnostic: ")))
				.toEqual([]);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);
});
