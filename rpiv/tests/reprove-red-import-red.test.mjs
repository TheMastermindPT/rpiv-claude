// tests/reprove-red-import-red.test.mjs — a Python run that pytest stops while loading
// (rpiv issue draft 20261123-231126-941be8d9): an import of what the slice adds is
// `result: red (import)` with `failed-import` named tests; any other load failure stays
// broken. The recorder stands in for pytest, printing pytest's own load-failure text.

import { writeFileSync } from "node:fs";
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

const TEST_ID = "tests/test_x.py::test_b1_x";

/** pytest's log when a conftest fails to import (exit 4). */
const conftestLog = (error) =>
	[
		"ImportError while loading conftest 'C:\\scratch\\tests\\conftest.py'.",
		"tests\\conftest.py:1: in <module>",
		"    from tools.x import foo",
		`E   ${error}`,
		"",
	].join("\r\n");

/** pytest's report when test modules fail to collect (exit 2): one error record each. */
const collectionReport = (errors) =>
	`<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="${errors.length}">${errors
		.map(
			([module, error]) =>
				`<testcase classname="" name="${module}"><error message="collection failure">ImportError while importing test module.\ntests\\x.py:1: in &lt;module&gt;\nE   ${error}</error></testcase>`,
		)
		.join("")}</testsuite></testsuites>`;

/** A repository with the recorder (and `base` files) at its base and a slice commit
    adding `slice` files beside the named test and a conftest. */
const sliceOf = ({ base = {}, slice = {} }) => {
	const repo = newRepo();
	put(repo, "rec.mjs", RECORDER);
	for (const [path, text] of Object.entries(base)) put(repo, path, text);
	commitAll(repo, "base");
	put(repo, "tests/conftest.py", "from tools.x import foo\n");
	put(repo, "tests/test_x.py", "def test_b1_x():\n    assert True\n");
	for (const [path, text] of Object.entries(slice)) put(repo, path, text);
	return { repo, commit: commitAll(repo, "slice") };
};

/** The helper on the slice, naming the test, with the recorder printing `log` and
    copying `report` (when given) as pytest's, exiting `code`. */
const run = ({ repo, commit }, { code, log = "", report }) => {
	const dir = tempDir();
	const logFile = join(dir, "pytest.log");
	writeFileSync(logFile, log);
	const copy = [];
	if (report !== undefined) {
		const reportFile = join(dir, "report.xml");
		writeFileSync(reportFile, report);
		copy.push("--copy", reportFile);
	}
	return runHelper(
		[
			"--commit",
			commit,
			"--test",
			TEST_ID,
			"--",
			NODE,
			join(repo, "rec.mjs"),
			"--junitxml={junit}",
			"--print",
			logFile,
			...copy,
			"--code",
			String(code),
		],
		repo,
	);
};

const linesOf = (result, prefix) =>
	result.lines.filter((line) => line.startsWith(prefix));

