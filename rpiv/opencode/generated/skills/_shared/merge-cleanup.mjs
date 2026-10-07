// merge-cleanup.mjs — the read-only post-merge cleanup planner (S26-merge-cleanup,
// D36). The pr skill runs it after the developer says the PR merged; it asks gh
// whether the branch's pull request merged and, when it did, lists the cleanup
// commands in order. It never deletes anything: the skill shows the plan, asks the
// developer once, and only then runs the commands (the approval hook asks again).
//
// CLI: `node merge-cleanup.mjs --branch <name>` prints `merge-cleanup: <name>`,
// `merged: yes (<mergedAt>)` and then, in order, `command: git worktree remove
// <path>` (or `blocked: …` when that worktree is the current directory),
// `command: git branch -D <name>` (or `blocked: …` when the local tip is not in
// the pull request's head, or that head is not in the repository),
// `command: git push <remote> --delete <name>` and `archive: <n> cycle line(s)` —
// each only when its target exists; words are quoted when a shell would split
// them. Not merged prints `merged: no (<why>)`. A bad call
// or an undecidable answer prints `merge-cleanup: broken: <detail>` on stderr,
// nothing on stdout, exit 2 — never "not merged" (degrade-distinguishes-broken).
// RPIV_GH_SCRIPT (tests only) runs `node <script>` in place of `gh`.
//
// Importable: runCli.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { cycleLogPath, readCommonDir, readLog, splitBranchLines } from "./cycles.mjs";
import { isMain } from "./is-main.mjs";

const firstLine = (text) => (text ?? "").split(/\r?\n/)[0] || "(no message)";

// A call that has not answered by then is broken (it may be waiting on the network).
const CALL_TIMEOUT_MS = 30_000;

/** `{ status, out, err }` of `command args` in `cwd`; throws when it could not run
    or timed out. Credential prompts are off: a prompt would hang the run. */
function run(command, args, cwd, name = command) {
	const res = spawnSync(command, args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
		windowsHide: true,
		timeout: CALL_TIMEOUT_MS,
	});
	if (res.error) throw new Error(`${name} could not run (${res.error.message})`);
	return {
		status: res.status,
		out: (res.stdout ?? "").replaceAll("\r\n", "\n").trim(),
		err: (res.stderr ?? "").trim(),
	};
}

const git = (cwd, args) => run("git", args, cwd);

/** gh, or `node $RPIV_GH_SCRIPT` when the tests set it. */
function gh(cwd, args) {
	const script = process.env.RPIV_GH_SCRIPT;
	return script
		? run(process.execPath, [script, ...args], cwd, "gh")
		: run("gh", args, cwd);
}

/** git's stdout, or a thrown broken detail naming the failed call. */
function gitOut(cwd, args) {
	const res = git(cwd, args);
	if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${firstLine(res.err)}`);
	return res.out;
}

const isBranchCall = ([option, name, ...extra]) =>
	option === "--branch" && Boolean(name) && !name.startsWith("--") && extra.length === 0;

function parseArgs(argv) {
	if (!isBranchCall(argv)) throw new Error("--branch <name> is required (and nothing else)");
	return { branch: argv[1] };
}

// gh's message when the branch has no pull request at all: "not merged", not broken.
const NO_PR = "no pull requests found";
const NOT_MERGED = new Set(["OPEN", "CLOSED"]);

/** `{ merged: true, at, head }` or `{ merged: false, why }` from gh's answer for
    the branch's pull request; anything gh cannot decide throws a broken detail. */
function mergeState(cwd, branch) {
	const res = gh(cwd, ["pr", "view", branch, "--json", "state,mergedAt,headRefOid"]);
	if (res.status === 0) return stateOf(parseAnswer(res.out));
	if (res.err.includes(NO_PR)) return { merged: false, why: "no pull request" };
	throw new Error(`gh pr view failed: ${firstLine(res.err)}`);
}

/** gh's JSON answer, or a thrown broken detail. */
function parseAnswer(out) {
	try {
		return JSON.parse(out);
	} catch (err) {
		throw new Error(`gh pr view returned invalid JSON (${err.message})`);
	}
}

// A commit hash as gh prints it (SHA-1 or SHA-256).
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The merge state a pull request's `{ state, mergedAt, headRefOid }` names; a
    merged answer without a commit hash for its head is broken. */
function stateOf(answer) {
	const state = answer?.state;
	if (state === "MERGED") {
		if (!OBJECT_ID.test(answer.headRefOid ?? ""))
			throw new Error(`gh pr view gave no head commit (${answer.headRefOid})`);
		return { merged: true, at: answer.mergedAt, head: answer.headRefOid };
	}
	if (NOT_MERGED.has(state)) return { merged: false, why: state };
	throw new Error(`unknown pull request state ${state}`);
}

// Characters a shell would split or expand; a word holding one is double-quoted.
const SHELL_SPECIAL = /[\s"'`$&|;<>()*?[\]{}!#~\\]/;
/** `word` as one shell word: bare when plain, else double-quoted. */
const shellWord = (word) =>
	SHELL_SPECIAL.test(word) ? `"${word.replace(/(["\\$`])/g, "\\$1")}"` : word;

const normal = (path) => resolve(path).replaceAll("\\", "/").toLowerCase();

