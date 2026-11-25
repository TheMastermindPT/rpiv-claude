// tests/reprove-red-scratch.test.mjs — contract tests for the scratch copy, the runner
// environment and the import guard of skills/_shared/reprove-red.mjs in a Python run
// (slice S2-scratch-copy of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md).
// The runner is a node stand-in (RECORDER), so these tests need no Python.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	drop,
	git,
	gitPath,
	headerBody,
	lastLine,
	NODE,
	newRepo,
	put,
	RECORDER,
	ROOT,
	runHelper,
	TEST_TIMEOUT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

// import-guard.mjs is loaded inside the tests, so a re-proof at a base without it reads
// per-test failures, not a file that fails to load (D26, S2b-guard-proof).
let realOf;
beforeEach(async () => {
	({ realOf } = await import("../skills/_shared/import-guard.mjs"));
});

/** A repository whose base commit holds the recorder and `files` (`{ path: content }`). */
const baseRepo = (files = {}) => {
	const repo = newRepo();
	put(repo, "rec.mjs", RECORDER);
	for (const [path, content] of Object.entries(files)) put(repo, path, content);
	return { repo, base: commitAll(repo, "base") };
};

/** The helper on `slice` with the recorder as the runner; `out` receives what it saw. */
const recRun = (
	repo,
	slice,
	{ runner = [], before = [], cwd = repo, env } = {},
) => {
	const out = join(tempDir(), "out.json");
	const run = runHelper(
		[
			"--commit",
			slice,
			...before,
			"--",
			NODE,
			join(repo, "rec.mjs"),
			"--out",
			out,
			...runner,
		],
		cwd,
		env,
	);
	let seen;
	try {
		seen = JSON.parse(readFileSync(out, "utf-8"));
	} catch {
		seen = undefined;
	}
	return { ...run, seen };
};

