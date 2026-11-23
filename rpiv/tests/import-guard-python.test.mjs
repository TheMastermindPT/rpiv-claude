// tests/import-guard-python.test.mjs — the import guard's Python side, run with a real
// interpreter (slice S2b-guard-proof of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md, D22).
// The tests run only when RPIV_TEST_PYTHON names an interpreter; unset, each one is
// skipped with `unavailable: RPIV_TEST_PYTHON not set`. A named interpreter that cannot
// run fails them. The fork examples run only where `os.fork` exists.
// import-guard.mjs is loaded inside the tests (D26).

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, put, tempDir } from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

let G;
beforeEach(async () => {
	G = await import("../skills/_shared/import-guard.mjs");
});

const PYTHON = process.env.RPIV_TEST_PYTHON ?? "";
const TIMEOUT = 60_000;

/** Skips the test, naming why, when no interpreter is named. */
const needPython = (ctx) => {
	if (!PYTHON) ctx.skip("unavailable: RPIV_TEST_PYTHON not set");
};

/** Runs `code` in `python` with `env` (no guard), returning status and stdout. */
const python = (args, env = {}) => {
	const result = spawnSync(PYTHON, args, {
		encoding: "utf-8",
		timeout: TIMEOUT,
		env: { ...process.env, ...env },
	});
	if (result.error) throw result.error;
	return result;
};

/** Skips the test, naming why, when the interpreter has no `os.fork`. */
const needFork = (ctx) => {
	needPython(ctx);
	const probe = python(["-c", "import os; print(hasattr(os, 'fork'))"]);
	expect(probe.status, probe.stderr).toBe(0);
	if (probe.stdout.trim() !== "True") ctx.skip("unavailable: no os.fork");
};

/** A checkout stand-in `co` holding `pkg/__init__.py` and `pkg/mod.py`, and a guard
    folder made by createGuard. */
const world = () => {
	const co = G.realOf(tempDir());
	put(co, "pkg/__init__.py", "X = 1\n");
	put(co, "pkg/mod.py", "Y = 2\n");
	const guard = G.createGuard([]);
	return { co, guard, records: join(guard, "records") };
};

/** Runs `code` as a guarded process: the guard first on PYTHONPATH, `co` second. */
const guarded = ({ guard, co }, code, args = []) =>
	python(["-c", code, ...args], {
		PYTHONPATH: [guard, co].join(delimiter),
		PYTHONDONTWRITEBYTECODE: "1",
	});

const realPy = (co, path) => G.realOf(join(co, path));

