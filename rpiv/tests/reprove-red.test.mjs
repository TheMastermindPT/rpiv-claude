// tests/reprove-red.test.mjs — contract tests for skills/_shared/reprove-red.mjs and
// validate's re-proving of red (slice S14-validate-red, D23, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// The CLI is spawned in throwaway git repositories under the OS temp folder.

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/reprove-red.mjs");
const NODE = process.execPath;
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-reprove-red-"));
	dirs.push(dir);
	return dir;
};

const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A fresh repository with no commit. */
const newRepo = () => {
	const repo = tempDir();
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "s14@example.invalid");
	git(repo, "config", "user.name", "s14");
	git(repo, "config", "core.autocrlf", "false");
	return repo;
};

/** Writes `content` to `repo/path`, creating parent directories. */
const put = (repo, path, content) => {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
};

/** Commits everything in the working tree; returns the new commit's full SHA. */
const commitAll = (repo, message) => {
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
};

/** Exit code, stdout, stderr and stdout lines of the helper run in `cwd`. */
const runHelper = (args, cwd) => {
	const result = spawnSync(NODE, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 60_000,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		lines: result.stdout.split(/\r?\n/).filter(Boolean),
	};
};

/** `git rev-parse --git-path <path>` resolved against the repository. */
const gitPath = (repo, path) =>
	resolve(repo, git(repo, "rev-parse", "--git-path", path));
const scratchOf = (repo, sha) => gitPath(repo, `rpiv/reprove-red/${sha}`);

/** What "the checkout is untouched" compares. */
const snapshot = (repo) => ({
	status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
	head: git(repo, "rev-parse", "HEAD"),
	branch: git(repo, "branch", "--show-current"),
});

// The tiny runner: imports each path argument, prints PASS/FAIL, exits 1 on a failure.
const RUNNER = `import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const paths = process.argv.slice(2);
if (paths.length === 0) {
	console.log("NO TESTS");
	process.exit(0);
}
let failed = false;
for (const p of paths) {
	try {
		await import(pathToFileURL(resolve(p)).href);
		console.log(\`PASS \${p}\`);
	} catch (error) {
		failed = true;
		console.log(\`FAIL \${p}: \${error.message}\`);
	}
}
process.exit(failed ? 1 : 0);
`;

const BROKEN_SUM = "export const sum = () => 0;\n";
const GOOD_SUM = "export const sum = (a, b) => a + b;\n";
const SUM_TEST = `import { sum } from "../src/sum.mjs";
const got = sum(2, 3);
if (got !== 5) throw new Error(\`got \${got}\`);
`;

/** A repository whose base commit holds the runner, `src/sum.mjs` and a README. */
const baseRepo = (sum = BROKEN_SUM) => {
	const repo = newRepo();
	put(repo, "run.mjs", RUNNER);
	put(repo, "src/sum.mjs", sum);
	put(repo, "README.md", "old\n");
	return { repo, base: commitAll(repo, "base") };
};

const lastLine = (lines) => lines.at(-1);
const hasLineStarting = (lines, prefix) =>
	lines.some((line) => line.startsWith(prefix));