describe("Python scratch copy and import guard (S2-scratch-copy)", () => {
	it(
		"B20: a slice that changes uv.lock prints the dependencies diagnostic",
		() => {
			const { repo } = baseRepo();
			put(repo, "tests/a.test.mjs", "export {};\n");
			put(repo, "uv.lock", "version = 1\n");
			const slice = commitAll(repo, "slice");
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect.soft(run.status).toBe(0);
			expect
				.soft(run.lines)
				.toContain("diagnostic: dependencies changed: uv.lock");
		},
		TEST_TIMEOUT,
	);

	const SUB_A = "1".repeat(40);
	const SUB_B = "2".repeat(40);
	const base = (path) => `b:${path}\n`;
	const changed = (path) => `c:${path}\n`;

	it(
		"B13: a Python run writes every changed test-tree file but its support code, removes deleted ones, names submodules and keeps production files",
		() => {
			const BASE_FILES = [
				"tests/conftest.py",
				"tests/helpers.py",
				"tests/golden/old.json",
				"src/demo/__init__.py",
				"src/demo/old.py",
				// D19: a test-named production folder stays out of the copy.
				"src/demo/test/utils.py",
			];
			const { repo } = baseRepo(
				Object.fromEntries(BASE_FILES.map((path) => [path, base(path)])),
			);
			git(
				repo,
				"update-index",
				"--add",
				"--cacheinfo",
				`160000,${SUB_A},tests/data`,
			);
			git(repo, "commit", "-q", "--amend", "--no-edit");
			const CHANGED = [
				"tests/test_ok.py",
				"tests/conftest.py",
				"tests/__init__.py",
				"tests/golden/out.json",
				"tests/helpers.py",
				"tests/fixtures/x.json",
				"tests/requirements.txt",
				"conftest.py",
				"src/pkg/conftest.py",
				"src/demo/__init__.py",
				"src/demo/test/utils.py",
				"uv.lock",
			];
			for (const path of CHANGED) put(repo, path, changed(path));
			drop(repo, "tests/golden/old.json");
			drop(repo, "src/demo/old.py");
			const slice = commitAll(repo, "slice", { "tests/data": SUB_B });
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect.soft(run.status).toBe(0);
			expect.soft(headerBody(run.lines)).toEqual([
				"test: tests/test_ok.py",
				"fixture: conftest.py",
				"fixture: src/pkg/conftest.py",
				"fixture: tests/conftest.py",
				"fixture: tests/fixtures/x.json",
				"fixture: tests/golden/out.json",
				"fixture: tests/requirements.txt",
				"removed: tests/golden/old.json",
				// From odin#17 on, support code keeps its base version and is named.
				"diagnostic: not overlaid: tests/__init__.py (not a test file: support code runs at its base version)",
				"diagnostic: not overlaid: tests/helpers.py (not a test file: support code runs at its base version)",
				"diagnostic: submodule not copied: tests/data",
				// From S2c on (B27), a production test folder is named.
				"diagnostic: production test folder not copied: src/demo/test/utils.py",
				"diagnostic: dependencies changed: tests/requirements.txt",
				"diagnostic: dependencies changed: uv.lock",
			]);
			expect.soft(run.lines.slice(-3, -2)).toEqual(["exit: 1"]);
			expect.soft(run.lines.at(-2)).toMatch(/^log: /);
			expect.soft(lastLine(run.lines)).toBe("result: red");
			const files = run.seen?.files ?? {};
			for (const path of [
				"tests/test_ok.py",
				"conftest.py",
				"src/pkg/conftest.py",
				"tests/conftest.py",
				"tests/fixtures/x.json",
				"tests/golden/out.json",
				"tests/requirements.txt",
			]) {
				expect.soft(files[path], path).toBe(changed(path));
			}
			expect.soft(Object.hasOwn(files, "tests/__init__.py")).toBe(false);
			for (const path of [
				"tests/helpers.py",
				"src/demo/__init__.py",
				"src/demo/old.py",
				"src/demo/test/utils.py",
			]) {
				expect.soft(files[path], path).toBe(base(path));
			}
			expect.soft(Object.hasOwn(files, "tests/golden/old.json")).toBe(false);

			// A file replaced by a folder: removed first, then the folder's file written.
			const folder = baseRepo({ "tests/golden": base("tests/golden") }).repo;
			drop(folder, "tests/golden");
			put(folder, "tests/golden/a.json", changed("tests/golden/a.json"));
			put(folder, "tests/test_ok.py", changed("tests/test_ok.py"));
			const folderSlice = commitAll(folder, "file becomes folder");
			const replaced = recRun(folder, folderSlice, { runner: ["--code", "1"] });
			expect.soft(replaced.status).toBe(0);
			expect.soft(replaced.lines).toContain("removed: tests/golden");
			expect.soft(replaced.lines).toContain("fixture: tests/golden/a.json");
			expect
				.soft(replaced.seen?.files?.["tests/golden/a.json"])
				.toBe(changed("tests/golden/a.json"));
			expect.soft(lastLine(replaced.lines)).toBe("result: red");

			// A deleted submodule entry is named, never removed.
			const sub = baseRepo().repo;
			git(
				sub,
				"update-index",
				"--add",
				"--cacheinfo",
				`160000,${SUB_A},tests/data`,
			);
			git(sub, "commit", "-q", "--amend", "--no-edit");
			git(sub, "update-index", "--force-remove", "tests/data");
			put(sub, "tests/test_ok.py", changed("tests/test_ok.py"));
			const subSlice = commitAll(sub, "drop the submodule");
			const gone = recRun(sub, subSlice, { runner: ["--code", "1"] });
			expect.soft(gone.status).toBe(0);
			expect
				.soft(gone.lines)
				.toContain("diagnostic: submodule not copied: tests/data");
			expect
				.soft(gone.lines.filter((line) => line.startsWith("removed: ")))
				.toEqual([]);
			expect.soft(lastLine(gone.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B27: a Python run names each production test folder path it does not copy and copies fixture folders under src",
		() => {
			const PROD = ["src/demo/test/utils.py", "py/src/demo/test/x.py"];
			const { repo } = baseRepo(
				Object.fromEntries(PROD.map((path) => [path, base(path)])),
			);
			for (const path of [
				"tests/test_ok.py",
				...PROD,
				"src/demo/fixtures/data.json",
			]) {
				put(repo, path, changed(path));
			}
			const slice = commitAll(repo, "slice");
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect
				.soft(headerBody(run.lines))
				.toEqual([
					"test: tests/test_ok.py",
					"fixture: src/demo/fixtures/data.json",
					"diagnostic: production test folder not copied: py/src/demo/test/x.py",
					"diagnostic: production test folder not copied: src/demo/test/utils.py",
				]);
			for (const path of PROD) {
				expect.soft(run.seen?.files?.[path], path).toBe(base(path));
			}
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B28: a Python run names a changed symlink and keeps its base state",
		() => {
			const { repo } = baseRepo({ "tests/data.json": base("tests/data.json") });
			drop(repo, "tests/data.json");
			put(repo, "tests/test_ok.py", changed("tests/test_ok.py"));
			git(repo, "add", "-A");
			const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
				cwd: repo,
				input: "other.json",
				encoding: "utf-8",
			}).trim();
			git(
				repo,
				"update-index",
				"--add",
				"--cacheinfo",
				`120000,${blob},tests/data.json`,
			);
			git(repo, "commit", "-q", "-m", "file becomes a link");
			const slice = git(repo, "rev-parse", "HEAD");
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect
				.soft(headerBody(run.lines))
				.toEqual([
					"test: tests/test_ok.py",
					"diagnostic: symlink not copied: tests/data.json",
				]);
			expect
				.soft(run.seen?.files?.["tests/data.json"])
				.toBe(base("tests/data.json"));
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B29: a Python run writes a folder replaced by a file in the same slice",
		() => {
			const { repo } = baseRepo({
				"tests/golden/a.json": base("tests/golden/a.json"),
			});
			drop(repo, "tests/golden");
			put(repo, "tests/golden", changed("tests/golden"));
			put(repo, "tests/test_ok.py", changed("tests/test_ok.py"));
			const slice = commitAll(repo, "folder becomes file");
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect.soft(run.stderr).toBe("");
			expect.soft(run.lines).toContain("removed: tests/golden/a.json");
			expect.soft(run.lines).toContain("fixture: tests/golden");
			expect
				.soft(run.seen?.files?.["tests/golden"])
				.toBe(changed("tests/golden"));
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B30: a moved conftest is removed and written, a deleted test stays out of {tests}, an e2e test is in it, and the header names every Python line",
		() => {
			const moved = baseRepo({
				"tests/conftest.py": base("tests/conftest.py"),
			}).repo;
			drop(moved, "tests/conftest.py");
			put(moved, "tests/unit/conftest.py", changed("tests/unit/conftest.py"));
			put(moved, "tests/test_ok.py", changed("tests/test_ok.py"));
			const movedRun = recRun(moved, commitAll(moved, "move"), {
				runner: ["--code", "1"],
			});
			expect.soft(movedRun.lines).toContain("removed: tests/conftest.py");
			expect.soft(movedRun.lines).toContain("fixture: tests/unit/conftest.py");
			expect
				.soft(Object.hasOwn(movedRun.seen?.files ?? {}, "tests/conftest.py"))
				.toBe(false);

			const { repo } = baseRepo({
				"tests/test_old.py": base("tests/test_old.py"),
			});
			drop(repo, "tests/test_old.py");
			for (const path of ["tests/test_ok.py", "e2e/test_flow.py"]) {
				put(repo, path, changed(path));
			}
			const run = recRun(repo, commitAll(repo, "slice"), {
				runner: ["{tests}", "--code", "1"],
			});
			const args = run.seen?.args ?? [];
			expect
				.soft(
					args
						.slice(0, args.indexOf("--code"))
						.filter((a) => a.endsWith(".py")),
				)
				.toEqual(["e2e/test_flow.py", "tests/test_ok.py"]);
			expect.soft(run.lines).toContain("removed: tests/test_old.py");

			for (const path of [
				"skills/_shared/reprove-red.mjs",
				"opencode/generated/skills/_shared/reprove-red.mjs",
			]) {
				const lines = readFileSync(join(ROOT, path), "utf-8").split(/\r?\n/);
				const end = lines.findIndex((line) => !line.startsWith("//"));
				const header = lines.slice(0, end).join(" ");
				for (const text of [
					"removed:",
					"submodule not copied",
					"symlink not copied",
					"production test folder not copied",
					"PYTHONDONTWRITEBYTECODE",
				]) {
					expect.soft(header, `${path}: ${text}`).toContain(text);
				}
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"B31: a Python run from a junction to the top folder accepts a link and a run that is not a Python run keeps the broken call",
		() => {
			const py = pythonSlice();
			put(py.repo, ".venv/x.py", "");
			const via = join(tempDir(), "via");
			symlinkSync(py.repo, via, "junction");
			const run = recRun(py.repo, py.slice, {
				before: ["--link", ".venv"],
				runner: ["--code", "1"],
				cwd: via,
			});
			expect.soft(run.stderr).toBe("");
			expect.soft(lastLine(run.lines)).toBe("result: red");

			const js = sliceOf(["tests/a.test.mjs"]);
			put(js.repo, ".venv/x.py", "");
			const jsVia = join(tempDir(), "via");
			symlinkSync(js.repo, jsVia, "junction");
			const plain = recRun(js.repo, js.slice, {
				before: ["--link", ".venv"],
				runner: ["--code", "1"],
				cwd: jsVia,
			});
			expect.soft(plain.status).toBe(2);
			expect
				.soft(plain.stderr.split(/\r?\n/)[0])
				.toBe("reprove-red: broken: link target outside the repository: .venv");
		},
		TEST_TIMEOUT,
	);

	it(
		"B14: a run that is not a Python run keeps today's copy and header",
		() => {
			const KEPT = [
				"tests/helpers.mjs",
				"tests/conftest.py",
				"tests/golden/old.json",
			];
			const { repo } = baseRepo(
				Object.fromEntries(KEPT.map((path) => [path, base(path)])),
			);
			for (const path of [
				"tests/a.test.mjs",
				"tests/helpers.mjs",
				"tests/conftest.py",
			]) {
				put(repo, path, changed(path));
			}
			drop(repo, "tests/golden/old.json");
			const slice = commitAll(repo, "slice");
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect.soft(run.status).toBe(0);
			expect.soft(headerBody(run.lines)).toEqual(["test: tests/a.test.mjs"]);
			const files = run.seen?.files ?? {};
			for (const path of KEPT) expect.soft(files[path], path).toBe(base(path));
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	/** The paths `{tests}` expanded to: the recorder's arguments before `--code`. */
	const expanded = (run) => {
		const args = run.seen?.args ?? [];
		return args.slice(2, args.indexOf("--code"));
	};
	/** A repository with the recorder, and a slice commit adding `paths`. */
	const sliceOf = (paths) => {
		const { repo } = baseRepo();
		for (const path of paths) put(repo, path, changed(path));
		return { repo, slice: commitAll(repo, "slice") };
	};

	it(
		"B16: in a Python run {tests} holds only the Python runner tests; other changed tests are copied as fixtures",
		() => {
			const PATHS = [
				"tests/test_ok.py",
				"tests/fixtures/py/tests/test_data.py",
				"tests/fixtures/js/a.test.mjs",
				"src/test/resources/helper.py",
				"docker-compose.test.yml",
				// A support file sorts in with the non-runner tests: one fixture list.
				"tests/conftest.py",
			];
			const { repo, slice } = sliceOf(PATHS);
			const run = recRun(repo, slice, { runner: ["{tests}", "--code", "2"] });
			expect.soft(run.status).toBe(0);
			expect.soft(expanded(run)).toEqual(["tests/test_ok.py"]);
			expect
				.soft(headerBody(run.lines))
				.toEqual([
					"test: tests/test_ok.py",
					"fixture: docker-compose.test.yml",
					"fixture: src/test/resources/helper.py",
					"fixture: tests/conftest.py",
					"fixture: tests/fixtures/js/a.test.mjs",
					"fixture: tests/fixtures/py/tests/test_data.py",
				]);
			for (const path of PATHS) {
				expect.soft(run.seen?.files?.[path], path).toBe(changed(path));
			}
			expect
				.soft(lastLine(run.lines))
				.toBe(
					"result: broken: exit 2 (pytest: collection error or interrupted)",
				);

			const sub = sliceOf(["py/tests/test_ok.py"]);
			const fromPy = recRun(sub.repo, sub.slice, {
				runner: ["{tests}", "--code", "1"],
				cwd: join(sub.repo, "py"),
			});
			expect.soft(fromPy.lines).toContain("test: py/tests/test_ok.py");
			expect.soft(expanded(fromPy)).toEqual(["tests/test_ok.py"]);
			expect.soft(lastLine(fromPy.lines)).toBe("result: red");

			const other = sliceOf([
				"tests/a.test.mjs",
				"tests/fixtures/py/tests/test_ok.py",
			]);
			const notPython = recRun(other.repo, other.slice, {
				runner: ["{tests}", "--code", "1"],
			});
			expect
				.soft(expanded(notPython))
				.toEqual(["tests/a.test.mjs", "tests/fixtures/py/tests/test_ok.py"]);
			expect
				.soft(headerBody(notPython.lines))
				.toEqual([
					"test: tests/a.test.mjs",
					"test: tests/fixtures/py/tests/test_ok.py",
				]);
			expect.soft(lastLine(notPython.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B16: from a junction to the top folder, a Python run expands {tests} from real paths and a run that is not a Python run keeps its pre-S2 run folder",
		() => {
			const py = sliceOf(["tests/test_ok.py"]);
			const pyVia = join(tempDir(), "via");
			symlinkSync(py.repo, pyVia, "junction");
			const fromLink = recRun(py.repo, py.slice, {
				runner: ["{tests}", "--code", "1"],
				cwd: pyVia,
			});
			expect.soft(fromLink.status).toBe(0);
			expect.soft(expanded(fromLink)).toEqual(["tests/test_ok.py"]);
			expect.soft(lastLine(fromLink.lines)).toBe("result: red");

			// Outside a Python run the run folder is computed as before S2. On Windows a
			// junction caller is a broken call naming its folder, never a run with misplaced
			// {tests} or a run outside the scratch copy (rpiv issue draft
			// 20261123-151137-84f5c6f8 moved the scratch copy out of the git dir); on POSIX
			// the caller's folder is already a real path, so it runs.
			const js = sliceOf(["tests/a.test.mjs"]);
			const jsVia = join(tempDir(), "via");
			symlinkSync(js.repo, jsVia, "junction");
			const plain = recRun(js.repo, js.slice, {
				runner: ["{tests}", "--code", "1"],
				cwd: jsVia,
			});
			const BEFORE_S2 =
				process.platform === "win32"
					? {
							status: 2,
							last: undefined,
							stderr:
								/^reprove-red: broken: caller's folder outside the top folder: /,
						}
					: { status: 0, last: "result: red", stderr: /^$/ };
			expect.soft(plain.status).toBe(BEFORE_S2.status);
			expect.soft(lastLine(plain.lines)).toBe(BEFORE_S2.last);
			expect.soft(plain.stderr.split(/\r?\n/)[0]).toMatch(BEFORE_S2.stderr);
		},
		TEST_TIMEOUT,
	);

	/** The runner's PYTHONPATH entries. */
	const pythonPath = (run) => (run.seen?.env.PYTHONPATH ?? "").split(delimiter);
	/** True when `path` lies inside `folder` (or is it). */
	const inside = (folder, path) => {
		const rel = relative(folder, path);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	const NO_BYTECODE_SET = { PYTHONDONTWRITEBYTECODE: undefined };
	const CALLER_ENV = {
		...NO_BYTECODE_SET,
		PYTHONPATH: "/opt/extra",
		RPIV_PROBE: "1",
	};
	/** A Python-run slice changing `tests/test_ok.py` on a base holding `files`. */
	const pythonSlice = (files = {}) => {
		const { repo } = baseRepo(files);
		put(repo, "tests/test_ok.py", changed("tests/test_ok.py"));
		return { repo, slice: commitAll(repo, "slice") };
	};

	it(
		"B17: a Python run gets the caller's environment with the guard folder and src/ first on PYTHONPATH, bytecode off, and the generated guard",
		() => {
			const { repo, slice } = pythonSlice({
				"src/demo/__init__.py": base("src/demo/__init__.py"),
			});
			const env = CALLER_ENV;
			const run = recRun(repo, slice, { runner: ["--code", "1"], env });
			expect.soft(run.status).toBe(0);
			const entries = pythonPath(run);
			expect.soft(entries).toHaveLength(3);
			const [guard] = entries;
			expect
				.soft(inside(repo, guard), `guard ${guard} outside the checkout`)
				.toBe(false);
			expect
				.soft(run.seen?.guard?.dir, "guard holds sitecustomize.py and records/")
				.toBe(guard);
			expect
				.soft(entries.slice(1))
				.toEqual([join(run.seen?.cwd ?? "", "src"), "/opt/extra"]);
			expect.soft(run.seen?.env.PYTHONDONTWRITEBYTECODE).toBe("1");
			expect.soft(run.seen?.env.RPIV_PROBE).toBe("1");

			// The generated guard holds its own folder and the parts the records depend on.
			const site = run.seen?.guard?.site ?? "";
			expect.soft(site).toContain(guard.replaceAll("\\", "/"));
			for (const text of [
				"atexit.register",
				"os.register_at_fork",
				'"x"',
				'encoding="utf-8"',
				'"start: "',
				'"end: "',
				'"module: "',
				'"package: "',
				"sysconfig.get_paths()",
				"os.path.realpath",
				"list(sys.modules.values())",
			]) {
				expect.soft(site, text).toContain(text);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"B17: each Python run gets a fresh guard folder, gone after it whether the runner passed, failed or timed out",
		() => {
			const { repo, slice } = pythonSlice();
			const runs = [
				recRun(repo, slice, { runner: ["--code", "1"], env: CALLER_ENV }),
				recRun(repo, slice, { runner: ["--code", "2"], env: CALLER_ENV }),
				recRun(repo, slice, {
					before: ["--timeout", "1"],
					runner: ["--sleep", "10"],
					env: CALLER_ENV,
				}),
			];
			expect.soft(runs.map((run) => run.status)).toEqual([0, 0, 2]);
			const guards = runs.map((run) => pythonPath(run)[0]);
			expect.soft(new Set(guards).size).toBe(3);
			for (const folder of guards) {
				expect.soft(existsSync(folder), `${folder} removed`).toBe(false);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"B17: PYTHONPATH holds only the guard without src/ or a caller entry, and the run folder's own src/ from a sub-folder",
		() => {
			const bare = pythonSlice();
			const alone = recRun(bare.repo, bare.slice, {
				runner: ["--code", "1"],
				env: { ...NO_BYTECODE_SET, PYTHONPATH: "" },
			});
			expect.soft(pythonPath(alone)).toHaveLength(1);
			expect.soft(alone.seen?.guard?.dir).toBe(pythonPath(alone)[0]);

			// From py/, the run folder's own src/ comes second.
			const nested = baseRepo({
				"src/a.py": base("src/a.py"),
				"py/src/b.py": base("py/src/b.py"),
			}).repo;
			put(nested, "py/tests/test_ok.py", changed("py/tests/test_ok.py"));
			const nestedSlice = commitAll(nested, "slice");
			const fromPy = recRun(nested, nestedSlice, {
				runner: ["--code", "1"],
				cwd: join(nested, "py"),
				env: NO_BYTECODE_SET,
			});
			expect
				.soft(pythonPath(fromPy)[1])
				.toBe(join(fromPy.seen?.cwd ?? "", "src"));
			expect.soft(fromPy.seen?.cwd.replaceAll("\\", "/")).toMatch(/\/py$/);
		},
		TEST_TIMEOUT,
	);

	it.runIf(process.platform === "win32")(
		"B17: on Windows, the guard folder is removed even when removing the scratch copy fails",
		() => {
			const { repo, slice } = pythonSlice();
			const LINGER_SECONDS = 4;
			// A detached child working inside the scratch copy makes its removal fail.
			const run = recRun(repo, slice, {
				runner: ["--linger", String(LINGER_SECONDS), "--code", "1"],
				env: CALLER_ENV,
			});
			const [guard] = pythonPath(run);
			expect.soft(run.status, "the scratch removal failed").toBe(2);
			expect.soft(guard, "the runner saw a guard folder").toBeTruthy();
			expect.soft(existsSync(guard), `${guard} removed`).toBe(false);
			// Let the child end so the temporary folders can be removed.
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				(LINGER_SECONDS + 1) * 1000,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"B17: a temporary folder inside the checkout is a broken call, and a run that is not a Python run keeps the caller's environment",
		() => {
			const { repo, slice } = pythonSlice();
			const tmp = join(repo, "tmp");
			mkdirSync(tmp);
			const inCheckout = recRun(repo, slice, {
				runner: ["--code", "0"],
				env: { TMP: tmp, TEMP: tmp, TMPDIR: tmp },
			});
			expect.soft(inCheckout.status).toBe(2);
			expect.soft(inCheckout.stdout).toBe("");
			expect
				.soft(inCheckout.stderr.split(/\r?\n/)[0])
				.toMatch(
					/^reprove-red: broken: temporary folder inside the checkout: \S/,
				);
			expect.soft(inCheckout.seen).toBeUndefined();

			// A run that is not a Python run gets the caller's environment unchanged.
			const js = sliceOf(["tests/a.test.mjs"]);
			const plain = recRun(js.repo, js.slice, {
				runner: ["--code", "1"],
				env: { ...NO_BYTECODE_SET, PYTHONPATH: "/opt/extra" },
			});
			expect.soft(plain.seen?.env.PYTHONPATH).toBe("/opt/extra");
			expect.soft(plain.seen?.env.PYTHONDONTWRITEBYTECODE).toBeNull();
		},
		TEST_TIMEOUT,
	);

	const ADD = "tests/test_ok.py::test_b1_add";
	const CHECKOUT = "result: broken: imported from the checkout: ";
	const slash = (path) => path.replaceAll("\\", "/");

	/** A pytest report that lacks `ADD`. */
	const lackingReport = () => {
		const path = join(tempDir(), "report.xml");
		writeFileSync(
			path,
			'<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest"><testcase classname="tests.test_ok" name="other"/></testsuite></testsuites>',
		);
		return path;
	};

	/** A record file's text; `{cwd}` is the run folder, `{guard}` the guard folder. */
	const recordText = ({
		modules = [],
		packages = ["{guard}"],
		pid = 10,
		eol = "\n",
	}) =>
		[
			`start: ${pid}`,
			...packages.map((path) => `package: ${path}`),
			...modules.map((path) => `module: ${path}`),
			`end: ${pid}`,
			"",
		].join(eol);

	/** The helper on `slice` naming `ADD`, the recorder writing `records` (`{ name: text }`)
	    and copying a report that lacks `ADD`, with exit `code`. */
	const guardedRun = (
		repo,
		slice,
		{ records, code, before = [], cwd, names = [ADD] },
	) => {
		const spec = join(tempDir(), "records.json");
		writeFileSync(
			spec,
			JSON.stringify(
				Object.entries(records).map(([name, text]) => ({ name, text })),
			),
		);
		return recRun(repo, slice, {
			before: [...names.flatMap((name) => ["--test", name]), ...before],
			runner: [
				"--copy",
				lackingReport(),
				"--junitxml={junit}",
				"--records",
				spec,
				"--code",
				String(code),
			],
			cwd,
		});
	};
	const resultOf = (run) =>
		run.lines.filter((line) => line.startsWith("test-result: "));

	it(
		"B18: through the CLI, a module from any checkout folder makes the run line broken whatever the exit code",
		() => {
			const { repo, slice } = sliceOf(["tests/test_ok.py"]);
			const top = realOf(repo);
			const ROWS = [
				// [label, record modules, extra options, exit, named test, last line]
				[
					"checkout, exit 0",
					[join(top, "src/demo/util.py"), join(top, "src/demo/__init__.py")],
					[],
					0,
					"unavailable",
					`${CHECKOUT}src/demo/util.py`,
				],
				[
					"checkout, exit 2",
					[join(top, "src/demo/__init__.py")],
					[],
					2,
					"unavailable",
					`${CHECKOUT}src/demo/__init__.py`,
				],
				[
					"scratch",
					["{cwd}/src/demo/__init__.py"],
					[],
					0,
					"not-found",
					"result: green",
				],
				[
					"link target",
					[join(top, ".venv/Lib/site-packages/x.py")],
					["--link", ".venv"],
					1,
					"not-found",
					"result: red",
				],
			];
			put(repo, ".venv/Lib/site-packages/x.py", "");
			for (const [label, modules, before, code, bucket, last] of ROWS) {
				const run = guardedRun(repo, slice, {
					records: { a: recordText({ modules }) },
					code,
					before,
				});
				expect.soft(run.status, label).toBe(0);
				expect.soft(run.lines, label).toContain(`exit: ${code}`);
				expect
					.soft(resultOf(run), label)
					.toEqual([`test-result: ${bucket} ${ADD}`]);
				expect.soft(lastLine(run.lines), label).toBe(last);
			}

			// Another worktree of the same repository counts as the checkout.
			const other = join(tempDir(), "other");
			git(repo, "worktree", "add", "-q", "--detach", other, slice);
			const fromOther = guardedRun(repo, slice, {
				records: {
					a: recordText({ modules: [join(other, "src/demo/__init__.py")] }),
				},
				code: 0,
			});
			expect
				.soft(lastLine(fromOther.lines), "another worktree")
				.toBe(`${CHECKOUT}${slash(realOf(other))}/src/demo/__init__.py`);

			// Run from a linked worktree: its scratch copy lies under the main checkout's git
			// dir, and a package folder inside the main checkout exempts its venv.
			const wt = join(tempDir(), "wt");
			git(repo, "worktree", "add", "-q", "--detach", wt, slice);
			const fromWt = guardedRun(repo, slice, {
				records: {
					a: recordText({
						modules: [
							"{cwd}/src/x.py",
							join(top, ".venv/Lib/site-packages/x.py"),
						],
						packages: [join(top, ".venv/Lib/site-packages")],
					}),
				},
				code: 1,
				cwd: wt,
			});
			expect
				.soft(resultOf(fromWt), "linked worktree")
				.toEqual([`test-result: not-found ${ADD}`]);
			expect
				.soft(lastLine(fromWt.lines), "linked worktree")
				.toBe("result: red");

			// Run from a junction (Windows) or symlink that leads to the top folder.
			const via = join(tempDir(), "via");
			symlinkSync(repo, via, "junction");
			const fromLink = guardedRun(repo, slice, {
				records: {
					a: recordText({ modules: [join(top, "src/demo/__init__.py")] }),
				},
				code: 0,
				cwd: via,
			});
			expect
				.soft(lastLine(fromLink.lines), "run from a link")
				.toBe(`${CHECKOUT}src/demo/__init__.py`);
		},
		TEST_TIMEOUT,
	);

	it(
		"B19: through the CLI, no record reads import guard did not run and an incomplete one reads import record incomplete, whatever the exit code",
		() => {
			const { repo, slice } = sliceOf(["tests/test_ok.py"]);
			for (const code of [0, 1, 5]) {
				const run = guardedRun(repo, slice, { records: {}, code, names: [] });
				expect.soft(run.status, `exit ${code}`).toBe(0);
				expect.soft(run.lines, `exit ${code}`).toContain(`exit: ${code}`);
				expect
					.soft(lastLine(run.lines), `exit ${code}`)
					.toBe("result: broken: import guard did not run");
			}
			const partial = guardedRun(repo, slice, {
				records: { a: "start: 10\n" },
				code: 1,
			});
			expect
				.soft(resultOf(partial))
				.toEqual([`test-result: unavailable ${ADD}`]);
			expect
				.soft(lastLine(partial.lines))
				.toBe("result: broken: import record incomplete: pid 10");

			// A run that is not a Python run needs no record.
			const js = sliceOf(["tests/a.test.mjs"]);
			const plain = guardedRun(js.repo, js.slice, {
				records: {},
				code: 0,
				names: [],
			});
			expect.soft(lastLine(plain.lines)).toBe("result: green");
		},
		TEST_TIMEOUT,
	);

	it("B21: the leading header comment of reprove-red names the Python run copy, {tests}, the guard and its three run lines", () => {
		for (const path of [
			"skills/_shared/reprove-red.mjs",
			"opencode/generated/skills/_shared/reprove-red.mjs",
		]) {
			const lines = readFileSync(join(ROOT, path), "utf-8").split(/\r?\n/);
			const end = lines.findIndex((line) => !line.startsWith("//"));
			const header = lines
				.slice(0, end < 0 ? undefined : end)
				.map((line) => line.replace(/^\/\/\s?/, ""))
				.join(" ");
			for (const text of [
				"result: broken: imported from the checkout",
				"result: broken: import guard did not run",
				"result: broken: import record incomplete",
				"PYTHONPATH",
				"conftest.py",
			]) {
				expect.soft(header, `${path}: ${text}`).toContain(text);
			}
			const sentences = header.split(/(?<=\.)\s+/);
			expect
				.soft(
					sentences.some(
						(s) => s.includes("{tests}") && s.includes("Python runner tests"),
					),
					`${path}: one sentence names {tests} and Python runner tests`,
				)
				.toBe(true);
		}
	});

	const tmpEnv = (dir) => ({ TMP: dir, TEMP: dir, TMPDIR: dir });

	it(
		"B24: a temporary folder whose real path lies in any checkout folder is a broken call before anything is made",
		() => {
			const { repo, slice } = pythonSlice();
			const refused = (dir, label, real = dir) => {
				const run = recRun(repo, slice, {
					runner: ["--code", "0"],
					env: tmpEnv(dir),
				});
				expect.soft(run.status, label).toBe(2);
				expect.soft(run.stdout, label).toBe("");
				expect
					.soft(run.stderr.split(/\r?\n/)[0], label)
					.toBe(
						`reprove-red: broken: temporary folder inside the checkout: ${realOf(real)}`,
					);
				expect.soft(run.seen, label).toBeUndefined();
				expect.soft(readdirSync(real), label).toEqual([]);
			};
			const inTop = join(repo, "tmp");
			mkdirSync(inTop);
			refused(inTop, "in the top folder");

			const other = join(tempDir(), "other");
			git(repo, "worktree", "add", "-q", other);
			mkdirSync(join(other, "tmp"));
			refused(join(other, "tmp"), "in another worktree");

			const link = join(tempDir(), "tmp-link");
			symlinkSync(inTop, link, "junction");
			refused(link, "through a link", inTop);

			const sibling = `${repo}2`;
			mkdirSync(join(sibling, "tmp"), { recursive: true });
			try {
				const run = recRun(repo, slice, {
					runner: ["--code", "1"],
					env: tmpEnv(join(sibling, "tmp")),
				});
				expect
					.soft(lastLine(run.lines), "a sibling folder")
					.toBe("result: red");
			} finally {
				rmSync(sibling, { recursive: true, force: true });
			}

			const js = sliceOf(["tests/a.test.mjs"]);
			mkdirSync(join(js.repo, "tmp"));
			const plain = recRun(js.repo, js.slice, {
				runner: ["--code", "1"],
				env: tmpEnv(join(js.repo, "tmp")),
			});
			expect
				.soft(lastLine(plain.lines), "not a Python run")
				.toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"B25: through the CLI the guard line wins at every exit code, a missing named test reads unavailable, and the incomplete line names the pid",
		() => {
			const { repo, slice } = sliceOf(["tests/test_ok.py"]);
			const top = realOf(repo);
			const inTop = recordText({
				modules: [join(top, "src/demo/__init__.py")],
			});
			const clean = recordText({ modules: ["{cwd}/x.py"] });
			const DID_NOT_RUN = "result: broken: import guard did not run";
			const INCOMPLETE = "result: broken: import record incomplete: pid ";
			const ROWS = [
				[{ a: inTop }, 1, "unavailable", `${CHECKOUT}src/demo/__init__.py`],
				[{ a: inTop }, 5, "unavailable", `${CHECKOUT}src/demo/__init__.py`],
				[{}, 1, "unavailable", DID_NOT_RUN],
				[{}, 2, "unavailable", DID_NOT_RUN],
				[{ a: "start: 10\n" }, 5, "unavailable", `${INCOMPLETE}10`],
				[{ a: "" }, 0, "unavailable", `${INCOMPLETE}unknown`],
				[{ a: clean, b: "start: 11\n" }, 1, "unavailable", `${INCOMPLETE}11`],
				[
					{ a: "start: 12\n", b: "start: 11\n" },
					0,
					"unavailable",
					`${INCOMPLETE}12`,
				],
				[
					{ a: "start: 10\nmodule: {cwd}/x.py\nend: 11\n" },
					0,
					"unavailable",
					`${INCOMPLETE}10`,
				],
				[
					{ a: "start: x\nend: 10\n" },
					0,
					"unavailable",
					`${INCOMPLETE}unknown`,
				],
				[{ a: clean }, 1, "not-found", "result: red"],
			];
			for (const [records, code, bucket, want] of ROWS) {
				const label = `${JSON.stringify(Object.keys(records))} exit ${code}`;
				const run = guardedRun(repo, slice, { records, code });
				expect.soft(run.status, label).toBe(0);
				expect.soft(run.lines, label).toContain(`exit: ${code}`);
				expect
					.soft(resultOf(run), label)
					.toEqual([`test-result: ${bucket} ${ADD}`]);
				expect.soft(lastLine(run.lines), label).toBe(want);
			}
			for (const path of [
				"skills/_shared/reprove-red.mjs",
				"opencode/generated/skills/_shared/reprove-red.mjs",
			]) {
				const lines = readFileSync(join(ROOT, path), "utf-8").split(/\r?\n/);
				const end = lines.findIndex((line) => !line.startsWith("//"));
				const header = lines
					.slice(0, end)
					.map((line) => line.replace(/^\/\/\s?/, ""))
					.join(" ");
				expect.soft(header, path).toContain("import record incomplete: pid");
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"B26: a Python run in a repository whose linked worktree folder was deleted keeps its run line",
		() => {
			const { repo, slice } = pythonSlice();
			const gone = join(tempDir(), "gone");
			git(repo, "worktree", "add", "-q", gone);
			rmSync(gone, { recursive: true, force: true });
			const run = recRun(repo, slice, { runner: ["--code", "1"] });
			expect.soft(run.stderr).toBe("");
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it.runIf(process.platform === "win32")(
		"B18: on Windows, a checkout path in another letter case, with backslashes, a space and CRLF lines, still counts",
		() => {
			const repo = join(tempDir(), "my repo");
			newRepo(repo);
			put(repo, "rec.mjs", RECORDER);
			put(repo, "src/demo/__init__.py", base("src/demo/__init__.py"));
			commitAll(repo, "base");
			put(repo, "tests/test_ok.py", changed("tests/test_ok.py"));
			const slice = commitAll(repo, "slice");
			const top = realOf(repo);
			const swapCase = (path) =>
				path
					.replaceAll("/", "\\")
					.replace(/[a-z]/gi, (ch) =>
						ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
					);
			const CRLF = { eol: "\r\n" };
			const inCheckout = guardedRun(repo, slice, {
				records: {
					a: recordText({
						modules: [swapCase(join(top, "src/demo/__init__.py"))],
						...CRLF,
					}),
				},
				code: 0,
			});
			expect
				.soft(lastLine(inCheckout.lines))
				.toBe(`${CHECKOUT}src/demo/__init__.py`);
			expect.soft(inCheckout.stdout).not.toContain("\r");

			put(repo, ".venv/x.py", "");
			const exempt = guardedRun(repo, slice, {
				records: {
					a: recordText({
						modules: [
							`{cwd}${swapCase("/src/demo/__init__.py")}`,
							swapCase(join(top, ".venv/x.py")),
						],
						...CRLF,
					}),
				},
				code: 1,
				before: ["--link", ".venv"],
			});
			expect.soft(lastLine(exempt.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);
});
