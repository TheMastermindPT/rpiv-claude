// tests/reprove-red-scratch-location.test.mjs — where reprove-red builds its scratch copy
// (rpiv issue drafts 20261123-151137-84f5c6f8, MAX_PATH, and 20261123-151137-3491b4f7,
// the scratch copy inside the git dir). The scratch copy is a short folder in the system's
// temporary folder, outside the repository, and a git work tree checked out at the base,
// so a test that runs git there sees a repository; a caller's GIT_DIR never reaches the
// real repository or the runner.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	git,
	gitPath,
	lastLine,
	NODE,
	newRepo,
	put,
	runHelper,
	TEST_TIMEOUT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

// The tiny runner: imports each path argument, exits 1 when one throws.
const RUNNER = `import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
let failed = false;
for (const p of process.argv.slice(2)) {
	try {
		await import(pathToFileURL(resolve(p)).href);
	} catch (error) {
		failed = true;
		console.log(\`FAIL \${p}: \${error.message}\`);
	}
}
process.exit(failed ? 1 : 0);
`;

/** A test file that saves what git says in its run folder to `out`, then fails. */
const gitProbe = (out) => `import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const run = (...args) => {
	try {
		const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return { code: 0, out: out.trim() };
	} catch (error) {
		return { code: error.status, out: "" };
	}
};
writeFileSync(${JSON.stringify(out)}, JSON.stringify({
	cwd: process.cwd(),
	head: run("rev-parse", "HEAD").out,
	ignored: run("check-ignore", "--no-index", "-q", "x.log").code,
	visible: run("check-ignore", "--no-index", "-q", "run.mjs").code,
	status: run("status", "--porcelain", "--untracked-files=all").out,
}));
throw new Error("red on purpose");
`;

/** What "the checkout is untouched" compares. */
const snapshot = (repo) => ({
	status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
	head: git(repo, "rev-parse", "HEAD"),
	branch: git(repo, "branch", "--show-current"),
});

/** True when `path` is `folder` or lies inside it. */
const inside = (folder, path) => {
	const rel = relative(folder, path);
	return !rel.startsWith("..") && !isAbsolute(rel);
};

describe("reprove-red scratch copy location", () => {
	it(
		"runs in a git work tree checked out at the base, outside the repository, even with the caller's GIT_DIR set",
		() => {
			const repo = newRepo();
			put(repo, "run.mjs", RUNNER);
			put(repo, ".gitignore", "*.log\n");
			const base = commitAll(repo, "base");
			const out = join(tempDir(), "seen.json");
			put(repo, "tests/git.test.mjs", gitProbe(out));
			const slice = commitAll(repo, "slice");
			const before = snapshot(repo);
			const gitDir = gitPath(repo, ".");

			const run = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				repo,
				{ GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, "index") },
			);

			expect.soft(run.stderr).toBe("");
			expect.soft(lastLine(run.lines)).toBe("result: red");
			const seen = JSON.parse(readFileSync(out, "utf-8"));
			expect.soft(seen.head).toBe(base);
			expect.soft(seen.ignored).toBe(0);
			expect.soft(seen.visible).toBe(1);
			expect.soft(seen.status).toBe("?? tests/git.test.mjs");
			expect.soft(inside(realpathSync(repo), seen.cwd)).toBe(false);
			expect.soft(inside(realpathSync(gitDir), seen.cwd)).toBe(false);
			expect.soft(existsSync(seen.cwd)).toBe(false);
			expect.soft(snapshot(repo)).toEqual(before);
		},
		TEST_TIMEOUT,
	);

	it.runIf(process.platform === "win32")(
		"checks out a base whose paths pass Windows' 260-character limit",
		() => {
			const repo = newRepo();
			git(repo, "config", "core.longpaths", "true");
			put(repo, "run.mjs", RUNNER);
			const deep = `${Array.from({ length: 6 }, (_, i) => `${i}${"d".repeat(40)}`).join("/")}/f.txt`;
			put(repo, deep, "deep\n");
			const base = commitAll(repo, "base");
			put(repo, "tests/a.test.mjs", 'throw new Error("red");\n');
			const slice = commitAll(repo, "slice");
			expect(join(tmpdir(), "rpiv-rr-xxxxxx", deep).length).toBeGreaterThan(
				260,
			);

			const run = runHelper(
				["--commit", slice, "--", NODE, "run.mjs", "{tests}"],
				repo,
			);

			expect.soft(run.stderr).toBe("");
			expect
				.soft(run.lines.slice(0, 2))
				.toEqual([`reprove-red: ${slice}`, `base: ${base}`]);
			expect.soft(lastLine(run.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);
});
