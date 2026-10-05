// _git-branch.mjs — git queries shared by the approved-branch hooks (S2, D14):
// where HEAD points and whether a branch carries `branch.<name>.rpivApproved`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Each query, and all of one hook decision together, stay well inside the hooks'
// 10-second timeout (D13): past the budget a query fails instead of running.
const GIT_TIMEOUT_MS = 2_000;
let deadline = Number.POSITIVE_INFINITY;

/** Gives every later git query of this process `ms` milliseconds in total. */
export function limitGitTime(ms) {
	deadline = Date.now() + ms;
}

/** Runs git in `dir`: `{ status, out }`, or `{ error }` when git could not run. */
export function runGit(dir, args) {
	const left = deadline - Date.now();
	if (left <= 0) return { error: "git queries took too long" };
	const res = spawnSync("git", ["-C", dir, ...args], {
		encoding: "utf-8",
		timeout: Math.min(GIT_TIMEOUT_MS, left),
		windowsHide: true,
	});
	if (res.error) return { error: res.error.message };
	return { status: res.status, out: (res.stdout ?? "").trim() };
}

/** Is `dir` inside a git repository git can read? */
export function isRepository(dir) {
	if (!existsSync(dir)) return false;
	const res = runGit(dir, ["rev-parse", "--git-dir"]);
	return !res.error && res.status === 0;
}

/** HEAD of the repository at `dir`: `{ branch, born }` (`branch` null when
    detached), or `{ problem }` when it cannot be read. */
export function headState(dir) {
	if (!isRepository(dir))
		return { problem: `${dir} is not a readable git repository` };
	const ref = runGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (ref.error) return { problem: ref.error };
	if (ref.status !== 0) return { branch: null, born: true };
	const head = runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	return { branch: ref.out, born: head.status === 0 };
}

/** Does `branch` carry the approval marker (a git boolean that reads true)? */
export function isApproved(dir, branch) {
	const res = runGit(dir, [
		"config",
		"--type=bool",
		"--get",
		`branch.${branch}.rpivApproved`,
	]);
	return res.status === 0 && res.out === "true";
}

/** Milliseconds left in the git time budget. */
export const gitTimeLeft = () => deadline - Date.now();