describe("reprove-red when pytest stops loading", () => {
	it(
		"a conftest importing a module the slice adds is red (import), its tests failed-import",
		() => {
			const s = sliceOf({ slice: { "tools/x.py": "foo = 1\n" } });
			const error = "ModuleNotFoundError: No module named 'tools'";
			const result = run(s, { code: 4, log: conftestLog(error) });
			expect.soft(result.stderr).toBe("");
			expect
				.soft(linesOf(result, "load-error: "))
				.toEqual([`load-error: ${error} (the slice adds tools/x.py)`]);
			expect
				.soft(linesOf(result, "test-result: "))
				.toEqual([`test-result: failed-import ${TEST_ID}`]);
			expect
				.soft(linesOf(result, "reason: "))
				.toEqual([`reason: ${TEST_ID}: ${error}`]);
			expect.soft(lastLine(result.lines)).toBe("result: red (import)");
		},
		TEST_TIMEOUT,
	);

	it(
		"a conftest missing a dependency the slice does not add stays broken",
		() => {
			const s = sliceOf({ slice: { "tools/x.py": "foo = 1\n" } });
			const error = "ModuleNotFoundError: No module named 'numpy'";
			const result = run(s, { code: 4, log: conftestLog(error) });
			expect
				.soft(linesOf(result, "load-error: "))
				.toEqual([
					`load-error: ${error} (not an import of something the slice adds)`,
				]);
			expect
				.soft(linesOf(result, "test-result: "))
				.toEqual([`test-result: unavailable ${TEST_ID}`]);
			expect
				.soft(lastLine(result.lines))
				.toBe("result: broken: exit 4 (pytest: usage error)");
		},
		TEST_TIMEOUT,
	);

	it(
		"a module the base already has is not the slice's, so its import error stays broken",
		() => {
			const s = sliceOf({ base: { "tools/x.py": "foo = 1\n" } });
			const result = run(s, {
				code: 4,
				log: conftestLog("ModuleNotFoundError: No module named 'tools'"),
			});
			expect
				.soft(lastLine(result.lines))
				.toBe("result: broken: exit 4 (pytest: usage error)");
		},
		TEST_TIMEOUT,
	);

	it(
		"an exit 4 that is no conftest failure stays a usage error, with no load-error line",
		() => {
			const s = sliceOf({ slice: { "tools/x.py": "foo = 1\n" } });
			const result = run(s, {
				code: 4,
				log: "ERROR: usage: pytest [options]\nE   ModuleNotFoundError: No module named 'tools'\n",
			});
			expect.soft(linesOf(result, "load-error: ")).toEqual([]);
			expect
				.soft(lastLine(result.lines))
				.toBe("result: broken: exit 4 (pytest: usage error)");
		},
		TEST_TIMEOUT,
	);

	it(
		"a test module importing a name the slice adds to a base module is red (import)",
		() => {
			const s = sliceOf({
				base: { "tools/__init__.py": "", "tools/x.py": "foo = 1\n" },
				slice: { "tools/x.py": "foo = 1\nbar = 2\n" },
			});
			const error =
				"ImportError: cannot import name 'bar' from 'tools.x' (C:\\scratch\\tools\\x.py)";
			const result = run(s, {
				code: 2,
				report: collectionReport([["tests.test_x", error]]),
			});
			expect
				.soft(linesOf(result, "load-error: "))
				.toEqual([
					"load-error: ImportError: cannot import name 'bar' from 'tools.x' (the slice adds bar in tools/x.py)",
				]);
			expect
				.soft(linesOf(result, "test-result: "))
				.toEqual([`test-result: failed-import ${TEST_ID}`]);
			expect.soft(lastLine(result.lines)).toBe("result: red (import)");
		},
		TEST_TIMEOUT,
	);

	it(
		"a name the base module already has is not the slice's, so it stays broken",
		() => {
			const s = sliceOf({
				base: { "tools/x.py": "foo = 1\nbar = 0\n" },
				slice: { "tools/x.py": "foo = 1\nbar = 2\n" },
			});
			const result = run(s, {
				code: 2,
				report: collectionReport([
					[
						"tests.test_x",
						"ImportError: cannot import name 'bar' from 'tools.x'",
					],
				]),
			});
			expect
				.soft(linesOf(result, "test-result: "))
				.toEqual([`test-result: failed-to-load ${TEST_ID}`]);
			expect
				.soft(lastLine(result.lines))
				.toBe(
					"result: broken: exit 2 (pytest: collection error or interrupted)",
				);
		},
		TEST_TIMEOUT,
	);

	it(
		"one load failure that is not the slice's import keeps the whole run broken",
		() => {
			const s = sliceOf({ slice: { "tools/x.py": "foo = 1\n" } });
			const result = run(s, {
				code: 2,
				report: collectionReport([
					["tests.test_x", "ModuleNotFoundError: No module named 'tools'"],
					["tests.test_y", "SyntaxError: invalid syntax"],
				]),
			});
			expect
				.soft(linesOf(result, "load-error: "))
				.toEqual([
					"load-error: ModuleNotFoundError: No module named 'tools' (the slice adds tools/x.py)",
					"load-error: SyntaxError: invalid syntax (not an import of something the slice adds)",
				]);
			expect
				.soft(linesOf(result, "test-result: "))
				.toEqual([`test-result: failed-to-load ${TEST_ID}`]);
			expect
				.soft(lastLine(result.lines))
				.toBe(
					"result: broken: exit 2 (pytest: collection error or interrupted)",
				);
		},
		TEST_TIMEOUT,
	);
});
