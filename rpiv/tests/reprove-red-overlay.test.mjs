// tests/reprove-red-overlay.test.mjs — what a Python run writes over the base (odin#17).
// Re-proving red runs the slice's NEW tests against the base's OLD code, so the copy
// takes the slice's tests, its `conftest.py` files and its test data, and leaves every
// other `.py` file under the test tree (support code: `tests/pkg/impl.py`,
// `tests/fixtures/store.py`) at its base version, naming each one in a
// `diagnostic: not overlaid:` line. A changed test that a call names is a runner test in
// any folder, so a `tests/fixtures/test_manifest.py` the call names prints as `test:`,
// not `fixture:`.
// The first cases use the node recorder as the runner; the last ones run real pytest and
// need RPIV_TEST_PYTHON to name an interpreter with pytest (each skips, naming why,
// otherwise).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	drop,
	headerBody,
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

const base = (path) => `b:${path}\n`;
const changed = (path) => `c:${path}\n`;
const NOT_OVERLAID = (path) =>
	`diagnostic: not overlaid: ${path} (not a test file: support code runs at its base version)`;

/** A repository whose base commit holds the recorder and `files` (`{ path: content }`). */
const baseRepo = (files = {}) => {
	const repo = newRepo();
	put(repo, "rec.mjs", RECORDER);
	for (const [path, content] of Object.entries(files)) put(repo, path, content);
	commitAll(repo, "base");
	return repo;
};

/** The helper on `slice` with the recorder as the runner (`{tests}`, then exit `code`),
    naming `tests`; `seen` is what the runner saw, `expanded` what `{tests}` became. */
const recRun = (repo, slice, { tests = [], code = 1 } = {}) => {
	const out = join(tempDir(), "out.json");
	const run = runHelper(
		[
			"--commit",
			slice,
			...tests.flatMap((id) => ["--test", id]),
			"--",
			NODE,
			join(repo, "rec.mjs"),
			"--out",
			out,
			// A call that names tests reads a report.
			...(tests.length ? ["--junitxml={junit}"] : []),
			"{tests}",
			"--code",
			String(code),
		],
		repo,
	);
	let seen;
	try {
		seen = JSON.parse(readFileSync(out, "utf-8"));
	} catch {
		seen = undefined;
	}
	const args = (seen?.args ?? []).filter(
		(arg) => !arg.startsWith("--junitxml="),
	);
	return {
		...run,
		seen,
		expanded: args.slice(2, args.indexOf("--code")),
	};
};

