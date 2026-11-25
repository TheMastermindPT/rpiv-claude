// tests/git-context-repo.test.mjs — `repo:` names the repository, the same in every
// linked worktree: the main checkout's folder (or a bare repository's, without `.git`),
// never the worktree's own folder (Odin issue #9).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills/_shared/git-context.mjs",
);
const TEST_TIMEOUT = 60_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd, ...args) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
const repoLine = (cwd) =>
	execFileSync(process.execPath, [HELPER], { cwd, encoding: "utf-8" })
		.split("\n")
		.find((line) => line.startsWith("repo: "));

/** A folder `myproject` holding a repository with one commit. */
const mainCheckout = () => {
	const top = mkdtempSync(join(tmpdir(), "rpiv-repo-name-"));
	dirs.push(top);
	const main = join(top, "myproject");
	execFileSync("git", ["init", "-q", "-b", "main", main]);
	git(main, "config", "user.email", "p@example.invalid");
	git(main, "config", "user.name", "p");
	writeFileSync(join(main, "a.txt"), "a\n");
	git(main, "add", "-A");
	git(main, "commit", "-q", "-m", "base");
	return { top, main };
};

describe("git-context repo:", () => {
	it(
		"names the main checkout's folder in the main checkout and in a linked worktree",
		() => {
			const { top, main } = mainCheckout();
			const wt = join(top, "myproject-feature-s1");
			git(main, "worktree", "add", "-q", wt, "-b", "feature");
			expect(repoLine(main)).toBe("repo: myproject");
			expect(repoLine(wt)).toBe("repo: myproject");
		},
		TEST_TIMEOUT,
	);

	it(
		"names a bare repository's folder without .git, from its worktree",
		() => {
			const { top, main } = mainCheckout();
			const bare = join(top, "shared.git");
			execFileSync("git", ["clone", "-q", "--bare", main, bare]);
			const wt = join(top, "shared-wt");
			git(bare, "worktree", "add", "-q", wt, "main");
			expect(repoLine(wt)).toBe("repo: shared");
		},
		TEST_TIMEOUT,
	);

	it(
		"says unknown outside any repository",
		() => {
			const outside = mkdtempSync(join(tmpdir(), "rpiv-no-repo-"));
			dirs.push(outside);
			expect(repoLine(outside)).toBe("repo: unknown");
		},
		TEST_TIMEOUT,
	);
});
