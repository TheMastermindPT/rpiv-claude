// _git-branch.mjs — git queries shared by the approved-branch hooks (S2, D14):
// where HEAD points and whether a branch carries `branch.<name>.rpivApproved`.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Each query, and all of one hook decision together, stay well inside the hooks'
// 10-second timeout (D13): past the budget a query fails instead of running.
const GIT_TIMEOUT_MS = 2_000;
const HEADS = "refs/heads/";
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

const gitFailed = (error) => `git could not run (${error})`;

/** Why `dir` cannot be read as a git repository, or null when it can. A git
    that could not run is told apart from a directory that is not a repository
    (degrade-distinguishes-broken). */
export function repositoryProblem(dir) {
	if (!existsSync(dir)) return `${dir} does not exist`;
	const res = runGit(dir, ["rev-parse", "--git-dir"]);
	if (res.error) return gitFailed(res.error);
	return res.status === 0 ? null : `${dir} is not a readable git repository`;
}

/** HEAD of the repository at `dir`: `{ branch, born }` (`branch` null when
    detached), or `{ problem }` when it cannot be read. */
export function headState(dir) {
	const problem = repositoryProblem(dir);
	if (problem) return { problem };
	// The full ref, not `--short`: a same-named tag would make it `heads/<name>`.
	const ref = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
	if (ref.error) return { problem: gitFailed(ref.error) };
	if (ref.status !== 0 || !ref.out.startsWith(HEADS))
		return { branch: null, born: true };
	const head = runGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	if (head.error) return { problem: gitFailed(head.error) };
	return { branch: ref.out.slice(HEADS.length), born: head.status === 0 };
}

/** `{ approved }` — the marker is a git boolean that reads true — or
    `{ problem }` when git could not answer. */
export function approval(dir, branch) {
	const res = runGit(dir, [
		"config",
		"--type=bool",
		"--get",
		`branch.${branch}.rpivApproved`,
	]);
	if (res.error) return { problem: gitFailed(res.error) };
	return { approved: res.status === 0 && res.out === "true" };
}

/** `{ exists }` for `refs/heads/<name>`, or `{ problem }`. */
export function branchExists(dir, name) {
	const res = runGit(dir, [
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${name}`,
	]);
	if (res.error) return { problem: gitFailed(res.error) };
	return { exists: res.status === 0 };
}

/** Sets the approval marker: null, or a problem. */
export function markApproved(dir, name) {
	const res = runGit(dir, ["config", `branch.${name}.rpivApproved`, "true"]);
	if (res.error) return gitFailed(res.error);
	return res.status === 0 ? null : "git config failed";
}

/** The branch names under refs/heads, or `{ problem }`. */
export function branchNames(dir) {
	const res = runGit(dir, [
		"for-each-ref",
		"--format=%(refname:lstrip=2)",
		"refs/heads",
	]);
	if (res.error) return { problem: gitFailed(res.error) };
	if (res.status !== 0)
		return { problem: `${dir} is not a readable git repository` };
	return { names: res.out === "" ? [] : res.out.split(/\r?\n/) };
}

/** Milliseconds left in the git time budget. */
export const gitTimeLeft = () => deadline - Date.now();