/** The path of the worktree that has `branch` checked out, or null. */
function worktreeOf(cwd, branch) {
	const blocks = gitOut(cwd, ["worktree", "list", "--porcelain"]).split("\n\n");
	for (const block of blocks) {
		const lines = block.split("\n");
		if (lines.includes(`branch refs/heads/${branch}`))
			return lines.find((l) => l.startsWith("worktree ")).slice("worktree ".length);
	}
	return null;
}

/** true for git's exit 0, false for its quiet "no" (exit 1); any other answer
    is a thrown broken detail, never "no" (degrade-distinguishes-broken). */
function gitYesNo(cwd, args) {
	const res = git(cwd, args);
	if (res.status === 0 || res.status === 1) return res.status === 0;
	throw new Error(`git ${args[0]} failed: ${firstLine(res.err)}`);
}

/** The remote a branch's delete goes to: its configured `branch.<name>.remote`,
    used as written (a URL included); else `origin` when that remote exists; else
    null (nothing to delete remotely). */
function remoteOf(cwd, branch) {
	const configured = git(cwd, ["config", "--get", `branch.${branch}.remote`]);
	if (configured.status === 0) return configured.out;
	if (configured.status !== 1)
		throw new Error(`git config failed: ${firstLine(configured.err) || `exit ${configured.status}`}`);
	return gitOut(cwd, ["remote"]).split("\n").includes("origin") ? "origin" : null;
}

/** The branch's tip on `remote`, or null when the remote has no such branch; a
    failed lookup is broken. */
function remoteTip(cwd, remote, branch) {
	const args = ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`];
	const res = git(cwd, args);
	if (res.status === 2) return null;
	if (res.status === 0) return res.out.split(/\s/)[0];
	throw new Error(`git ls-remote failed: ${firstLine(res.err)}`);
}

/** The remote delete, listed only when no remote commit would be lost: the
    remote tip must be the pull request's head or an ancestor of it (S26
    revision 2, the same rule as the local delete). */
function remoteDeleteLine(cwd, { remote, branch, tip }, head) {
	if (!gitYesNo(cwd, ["rev-parse", "--verify", "--quiet", `${tip}^{commit}`]))
		return `blocked: the remote tip ${tip} of ${branch} is not in this repository; fetch it first`;
	if (!gitYesNo(cwd, ["merge-base", "--is-ancestor", tip, head]))
		return `blocked: ${remote}/${branch} has commits that are not in its pull request`;
	return `command: git push ${shellWord(remote)} --delete ${shellWord(branch)}`;
}

/** The repository's absolute git common dir; outside a repository, or when git
    refuses the directory, a thrown broken detail (checked before gh is asked). */
function commonDirOf(cwd) {
	const repo = readCommonDir(
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		cwd,
	);
	if (repo.outside) throw new Error(`not a git repository: ${cwd}`);
	if (repo.problem) throw new Error(repo.problem);
	return repo.common;
}

/** The branch delete, listed only when no local commit would be lost: the local
    tip must be the pull request's head (present locally) or an ancestor of it
    (S26 revision 1). */
function branchDeleteLine(cwd, branch, head) {
	if (!gitYesNo(cwd, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, head]))
		return `blocked: ${branch} has commits that are not in its pull request`;
	return `command: git branch -D ${shellWord(branch)}`;
}

/** The local and remote branch deletes, each guarded against losing commits
    that are not in the pull request; when the head itself is not in this
    repository neither can be checked, so one `blocked:` line stands for both. */
function deleteLines(cwd, branch, head) {
	if (!gitYesNo(cwd, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]))
		return [`blocked: the pull request head ${head} is not in this repository; fetch it first`];
	const lines = [];
	if (gitYesNo(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))
		lines.push(branchDeleteLine(cwd, branch, head));
	const remote = remoteOf(cwd, branch);
	const tip = remote === null ? null : remoteTip(cwd, remote, branch);
	if (tip !== null) lines.push(remoteDeleteLine(cwd, { remote, branch, tip }, head));
	return lines;
}

/** The cleanup lines for a merged `branch` whose pull request head is `head`. */
function planLines(cwd, branch, head, common) {
	const lines = [];
	const worktree = worktreeOf(cwd, branch);
	if (worktree !== null) {
		const here = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
		lines.push(
			normal(here) === normal(worktree)
				? "blocked: the branch's worktree is the current directory"
				: `command: git worktree remove ${shellWord(worktree)}`,
		);
	}
	lines.push(...deleteLines(cwd, branch, head));
	const { own } = splitBranchLines(readLog(cycleLogPath(common)), branch);
	lines.push(`archive: ${own.length} cycle line(s)`);
	return lines;
}

/** The planner's stdout for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const { branch } = parseArgs(argv);
	const common = commonDirOf(cwd);
	const state = mergeState(cwd, branch);
	const lines = [`merge-cleanup: ${branch}`];
	if (state.merged)
		lines.push(`merged: yes (${state.at})`, ...planLines(cwd, branch, state.head, common));
	else lines.push(`merged: no (${state.why})`);
	return `${lines.join("\n")}\n`;
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(`merge-cleanup: broken: ${err?.message ?? err}\n`);
		process.exitCode = 2;
	}
}