describe("a Python run overlays the slice's tests, never its support code (odin#17)", () => {
	it(
		"tests, conftest.py and test data are written from the commit; support code keeps its base version and is named",
		() => {
			const repo = baseRepo({
				"tests/helpers.py": base("tests/helpers.py"),
				"tests/old_support.py": base("tests/old_support.py"),
				"tests/conftest.py": base("tests/conftest.py"),
			});
			const WRITTEN = [
				"tests/pkg/test_impl.py",
				"tests/conftest.py",
				"tests/fixtures/x.json",
			];
			const KEPT = [
				"tests/helpers.py",
				"tests/pkg/__init__.py",
				"tests/pkg/impl.py",
			];
			for (const path of [...WRITTEN, ...KEPT]) put(repo, path, changed(path));
			drop(repo, "tests/old_support.py");
			const slice = commitAll(repo, "slice");
			const run = recRun(repo, slice);
			expect.soft(run.stderr).toBe("");
			expect
				.soft(headerBody(run.lines))
				.toEqual([
					"test: tests/pkg/test_impl.py",
					"fixture: tests/conftest.py",
					"fixture: tests/fixtures/x.json",
					NOT_OVERLAID("tests/helpers.py"),
					NOT_OVERLAID("tests/old_support.py"),
					NOT_OVERLAID("tests/pkg/__init__.py"),
					NOT_OVERLAID("tests/pkg/impl.py"),
				]);
			const files = run.seen?.files ?? {};
			for (const path of WRITTEN) {
				expect.soft(files[path], path).toBe(changed(path));
			}
			// A support module the slice modifies or deletes keeps its base version.
			expect.soft(files["tests/helpers.py"]).toBe(base("tests/helpers.py"));
			expect
				.soft(files["tests/old_support.py"])
				.toBe(base("tests/old_support.py"));
			// A support module the slice adds stays absent.
			expect.soft(Object.hasOwn(files, "tests/pkg/impl.py")).toBe(false);
			expect.soft(Object.hasOwn(files, "tests/pkg/__init__.py")).toBe(false);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"a changed test the call names is a runner test in a fixtures folder too",
		() => {
			const repo = baseRepo({
				"tests/fixtures/store.py": base("tests/fixtures/store.py"),
			});
			for (const path of [
				"tests/test_other.py",
				"tests/fixtures/test_manifest.py",
				"tests/fixtures/store.py",
			]) {
				put(repo, path, changed(path));
			}
			const slice = commitAll(repo, "slice");
			const run = recRun(repo, slice, {
				tests: ["tests/fixtures/test_manifest.py::test_rows"],
			});
			expect.soft(run.stderr).toBe("");
			expect
				.soft(headerBody(run.lines))
				.toEqual([
					"test: tests/fixtures/test_manifest.py",
					"test: tests/test_other.py",
					NOT_OVERLAID("tests/fixtures/store.py"),
				]);
			expect
				.soft(run.seen?.files?.["tests/fixtures/test_manifest.py"])
				.toBe(changed("tests/fixtures/test_manifest.py"));
			expect
				.soft(run.seen?.files?.["tests/fixtures/store.py"])
				.toBe(base("tests/fixtures/store.py"));

			// Its only runner tests are in a fixtures folder: still a Python run, so
			// `{tests}` is the pytest node id, not the file.
			const alone = baseRepo();
			put(alone, "tests/fixtures/test_manifest.py", "c\n");
			const aloneSlice = commitAll(alone, "slice");
			const aloneRun = recRun(alone, aloneSlice, {
				tests: ["tests/fixtures/test_manifest.py::test_rows"],
			});
			expect
				.soft(headerBody(aloneRun.lines))
				.toEqual(["test: tests/fixtures/test_manifest.py"]);
			expect
				.soft(aloneRun.expanded)
				.toEqual(["tests/fixtures/test_manifest.py::test_rows"]);

			// Unnamed, a test in a fixtures folder is still test data (D7).
			const unnamed = recRun(repo, slice);
			expect
				.soft(headerBody(unnamed.lines))
				.toEqual([
					"test: tests/test_other.py",
					"fixture: tests/fixtures/test_manifest.py",
					NOT_OVERLAID("tests/fixtures/store.py"),
				]);
			expect.soft(unnamed.expanded).toEqual(["tests/test_other.py"]);
		},
		TEST_TIMEOUT,
	);
});

// ---- real pytest ----

const PYTHON = process.env.RPIV_TEST_PYTHON ?? "";

/** Skips the test, naming why, when no interpreter is named or it has no pytest. An
    interpreter whose `import pytest` fails for any other reason fails the test. */
const needPytest = (ctx) => {
	if (!PYTHON) ctx.skip("unavailable: RPIV_TEST_PYTHON not set");
	const probe = spawnSync(PYTHON, ["-c", "import pytest"], {
		encoding: "utf-8",
	});
	if (probe.error) throw probe.error;
	if (probe.status === 0) return;
	if (/No module named '?pytest'?/.test(probe.stderr))
		ctx.skip("unavailable: pytest not installed");
	throw new Error(`RPIV_TEST_PYTHON cannot import pytest:\n${probe.stderr}`);
};

/** A repository with `baseFiles` at its base and `sliceFiles` added by the slice. */
const pySlice = (baseFiles, sliceFiles) => {
	const repo = newRepo();
	put(repo, "README.md", "base\n");
	for (const [path, text] of Object.entries(baseFiles)) put(repo, path, text);
	commitAll(repo, "base");
	for (const [path, text] of Object.entries(sliceFiles)) put(repo, path, text);
	return { repo, slice: commitAll(repo, "slice") };
};

/** The helper on the slice naming `id`, with real pytest as the runner. */
const pytestRun = ({ repo, slice }, id) =>
	runHelper(
		[
			"--commit",
			slice,
			"--test",
			id,
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

const resultOf = (run, id) =>
	run.lines.find(
		(line) => line.startsWith("test-result: ") && line.endsWith(id),
	);

describe("real pytest: the new tests run against the base's support code (odin#17)", () => {
	it(
		"the issue's repro: a support package the slice adds reads failed-import, not passed",
		(ctx) => {
			needPytest(ctx);
			const id = "tests/pkg/test_impl.py::test_f";
			const s = pySlice(
				{},
				{
					"tests/pkg/__init__.py": "",
					"tests/pkg/impl.py": "def f():\n    return 1\n",
					"tests/pkg/test_impl.py":
						"from tests.pkg.impl import f\n\n\ndef test_f():\n    assert f() == 1\n",
				},
			);
			const run = pytestRun(s, id);
			expect.soft(run.stderr).toBe("");
			expect.soft(run.lines).toContain(NOT_OVERLAID("tests/pkg/impl.py"));
			expect.soft(resultOf(run, id)).toBe(`test-result: failed-import ${id}`);
			expect.soft(lastLine(run.lines)).toBe("result: red (import)");
		},
		TEST_TIMEOUT,
	);

	it(
		"a support module the slice modifies runs at its base version, so the new test fails",
		(ctx) => {
			needPytest(ctx);
			const id = "tests/test_support.py::test_f";
			const s = pySlice(
				{
					"tests/__init__.py": "",
					"tests/support.py": "def f():\n    return 1\n",
				},
				{
					"tests/support.py": "def f():\n    return 2\n",
					"tests/test_support.py":
						"from tests.support import f\n\n\ndef test_f():\n    assert f() == 2\n",
				},
			);
			const run = pytestRun(s, id);
			expect.soft(run.stderr).toBe("");
			expect.soft(resultOf(run, id)).toBe(`test-result: failed ${id}`);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"a changed conftest.py is overlaid: the new fixture is found and the test fails on its assertion",
		(ctx) => {
			needPytest(ctx);
			const id = "tests/test_calc.py::test_value";
			const s = pySlice(
				{
					"tests/__init__.py": "",
					"tests/conftest.py": "",
					"tests/calc.py": "def value():\n    return 1\n",
				},
				{
					"tests/conftest.py":
						"import pytest\n\n\n@pytest.fixture\ndef answer():\n    return 2\n",
					"tests/calc.py": "def value():\n    return 2\n",
					"tests/test_calc.py":
						"from tests.calc import value\n\n\ndef test_value(answer):\n    assert value() == answer\n",
				},
			);
			const run = pytestRun(s, id);
			expect.soft(run.stderr).toBe("");
			expect.soft(run.lines).toContain("fixture: tests/conftest.py");
			expect.soft(resultOf(run, id)).toBe(`test-result: failed ${id}`);
			expect
				.soft(run.lines.find((line) => line.startsWith(`reason: ${id}: `)))
				.toMatch(/assert 1 == 2/);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);
});