describe("reprove-red CLI", () => {
	it(
		"runs the slice's tests and fixtures on the parent commit and reports red",
		() => {
			const { repo, base } = baseRepo();
			put(repo, "src/sum.mjs", GOOD_SUM);
			put(repo, "README.md", "new\n");
			put(
				repo,
				"tests/sum.test.mjs",
				`import { readFileSync } from "node:fs";
import { sum } from "../src/sum.mjs";
const n = JSON.parse(readFileSync(new URL("./fixtures/n.json", import.meta.url), "utf8"));
if (n.v !== 1) throw new Error("fixture not applied");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").trim();
const got = sum(2, 3);
if (got !== 5) throw new Error(\`got \${got} readme \${readme}\`);
`,
			);
			put(repo, "tests/fixtures/n.json", '{"v":1}\n');
			const slice = commitAll(repo, "slice");
			const scratch = scratchOf(repo, slice);
			put(scratch, "junk.txt", "left from an earlier run\n");
			const before = snapshot(repo);

			const run = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				repo,
			);

			const log = gitPath(repo, `rpiv/reprove-red/${slice}.log`);
			expect(run.status).toBe(0);
			expect(run.lines).toEqual([
				`reprove-red: ${slice}`,
				`base: ${base}`,
				"test: tests/sum.test.mjs",
				"fixture: tests/fixtures/n.json",
				"exit: 1",
				`log: ${log}`,
				"result: red",
			]);
			expect(readFileSync(log, "utf-8")).toContain(
				"FAIL tests/sum.test.mjs: got 0 readme old",
			);
			expect(existsSync(scratch)).toBe(false);
			expect(existsSync(`${scratch}.index`)).toBe(false);
			expect(snapshot(repo)).toEqual(before);

			for (const rev of ["HEAD", slice.slice(0, 8)]) {
				const again = runHelper(
					["--commit", rev, "--", NODE, "run.mjs", "{tests}"],
					repo,
				);
				expect(again.lines[0]).toBe(`reprove-red: ${slice}`);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"reports green when the slice's tests pass on the parent commit",
		() => {
			const { repo } = baseRepo(GOOD_SUM);
			put(repo, "tests/sum.test.mjs", SUM_TEST);
			const slice = commitAll(repo, "slice");

			const run = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				repo,
			);

			expect(run.status).toBe(0);
			expect(run.lines).toContain("exit: 0");
			expect(lastLine(run.lines)).toBe("result: green");
			const log = gitPath(repo, `rpiv/reprove-red/${slice}.log`);
			expect(readFileSync(log, "utf-8")).toContain("PASS tests/sum.test.mjs");

			put(repo, "tests/a.test.mjs", "export {};\n");
			commitAll(repo, "a passing test");
			put(repo, "tests/a.test.mjs", 'throw new Error("now fails");\n');
			const modified = commitAll(repo, "rewrite a test");

			const rewritten = runHelper(
				["--commit", modified, "--", NODE, "run.mjs", "{tests}"],
				repo,
			);

			expect(rewritten.lines).toContain("test: tests/a.test.mjs");
			expect(lastLine(rewritten.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"reports no-tests and runs nothing when the commit changes no test file",
		() => {
			const { repo } = baseRepo();
			put(repo, "tests/old.test.mjs", "export {};\n");
			put(repo, "tests/fixtures/n.json", '{"v":1}\n');
			commitAll(repo, "with an old test");
			const marker = join(tempDir(), "ran.txt");
			const command = [
				"--",
				NODE,
				"-e",
				"require('fs').writeFileSync(process.argv[1], 'ran')",
				marker,
				"{junit}",
			];
			const noTestLines = (lines) =>
				["test: ", "exit:", "log:", "report:", "test-result:"].filter(
					(prefix) => hasLineStarting(lines, prefix),
				);

			put(repo, "src/sum.mjs", GOOD_SUM);
			const sourceOnly = commitAll(repo, "source only");
			rmSync(join(repo, "tests/old.test.mjs"));
			const deleteOnly = commitAll(repo, "delete a test");

			for (const slice of [sourceOnly, deleteOnly]) {
				const run = runHelper(
					["--commit", slice, "--test", "tests/x.test.mjs::x", ...command],
					repo,
				);
				expect(run.status).toBe(0);
				expect(lastLine(run.lines)).toBe("result: no-tests");
				expect(noTestLines(run.lines)).toEqual([]);
				expect(existsSync(marker)).toBe(false);
			}

			put(repo, "tests/fixtures/n.json", '{"v":2}\n');
			const fixtureOnly = commitAll(repo, "fixture only");
			const run = runHelper(
				["--commit", fixtureOnly, "--test", "tests/x.test.mjs::x", ...command],
				repo,
			);
			expect(lastLine(run.lines)).toBe("result: no-tests");
			expect(run.lines).toContain("fixture: tests/fixtures/n.json");
			expect(noTestLines(run.lines)).toEqual([]);
			expect(existsSync(marker)).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"runs in the caller's subdirectory and expands {tests} relative to it",
		() => {
			const repo = newRepo();
			put(repo, "pkg/run.mjs", RUNNER);
			put(repo, "pkg/src/sum.mjs", BROKEN_SUM);
			commitAll(repo, "base");
			put(repo, "pkg/tests/b.test.mjs", SUM_TEST);
			put(repo, "pkg/tests/a.test.mjs", SUM_TEST);
			const slice = commitAll(repo, "slice");
			const pkg = join(repo, "pkg");
			const log = () =>
				readFileSync(gitPath(repo, `rpiv/reprove-red/${slice}.log`), "utf-8");

			const run = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				pkg,
			);

			const testLines = run.lines.filter((line) => line.startsWith("test: "));
			expect(testLines).toEqual([
				"test: pkg/tests/a.test.mjs",
				"test: pkg/tests/b.test.mjs",
			]);
			const text = log();
			expect(text).toContain("FAIL tests/a.test.mjs");
			expect(text.indexOf("FAIL tests/a.test.mjs")).toBeLessThan(
				text.indexOf("FAIL tests/b.test.mjs"),
			);

			const bare = runHelper(["--commit", slice, "--", NODE, "run.mjs"], pkg);
			expect(log()).toContain("NO TESTS");
			expect(bare.lines).toContain("exit: 0");
			expect(lastLine(bare.lines)).toBe("result: green");

			const embedded = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "x{tests}"],
				pkg,
			);
			expect(log()).toContain("FAIL x{tests}:");
			expect(lastLine(embedded.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"links dependency folders, keeps them after cleanup, and warns on manifest changes",
		() => {
			const repo = newRepo();
			put(repo, "run.mjs", RUNNER);
			put(repo, "package.json", '{"name":"t"}\n');
			put(repo, ".gitignore", "node_modules/\n");
			commitAll(repo, "base");
			const dep = "export const answer = 42;\n";
			put(repo, "node_modules/dep/index.mjs", dep);
			put(
				repo,
				"tests/dep.test.mjs",
				`import { answer } from "../node_modules/dep/index.mjs";
if (answer !== 41) throw new Error(\`got \${answer}\`);
`,
			);
			const slice = commitAll(repo, "slice");
			const log = () =>
				readFileSync(gitPath(repo, `rpiv/reprove-red/${slice}.log`), "utf-8");

			const linked = runHelper(
				[
					"--commit",
					slice,
					"--link",
					"node_modules",
					"--",
					NODE,
					"run.mjs",
					"{tests}",
				],
				repo,
			);

			expect(lastLine(linked.lines)).toBe("result: red");
			expect(log()).toContain("got 42");
			expect(
				readFileSync(join(repo, "node_modules/dep/index.mjs"), "utf-8"),
			).toBe(dep);
			expect(hasLineStarting(linked.lines, "diagnostic:")).toBe(false);

			const unlinked = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				repo,
			);
			expect(lastLine(unlinked.lines)).toBe("result: red");
			expect(log()).toContain("FAIL tests/dep.test.mjs");
			expect(log()).not.toContain("got 42");

			put(repo, "package.json", '{"name":"t","version":"2.0.0"}\n');
			put(repo, "tests/dep2.test.mjs", "export {};\n");
			const manifest = commitAll(repo, "manifest change");
			const warned = runHelper(
				[
					"--commit",
					manifest,
					"--link",
					"node_modules",
					"--",
					NODE,
					"run.mjs",
					"{tests}",
				],
				repo,
			);
			const diagnostic = warned.lines.indexOf(
				"diagnostic: dependencies changed: package.json",
			);
			expect(diagnostic).toBeGreaterThan(-1);
			expect(diagnostic).toBeLessThan(
				warned.lines.findIndex((line) => line.startsWith("exit:")),
			);
		},
		TEST_TIMEOUT,
	);

	/** B74's broken calls: arguments, and the detail the first stderr line names. */
	const brokenCases = ({ slice, sourceOnly, base, merge, outside, runner }) => [
		[["--", NODE, "run.mjs"], "--commit"],
		[["--commit", slice], "command"],
		[["--commit", slice, "--"], "command"],
		[["--commit", "nope", ...runner], "unknown revision: nope"],
		[["--commit", base, ...runner], "has no parent"],
		[["--commit", merge, ...runner], "has 2 parents"],
		[
			["--commit", slice, "--link", "missing", ...runner],
			"link target missing: missing",
		],
		[
			["--commit", slice, "--test", "tests/a.test.mjs", ...runner, "{junit}"],
			"--test",
		],
		[
			["--commit", slice, "--test", "tests/a.test.mjs::x", ...runner],
			"--test needs {junit}",
		],
		[
			["--commit", slice, "--", "no-such-exe-s14"],
			"cannot start: no-such-exe-s14",
		],
		[
			[
				"--commit",
				slice,
				"--timeout",
				"1",
				"--",
				NODE,
				"-e",
				"setTimeout(() => {}, 5000)",
			],
			"timed out after 1s",
		],
		[["--commit", slice, "--timeout", "0", ...runner], "--timeout"],
		[["--commit", slice, "--timeout", "-3", ...runner], "--timeout"],
		[["--commit", slice, "--timeout", "abc", ...runner], "--timeout"],
		// Hardening after mutation (no new behavior): option edges.
		[["--commit", slice, "--timeout", "1abc", ...runner], "--timeout"],
		[["--commit", slice, "--frob", "x", ...runner], "unknown option: --frob"],
		[["--commit", slice, "--link"], "--link needs a value"],
		[
			["--commit", slice, "--test", "::x", ...runner, "{junit}"],
			"--test needs <path>::<name>",
		],
		[
			["--commit", slice, "--test", "tests/a.test.mjs::", ...runner, "{junit}"],
			"--test needs <path>::<name>",
		],
		// S14 revision 1: links are checked first and must stay inside the
		// repository, off the repository folder itself and off tracked files.
		[
			["--commit", sourceOnly, "--link", "missing", ...runner],
			"link target missing: missing",
		],
		[
			["--commit", slice, "--link", outside, ...runner],
			"link target outside the repository",
		],
		[
			["--commit", slice, "--link", ".", ...runner],
			"link target outside the repository: .",
		],
		[
			["--commit", slice, "--link", "src", ...runner],
			"link target holds tracked files: src",
		],
		// S14 revision 2: overlapping targets (either order) and the git folder.
		[
			[
				"--commit",
				slice,
				"--link",
				"node_modules",
				"--link",
				"node_modules/dep",
				...runner,
			],
			"link targets overlap: node_modules, node_modules/dep",
		],
		[
			[
				"--commit",
				slice,
				"--link",
				"node_modules/dep",
				"--link",
				"node_modules",
				...runner,
			],
			"link targets overlap: node_modules/dep, node_modules",
		],
		[
			["--commit", slice, "--link", ".git", ...runner],
			"link target inside the git folder: .git",
		],
	];

	it(
		"answers broken, exit 2 and no result for each broken call",
		() => {
			const { repo, base } = baseRepo();
			put(repo, "tests/a.test.mjs", SUM_TEST);
			const slice = commitAll(repo, "slice");
			put(repo, "src/sum.mjs", GOOD_SUM);
			const sourceOnly = commitAll(repo, "source only");
			git(repo, "switch", "-q", "-c", "side", base);
			put(repo, "tests/s.test.mjs", "export {};\n");
			commitAll(repo, "side");
			git(repo, "switch", "-q", "main");
			git(repo, "merge", "-q", "--no-ff", "-m", "merge", "side");
			const merge = git(repo, "rev-parse", "HEAD");
			const runner = ["--", NODE, "run.mjs", "{tests}"];
			const outside = tempDir();
			put(outside, "keep.txt", "keep\n");
			put(repo, "node_modules/dep/keep.txt", "keep\n");
			const before = snapshot(repo);

			const cases = brokenCases({
				slice,
				sourceOnly,
				base,
				merge,
				outside,
				runner,
			});
			for (const [args, detail] of cases) {
				const run = runHelper(args, repo);
				const first = run.stderr.split(/\r?\n/)[0];
				expect({ args, status: run.status }).toEqual({ args, status: 2 });
				expect(run.stdout).not.toContain("result:");
				expect(first.startsWith("reprove-red: broken: ")).toBe(true);
				expect(first).toContain(detail);
			}
			expect(existsSync(scratchOf(repo, slice))).toBe(false);
			expect(snapshot(repo)).toEqual(before);
			expect(readFileSync(join(repo, "src/sum.mjs"), "utf-8")).toBe(GOOD_SUM);
			expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("keep\n");
			expect(lstatSync(join(repo, "node_modules/dep")).isSymbolicLink()).toBe(
				false,
			);
			expect(
				readFileSync(join(repo, "node_modules/dep/keep.txt"), "utf-8"),
			).toBe("keep\n");

			const multiDigit = runHelper(
				["--commit", slice, "--timeout", "30", ...runner],
				repo,
			);
			expect(multiDigit.status).toBe(0);
			expect(lastLine(multiDigit.lines)).toBe("result: red");

			const notRepo = runHelper(["--commit", "HEAD", ...runner], outside);
			expect(notRepo.status).toBe(2);
			expect(notRepo.stdout).not.toContain("result:");
			expect(notRepo.stderr.startsWith("reprove-red: broken: ")).toBe(true);
			expect(notRepo.stderr.split(/\r?\n/)[0]).toContain("git");
		},
		TEST_TIMEOUT,
	);

	// S14 revision 1: a runner killed by a signal has no exit code (POSIX only; on
	// Windows a killed process reports a code), so the rule is tested on the result.
	// Imported here, not at the top, so this file still loads at S14's parent (where
	// the helper does not exist) and each named test fails on its own (S14 rev. 2, R2).
	it("turns a runner result into an exit code or a broken detail", async () => {
		const { exitCodeOf } = await import("../skills/_shared/reprove-red.mjs");
		expect(exitCodeOf({ status: 3 }, ["x"], 7)).toBe(3);
		expect(exitCodeOf({ status: 0 }, ["x"], 7)).toBe(0);
		expect(() =>
			exitCodeOf({ status: null, signal: "SIGKILL" }, ["x"], 7),
		).toThrow("runner ended without an exit code (SIGKILL)");
		expect(() =>
			exitCodeOf({ status: null, error: { code: "ETIMEDOUT" } }, ["x"], 7),
		).toThrow("timed out after 7s");
		expect(() =>
			exitCodeOf({ status: null, error: { code: "ENOENT" } }, ["x"], 7),
		).toThrow("cannot start: x");
	});

	// Shapes copied from vitest 4's real JUnit output (observed 2026-10-06): a file
	// that cannot load is one <testcase> named after the file; nested names use " > ".
	const REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="7" failures="3" errors="1">
    <testsuite name="tests/a.test.mjs" tests="6" failures="2" errors="1" skipped="1">
        <testcase classname="tests/a.test.mjs" name="grp &gt; passes" time="0.001">
        </testcase>
        <testcase classname="tests/a.test.mjs" name="grp &gt; fails a check" time="0.005">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 2 // Object.is equality
            </failure>
        </testcase>
        <testcase classname="tests/a.test.mjs" name="g1 &gt; same" time="0"></testcase>
        <testcase classname="tests/a.test.mjs" name="g2 &gt; same" time="0"><failure message="nope" type="Error"/></testcase>
        <testcase classname="tests/a.test.mjs" name="grp &gt; skipped one" time="0">
            <skipped/>
        </testcase>
        <testcase classname="tests/a.test.mjs" name="grp &gt; errs" time="0"><error message="boom" type="Error"/></testcase>
    </testsuite>
    <testsuite name="tests/load.test.mjs" tests="1" failures="1" errors="0" skipped="0">
        <testcase classname="tests/load.test.mjs" name="tests/load.test.mjs" time="0">
            <failure message="Cannot find module &apos;../src/missing.mjs&apos; imported from x" type="Error">
Error: Cannot find module &apos;../src/missing.mjs&apos; imported from x
            </failure>
        </testcase>
    </testsuite>
</testsuites>
`;
	const REPORT_COPIER = `import { copyFileSync } from "node:fs";
const [src, dst, code] = process.argv.slice(2);
copyFileSync(src, dst);
process.exit(Number(code));
`;

	// Hardening after mutation: a single <testsuite> root (pytest's shape),
	// single-quoted attributes, backslash paths, every entity form, a <failure>
	// without a message, and the three load-failure conditions.
	const REPORT_EDGES = `<?xml version="1.0"?>
<testsuite name="pytest">
  <testcase classname='tests\\c.test.mjs' name='q &quot;q&quot; &lt;t&gt; &amp; &#39;n&#39; &#x41;'>
    <failure>first &amp; line
second line</failure>
  </testcase>
  <testcase classname="tests/c.test.mjs" name="tests/c.test.mjs"></testcase>
  <testcase classname="tests/d.test.mjs" name="tests/c.test.mjs"><failure message="other file"/></testcase>
</testsuite>
`;

	/** The helper with one `--test` per name, its runner copying `fixture` to the report. */
	const reportRun = (repo, commit, names, fixture) =>
		runHelper(
			[
				"--commit",
				commit,
				...names.flatMap((name) => ["--test", name]),
				"--",
				NODE,
				"report.mjs",
				fixture,
				"{junit}",
				"1",
			],
			repo,
		);

	it(
		"sorts each named test into a bucket from the JUnit report",
		() => {
			const repo = newRepo();
			put(repo, "run.mjs", RUNNER);
			put(repo, "report.mjs", REPORT_COPIER);
			commitAll(repo, "base");
			put(repo, "tests/a.test.mjs", "export {};\n");
			put(repo, "tests/load.test.mjs", "export {};\n");
			put(repo, "tests/fixtures/report.xml", REPORT);
			put(repo, "tests/fixtures/bad.txt", "not xml at all\n");
			put(
				repo,
				"tests/fixtures/cut.xml",
				'<testsuites><testsuite name="x"><testcase classname="tests/a.test.mjs" name="grp &gt; passes"></testcase>',
			);
			const slice = commitAll(repo, "slice");
			const junit = gitPath(repo, `rpiv/reprove-red/${slice}.junit.xml`);
			const named = [
				"tests/a.test.mjs::fails a check",
				"tests/a.test.mjs::grp > passes",
				"tests/a.test.mjs::passes",
				"tests/a.test.mjs::asses",
				"tests/a.test.mjs::same",
				"tests/a.test.mjs::skipped one",
				"tests/a.test.mjs::errs",
				"tests/load.test.mjs::never runs",
				"tests/b.test.mjs::passes",
			];

			const run = reportRun(repo, slice, named, "tests/fixtures/report.xml");

			expect(run.status).toBe(0);
			const from = run.lines.indexOf(`report: ${junit}`);
			expect(from).toBeGreaterThan(-1);
			expect(run.lines.slice(from + 1)).toEqual([
				"test-result: failed tests/a.test.mjs::fails a check",
				"reason: tests/a.test.mjs::fails a check: expected 1 to be 2 // Object.is equality",
				"test-result: passed tests/a.test.mjs::grp > passes",
				"test-result: passed tests/a.test.mjs::passes",
				"test-result: not-found tests/a.test.mjs::asses",
				"test-result: mixed tests/a.test.mjs::same",
				"test-result: skipped tests/a.test.mjs::skipped one",
				"test-result: failed tests/a.test.mjs::errs",
				"reason: tests/a.test.mjs::errs: boom",
				"test-result: failed-to-load tests/load.test.mjs::never runs",
				"reason: tests/load.test.mjs::never runs: Cannot find module '../src/missing.mjs' imported from x",
				"test-result: not-found tests/b.test.mjs::passes",
				"result: red",
			]);

			put(dirname(junit), `${slice}.junit.xml`, REPORT);
			const missing = runHelper(
				[
					"--commit",
					slice,
					"--test",
					"tests/a.test.mjs::grp > passes",
					"--",
					NODE,
					"-e",
					"process.exit(1)",
					"{junit}",
				],
				repo,
			);
			expect(missing.lines).toContain("report: missing");
			expect(missing.lines).toContain(
				"test-result: unavailable tests/a.test.mjs::grp > passes",
			);
			expect(hasLineStarting(missing.lines, "test-result: passed")).toBe(false);
			expect(missing.status).toBe(0);
			expect(lastLine(missing.lines)).toBe("result: red");

			const broken = reportRun(
				repo,
				slice,
				["tests/a.test.mjs::grp > passes", "tests/load.test.mjs::never runs"],
				"tests/fixtures/bad.txt",
			);
			const reportLine = broken.lines.find((line) =>
				line.startsWith("report: "),
			);
			expect(reportLine?.startsWith("report: broken: ")).toBe(true);
			expect(reportLine?.length).toBeGreaterThan("report: broken: ".length);
			expect(broken.lines).toContain(
				"test-result: unavailable tests/a.test.mjs::grp > passes",
			);
			expect(broken.lines).toContain(
				"test-result: unavailable tests/load.test.mjs::never runs",
			);
			expect(broken.status).toBe(0);
			expect(lastLine(broken.lines)).toBe("result: red");

			// S14 revision 1: a report cut off before its closing tag is broken.
			const cut = reportRun(
				repo,
				slice,
				["tests/a.test.mjs::grp > passes"],
				"tests/fixtures/cut.xml",
			);
			expect(cut.lines).toContain("report: broken: unterminated report");
			expect(cut.lines).toContain(
				"test-result: unavailable tests/a.test.mjs::grp > passes",
			);
			expect(cut.status).toBe(0);
			expect(lastLine(cut.lines)).toBe("result: red");

			// Hardening after mutation (no new behavior): see REPORT_EDGES.
			put(repo, "tests/fixtures/report2.xml", REPORT_EDGES);
			put(repo, "tests/c.test.mjs", "export {};\n");
			const second = commitAll(repo, "second report");
			const decoded = reportRun(
				repo,
				second,
				[`tests\\c.test.mjs::q "q" <t> & 'n' A`, "tests/c.test.mjs::x"],
				"tests/fixtures/report2.xml",
			);
			expect(decoded.status).toBe(0);
			const reportAt = decoded.lines.findIndex((line) =>
				line.startsWith("report: "),
			);
			expect(decoded.lines[reportAt].startsWith("report: broken")).toBe(false);
			expect(decoded.lines.slice(reportAt + 1)).toEqual([
				`test-result: failed tests\\c.test.mjs::q "q" <t> & 'n' A`,
				`reason: tests\\c.test.mjs::q "q" <t> & 'n' A: first & line`,
				"test-result: not-found tests/c.test.mjs::x",
				"result: red",
			]);
		},
		TEST_TIMEOUT,
	);
});

/** A file with every whitespace run replaced by one space. */
const joined = (path) =>
	readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");

describe("validate re-proves red (S14)", () => {
	it("validate re-proves each slice's red report-only and the contract marks pins", () => {
		const validate = joined("skills/validate/SKILL.md");
		for (const phrase of [
			/Re-prove red for each slice commit in the audit scope, in every lane/i,
			/reprove-red\.mjs" --commit <slice-commit>/,
			/executable with arguments, not a shell string/i,
			/--test <path>::<name>/,
			// S19 (D39) replaces the report-only sentence; B178 asserts its absence.
			/validate does not judge whether a failure reason matches the Expected red/i,
			/beside the behavior's Expected red/i,
			/never as red and never as a pass/i,
			/`Expected red: none — pin`/,
			/Deep-review fix commits are not re-proved/i,
			// S14 revision 1
			/from the test runner's root/i,
			/only authored document is a fresh validation report/i,
			/re-prove helper's log and JUnit report under the git dir are scratch output, not documents/i,
		]) {
			expect(validate).toMatch(phrase);
		}
		expect(validate).not.toMatch(/red not behavioral/i);
		expect(validate).not.toMatch(/only authored output is/i);
		// S14 revision 2: a slice without a commit is reported, never skipped.
		expect(validate).toMatch(/`not re-proved: no slice commit`/);
		expect(validate).toMatch(/never skipping it/i);

		const placeholder = readFileSync(
			join(ROOT, "skills/validate/templates/validation.md"),
			"utf-8",
		)
			.split(/\r?\n/)
			.find((line) => line.includes("expected-red reason"));
		expect(placeholder).toMatch(/re-proved red/i);

		const authoring = joined("skills/_shared/test-contract-authoring.md");
		expect(authoring).toMatch(/`Expected red: none — pin`/);
		expect(authoring).toMatch(/validate does not re-prove it/i);
	});
});

// S19 (D39): a runner that also writes a JUnit report (first argument), one case
// named "sums" per test file, its failure message the thrown error's.
const JUNIT_RUNNER = `import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [junit, ...paths] = process.argv.slice(2);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const cases = [];
let failed = false;
for (const p of paths) {
	try {
		await import(pathToFileURL(resolve(p)).href);
		cases.push(\`<testcase classname="\${esc(p)}" name="sums"></testcase>\`);
	} catch (error) {
		failed = true;
		cases.push(\`<testcase classname="\${esc(p)}" name="sums"><failure message="\${esc(error.message)}"/></testcase>\`);
	}
}
writeFileSync(junit, \`<testsuites><testsuite name="t">\${cases.join("")}</testsuite></testsuites>\`);
process.exit(failed ? 1 : 0);
`;

describe("re-proving red at another revision and parameterised titles (S19)", () => {
	it(
		"--base re-proves the slice's tests on the named revision",
		() => {
			const repo = newRepo();
			put(repo, "jrun.mjs", JUNIT_RUNNER);
			put(repo, "src/sum.mjs", BROKEN_SUM);
			put(repo, "tests/shared.test.mjs", "export {};\n");
			const base = commitAll(repo, "base");
			git(repo, "checkout", "-q", "-b", "side");
			put(repo, "src/sum.mjs", "export const sum = () => 7;\n");
			// S19 revision 1 (B189): the base's own test change is never applied. The
			// slice leaves tests/shared.test.mjs alone, so a base → commit diff would
			// list it; the parent → commit diff does not.
			put(repo, "tests/shared.test.mjs", "export const side = 1;\n");
			const seven = commitAll(repo, "an amended-away candidate");
			put(repo, "src/sum.mjs", GOOD_SUM);
			const good = commitAll(repo, "a candidate that already works");
			git(repo, "checkout", "-q", "main");
			put(repo, "src/sum.mjs", GOOD_SUM);
			put(repo, "tests/sum.test.mjs", SUM_TEST);
			const slice = commitAll(repo, "slice");
			const id = "tests/sum.test.mjs::sums";
			const call = (rev) =>
				runHelper(
					[
						"--commit",
						slice,
						...(rev ? ["--base", rev] : []),
						"--test",
						id,
						"--",
						NODE,
						"jrun.mjs",
						"{junit}",
						"{tests}",
					],
					repo,
				);
			const logOf = (run) => run.lines.find((line) => line.startsWith("log: "));

			const atSeven = call(seven);
			expect(atSeven.stderr).toBe("");
			expect(atSeven.status).toBe(0);
			expect(atSeven.lines.slice(0, 3)).toEqual([
				`reprove-red: ${slice}`,
				`base: ${seven}`,
				"test: tests/sum.test.mjs",
			]);
			expect(atSeven.lines.filter((line) => line.startsWith("test: "))).toEqual(["test: tests/sum.test.mjs"]);
			expect(atSeven.lines).toContain(`test-result: failed ${id}`);
			expect(atSeven.lines).toContain(`reason: ${id}: got 7`);
			expect(logOf(atSeven)).toBe(`log: ${scratchOf(repo, `${slice}-${seven}`)}.log`);
			expect(lastLine(atSeven.lines)).toBe("result: red");

			const atParent = call();
			expect(atParent.lines[1]).toBe(`base: ${base}`);
			expect(atParent.lines).toContain(`reason: ${id}: got 0`);
			expect(logOf(atParent)).toBe(`log: ${scratchOf(repo, slice)}.log`);
			expect(lastLine(atParent.lines)).toBe("result: red");

			const atGood = call(good);
			expect(atGood.lines).toContain(`test-result: passed ${id}`);
			expect(lastLine(atGood.lines)).toBe("result: green");

			const nope = call("nope");
			expect(nope.status).toBe(2);
			expect(nope.stdout).toBe("");
			expect(nope.stderr.split(/\r?\n/)[0]).toBe("reprove-red: broken: unknown revision: nope");
		},
		TEST_TIMEOUT,
	);

	const PARAM_REPORT = `<?xml version="1.0"?>
<testsuites><testsuite name="t">
<testcase classname="tests/t.test.mjs" name="adds (x)"><failure message="x broke"/></testcase>
<testcase classname="tests/t.test.mjs" name="adds (y)"><failure message="y broke"/></testcase>
<testcase classname="tests/t.test.mjs" name="adds ()"></testcase>
<testcase classname="tests/t.test.mjs" name="half (x)"><failure message="h broke"/></testcase>
<testcase classname="tests/t.test.mjs" name="half (y)"></testcase>
<testcase classname="tests/t.test.mjs" name="suite &gt; checks 3 items"><failure message="three"/></testcase>
<testcase classname="tests/t.test.mjs" name="tail (x) more"><failure message="more"/></testcase>
<testcase classname="tests/t.test.mjs" name="100% sure"><failure message="percent"/></testcase>
<testcase classname="tests/t.test.mjs" name="100x sure"></testcase>
<testcase classname="tests/t.test.mjs" name="axb"><failure message="axb"/></testcase>
</testsuite></testsuites>
`;
	const COPIER = `import { copyFileSync } from "node:fs";
const [src, dst] = process.argv.slice(2);
copyFileSync(src, dst);
process.exit(1);
`;

	it(
		"placeholder titles match their parameterised cases",
		() => {
			const repo = newRepo();
			put(repo, "copy.mjs", COPIER);
			commitAll(repo, "base");
			put(repo, "tests/t.test.mjs", "export {};\n");
			put(repo, "tests/fixtures/param.xml", PARAM_REPORT);
			const slice = commitAll(repo, "slice");
			const names = [
				"adds (%s)",
				"half (%s)",
				"checks %d items",
				"adds ($name)",
				"adds (%s) more",
				"tail (%s)",
				"100%% sure",
				"a.b",
			].map((name) => `tests/t.test.mjs::${name}`);
			const run = runHelper(
				[
					"--commit",
					slice,
					...names.flatMap((name) => ["--test", name]),
					"--",
					NODE,
					"copy.mjs",
					"tests/fixtures/param.xml",
					"{junit}",
				],
				repo,
			);
			expect(run.status).toBe(0);
			const from = run.lines.findIndex((line) => line.startsWith("report: "));
			expect(run.lines.slice(from + 1)).toEqual([
				"test-result: failed tests/t.test.mjs::adds (%s)",
				"reason: tests/t.test.mjs::adds (%s): x broke",
				"test-result: mixed tests/t.test.mjs::half (%s)",
				"test-result: failed tests/t.test.mjs::checks %d items",
				"reason: tests/t.test.mjs::checks %d items: three",
				"test-result: failed tests/t.test.mjs::adds ($name)",
				"reason: tests/t.test.mjs::adds ($name): x broke",
				"test-result: not-found tests/t.test.mjs::adds (%s) more",
				"test-result: not-found tests/t.test.mjs::tail (%s)",
				"test-result: failed tests/t.test.mjs::100%% sure",
				"reason: tests/t.test.mjs::100%% sure: percent",
				"test-result: not-found tests/t.test.mjs::a.b",
				"result: red",
			]);
		},
		TEST_TIMEOUT,
	);
});

describe("placeholder edges (S19 revision 1)", () => {
	const EDGE_REPORT = `<?xml version="1.0"?>
<testsuites>
<testsuite name="tests/l.test.mjs"><testcase classname="tests/l.test.mjs" name="tests/l.test.mjs"><failure message="cannot load"/></testcase></testsuite>
<testsuite name="t">
<testcase classname="tests/t.test.mjs" name="x &gt; b y &gt; z"><failure message="spans"/></testcase>
<testcase classname="tests/t.test.mjs" name="suite &gt; b w"></testcase>
</testsuite>
</testsuites>
`;
	const COPY = `import { copyFileSync } from "node:fs";
const [src, dst] = process.argv.slice(2);
copyFileSync(src, dst);
process.exit(1);
`;

	it(
		"placeholder titles never span a nesting or match a load record",
		() => {
			const repo = newRepo();
			put(repo, "copy.mjs", COPY);
			commitAll(repo, "base");
			put(repo, "tests/l.test.mjs", "export {};\n");
			put(repo, "tests/t.test.mjs", "export {};\n");
			put(repo, "tests/fixtures/edge.xml", EDGE_REPORT);
			const slice = commitAll(repo, "slice");
			const run = runHelper(
				[
					"--commit",
					slice,
					"--test",
					"tests/l.test.mjs::%s",
					"--test",
					"tests/t.test.mjs::b %s",
					"--",
					NODE,
					"copy.mjs",
					"tests/fixtures/edge.xml",
					"{junit}",
				],
				repo,
			);
			expect(run.status).toBe(0);
			const from = run.lines.findIndex((line) => line.startsWith("report: "));
			expect(run.lines.slice(from + 1)).toEqual([
				"test-result: failed-to-load tests/l.test.mjs::%s",
				"reason: tests/l.test.mjs::%s: cannot load",
				"test-result: passed tests/t.test.mjs::b %s",
				"result: red",
			]);
		},
		TEST_TIMEOUT,
	);
});

describe("validate asks about re-prove outcomes (S19)", () => {
	it("validate asks about non-failed re-prove outcomes and re-proves revision reds", () => {
		const sources = ["skills/validate/SKILL.md", "opencode/generated/skills/rpiv-validate/SKILL.md"];
		for (const path of sources) {
			const validate = joined(path);
			for (const phrase of [
				/never fails validation on its own/i,
				/becomes one developer question per slice/i,
				/accept it with a recorded reason, or send the slice back to implement/i,
				/never as a pass/i,
				/--base <revision>/,
				/Expected red names a revision other than the slice's parent/i,
				/not re-provable: red at <rev>, revision missing/,
				/title as written in the test file, placeholders included/i,
				/validate does not judge whether a failure reason matches the Expected red/i,
				// S19 revision 1 (B191)
				/leave those tests out of the call on the slice's parent/i,
				/`not re-proved: no slice commit`[^.]*joins the developer question/i,
			]) {
				expect.soft(validate, path).toMatch(phrase);
			}
			expect.soft(validate, path).not.toMatch(/Re-proved red is report-only: it never fails or blocks validation/i);
		}
		for (const path of ["skills/_shared/test-contract-authoring.md", "opencode/generated/skills/_shared/test-contract-authoring.md"]) {
			const authoring = joined(path);
			expect.soft(authoring, path).toMatch(/it\.each[^.]*title as written, placeholders included/i);
			expect.soft(authoring, path).toMatch(/a revision's Expected red names the revision it was observed at/i);
		}
	});
});

describe("validation template (S19 revision 1)", () => {
	it("the validation template records the re-prove question", () => {
		for (const path of [
			"skills/validate/templates/validation.md",
			"opencode/generated/skills/rpiv-validate/templates/validation.md",
		]) {
			const line = readFileSync(join(ROOT, path), "utf-8")
				.split(/\r?\n/)
				.find((l) => l.includes("expected-red reason"));
			expect.soft(line, path).toMatch(/re-proved red/i);
			expect.soft(line, path).not.toMatch(/report-only/i);
			expect.soft(line, path).toMatch(/developer's answer and reason/i);
			expect.soft(line, path).toMatch(/--base revision/i);
		}
	});
});