describe("import guard with real Python (S2b-guard-proof)", () => {
	it("B22: a guarded process records a module dropped from sys.modules before exit, and its output is unchanged", (ctx) => {
		needPython(ctx);
		const w = world();
		const run = guarded(
			w,
			'import sys, pkg.mod\ndel sys.modules["pkg.mod"]\ndel sys.modules["pkg"]\nprint("ok")',
		);
		expect.soft(run.status, run.stderr).toBe(0);
		expect.soft(run.stdout.replace(/\r\n/g, "\n")).toBe("ok\n");
		const files = G.readRecords(w.records);
		expect.soft(files).toHaveLength(1);
		expect.soft(files[0]?.complete).toBe(true);
		expect
			.soft(files[0]?.modules)
			.toEqual(
				expect.arrayContaining([
					realPy(w.co, "pkg/__init__.py"),
					realPy(w.co, "pkg/mod.py"),
				]),
			);
	});

	it("B22: a module imported inside mock.patch.dict of sys.modules is recorded", (ctx) => {
		needPython(ctx);
		const w = world();
		const run = guarded(
			w,
			"import sys\nfrom unittest import mock\nwith mock.patch.dict(sys.modules):\n    import pkg.mod",
		);
		expect.soft(run.status, run.stderr).toBe(0);
		const [file] = G.readRecords(w.records);
		expect.soft(file?.modules).toContain(realPy(w.co, "pkg/mod.py"));
	});

	it("B22: a cached pyc is recorded as its source file", (ctx) => {
		needPython(ctx);
		const w = world();
		const compiled = python(["-m", "compileall", "-q", join(w.co, "pkg")]);
		expect(compiled.status, compiled.stderr).toBe(0);
		expect(readdirSync(join(w.co, "pkg/__pycache__")).length).toBeGreaterThan(
			0,
		);
		const run = guarded(
			w,
			'import sys, pkg.mod\ndel sys.modules["pkg.mod"]\ndel sys.modules["pkg"]',
		);
		expect.soft(run.status, run.stderr).toBe(0);
		const [file] = G.readRecords(w.records);
		expect.soft(file?.modules).toContain(realPy(w.co, "pkg/mod.py"));
		expect
			.soft(file?.modules.filter((path) => path.toLowerCase().endsWith(".pyc")))
			.toEqual([]);
	});

	it("B22: a file opened for writing or with another extension is not recorded", (ctx) => {
		needPython(ctx);
		const w = world();
		writeFileSync(join(w.co, "notes.txt"), "n\n");
		const run = guarded(
			w,
			'import sys\nopen(sys.argv[1], "w").write("x = 1\\n")\nopen(sys.argv[2]).read()',
			[join(w.co, "out.py"), join(w.co, "notes.txt")],
		);
		expect.soft(run.status, run.stderr).toBe(0);
		const [file] = G.readRecords(w.records);
		expect.soft(file?.complete).toBe(true);
		expect
			.soft(
				file?.modules.filter(
					(path) => path.endsWith("out.py") || path.endsWith("notes.txt"),
				),
			)
			.toEqual([]);
	});

	it("B23: a forked child that returns normally writes its own complete record naming what it imported", (ctx) => {
		needFork(ctx);
		const w = world();
		const run = guarded(
			w,
			"import os\npid = os.fork()\nif pid == 0:\n    import pkg.mod\nelse:\n    os.waitpid(pid, 0)",
		);
		expect.soft(run.status, run.stderr).toBe(0);
		const files = G.readRecords(w.records);
		expect.soft(files).toHaveLength(2);
		expect.soft(files.every((file) => file.complete)).toBe(true);
		const naming = files.filter((file) =>
			file.modules.includes(realPy(w.co, "pkg/mod.py")),
		);
		expect.soft(naming).toHaveLength(1);
	});

	it("B23: a forked child ending through os._exit leaves an incomplete record that still names its checkout import", (ctx) => {
		needFork(ctx);
		const w = world();
		const run = guarded(
			w,
			"import os\npid = os.fork()\nif pid == 0:\n    import pkg.mod\n    os._exit(0)\nelse:\n    os.waitpid(pid, 0)",
		);
		expect.soft(run.status, run.stderr).toBe(0);
		const files = G.readRecords(w.records);
		expect.soft(files).toHaveLength(2);
		expect.soft(files.filter((file) => !file.complete)).toHaveLength(1);
		expect
			.soft(
				G.importVerdict({
					recordsDir: w.records,
					checkouts: [w.co],
					exempt: [w.guard],
					top: w.co,
				}),
			)
			.toBe("result: broken: imported from the checkout: pkg/mod.py");
	});

	it("B26: a guarded process writes its record into a guard folder whose name holds a space, an apostrophe and a non-ASCII letter", (ctx) => {
		needPython(ctx);
		const co = G.realOf(tempDir());
		const dir = join(tempDir(), "it's a café");
		mkdirSync(join(dir, "records"), { recursive: true });
		writeFileSync(join(dir, "sitecustomize.py"), G.guardScript(dir), "utf-8");
		const run = guarded({ guard: dir, co }, "pass");
		expect.soft(run.status, run.stderr).toBe(0);
		const files = G.readRecords(join(dir, "records"));
		expect.soft(files).toHaveLength(1);
		expect.soft(files[0]?.complete).toBe(true);
		expect
			.soft(readFileSync(join(dir, "sitecustomize.py"), "utf-8"))
			.toContain("café");
	});
});
