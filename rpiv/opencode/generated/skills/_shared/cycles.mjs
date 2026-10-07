// cycles.mjs — the cycle metrics log (S15-cycle-metrics, D24): where it lives and how
// one branch's cycle reads. The log is `<git-common-dir>/rpiv/cycles.jsonl`, shared by
// every worktree of a repository and never committed; the hook
// .claude/hooks/record-cycle-event.mjs appends to it.
//
// CLI: `node cycles.mjs [--branch <name>]` prints one branch's cycle (default: the
// current branch; `(detached)` reads the lines written on a detached HEAD). No log, or
// no line for the branch, prints `records: none`; a git failure, a directory outside
// a repository or a bad option prints `cycles: broken: <detail>` on stderr, exit 2.
// `node cycles.mjs --archive --branch <name>` moves that branch's lines to
// `cycles-archive.jsonl` beside the log and prints `archived: <n> line(s) of <name>
// to <archive>` (S26, D36).
//
// Importable: cycleLogPath, stageName, readCommonDir, readHeadBranch, summarise,
// splitBranchLines, readLog, runCli.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain } from "./is-main.mjs";

const DETACHED = "(detached)";
const HEADS = "refs/heads/";

const STAGE_PREFIX = "rpiv:";

/** The log of the repository whose absolute git common dir is `commonDir`. */
export const cycleLogPath = (commonDir) =>
	resolve(commonDir, "rpiv", "cycles.jsonl");

// The common start of git's two answers for a directory in no repository at all
// (git run with LC_ALL=C): "(or any of the parent directories)" and, where
// discovery stops at a filesystem boundary, "(or any parent up to mount point …)"
// (S15 revision 3). A `.git` pointer to a missing folder ("not a git repository:
// <path>") does not match and stays broken.
const OUTSIDE = "not a git repository (or any";

const firstLine = (text) => (text ?? "").split(/\r?\n/)[0] || "(no message)";

/** Reads a `git rev-parse --path-format=absolute --git-common-dir` result
    `{ status, out, err }` run in `dir`: `{ common }`, `{ outside: true }` when
    `dir` is in no repository, or `{ problem }` when git refused it. */
export function readCommonDir(res, dir) {
	if (res.status === 0) return { common: res.out };
	if ((res.err ?? "").includes(OUTSIDE)) return { outside: true };
	return { problem: `git refused ${dir}: ${firstLine(res.err)}` };
}

/** Reads a `git symbolic-ref --quiet HEAD` result: `{ branch }` (null when HEAD
    is detached or names no branch) or `{ problem }` when git could not read it. */
export function readHeadBranch(res) {
	if (res.status === 0)
		return {
			branch: res.out.startsWith(HEADS) ? res.out.slice(HEADS.length) : null,
		};
	if (res.status === 1) return { branch: null };
	return { problem: `git could not read HEAD: ${firstLine(res.err)}` };
}

/** The rpiv stage a command or skill name starts (`rpiv:implement` →
    `implement`), or null when it is not one. */
export function stageName(name) {
	if (typeof name !== "string" || !name.startsWith(STAGE_PREFIX)) return null;
	return name.slice(STAGE_PREFIX.length) || null;
}

/** Each log line parsed, or `null` for a line that is not a JSON object. */
function parseLines(text) {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				const rec = JSON.parse(line);
				return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null;
			} catch {
				return null;
			}
		});
}

/** The log's raw lines split by owner: `own` holds the lines that parse to a
    record of `branch`, `rest` every other line (another branch's, unreadable),
    each in log order. Blank lines are dropped. */
export function splitBranchLines(text, branch) {
	const own = [];
	const rest = [];
	for (const line of text.split(/\r?\n/).filter((l) => l.trim() !== "")) {
		const [rec] = parseLines(line);
		(rec !== null && rec.branch === branch ? own : rest).push(line);
	}
	return { own, rest };
}

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

/** Agents started, each `agent_id` once; a line without one counts once. */
function dispatchCount(dispatches) {
	const ids = new Set();
	let anonymous = 0;
	for (const rec of dispatches) {
		if (typeof rec.agent_id === "string") ids.add(rec.agent_id);
		else anonymous++;
	}
	return ids.size + anonymous;
}

/** The output lines for `branch` (null: detached) from the log text, or
    `records: none` when the branch has no line. */
export function summarise(text, branch, log) {
	const parsed = parseLines(text);
	const unreadable = parsed.filter((rec) => rec === null).length;
	const own = parsed.filter((rec) => rec !== null && rec.branch === branch);
	const lines = [`cycles: ${branch ?? DETACHED}`];
	if (own.length === 0) lines.push("records: none");
	else {
		const of = (event) => own.filter((rec) => rec.event === event);
		lines.push(
			`log: ${log}`,
			...of("stage").map((rec) => `stage: ${rec.time} ${rec.stage}`),
			`decisions: ${of("decision").reduce((sum, rec) => sum + count(rec.questions), 0)}`,
			`dispatches: ${dispatchCount(of("dispatch"))}`,
			`first: ${own[0].time}`,
			`last: ${own.at(-1).time}`,
		);
	}
	if (unreadable > 0)
		lines.push(
			`diagnostic: ${unreadable} unreadable line${unreadable === 1 ? "" : "s"}`,
		);
	return lines;
}

/** git's `{ status, out, err }` in `cwd` (English messages), or a thrown broken
    detail when git could not run. */
function gitOut(cwd, args) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, LC_ALL: "C" },
		windowsHide: true,
	});
	if (res.error) throw new Error(`git could not run (${res.error.message})`);
	return {
		status: res.status,
		out: (res.stdout ?? "").trim(),
		err: (res.stderr ?? "").trim(),
	};
}

/** The answer's value, or its problem thrown as a broken detail. */
function orThrow(answer) {
	if (answer.problem) throw new Error(answer.problem);
	return answer;
}

/** True when `value` cannot be an option's value (absent, empty, an option). */
const missingValue = (value) =>
	value === undefined || value === "" || value.startsWith("--");

/** `{ branch, archive }` from `--branch <name>` and `--archive`; throws on a bad
    option. `--archive` never defaults to the current branch. */
function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) i += readOption(argv, i, opts);
	if (opts.archive && opts.branch === undefined)
		throw new Error("--archive needs --branch");
	return opts;
}

/** Reads the option at `argv[i]` into `opts`; returns how many values it took. */
function readOption(argv, i, opts) {
	if (argv[i] === "--archive") {
		opts.archive = true;
		return 0;
	}
	if (argv[i] !== "--branch") throw new Error(`unknown option: ${argv[i]}`);
	const value = argv[i + 1];
	if (missingValue(value)) throw new Error("--branch needs a branch name");
	opts.branch = value;
	return 1;
}

/** Moves `branch`'s lines from the log to `cycles-archive.jsonl` beside it (S26,
    D36); other and unreadable lines stay in log order. The archive is appended
    before the log is rewritten, so a crash in between duplicates, never loses. */
function archiveBranch(log, branch) {
	const archive = resolve(dirname(log), "cycles-archive.jsonl");
	const { own, rest } = splitBranchLines(readLog(log), branch);
	if (own.length > 0) {
		appendFileSync(archive, `${own.join("\n")}\n`);
		const next = `${log}.${process.pid}.tmp`; // unique per process (S26 revision 1)
		writeFileSync(next, rest.length > 0 ? `${rest.join("\n")}\n` : "");
		renameSync(next, log);
	}
	return `archived: ${own.length} line(s) of ${branch} to ${archive}\n`;
}

/** The branch checked out at `cwd`, null when HEAD is detached. */
const currentBranch = (cwd) =>
	orThrow(readHeadBranch(gitOut(cwd, ["symbolic-ref", "--quiet", "HEAD"])))
		.branch;

/** The log's text; "" when it does not exist yet. A log folder that is not a
    folder is broken, never an empty log (degrade-distinguishes-broken). */
export function readLog(log) {
	const folder = dirname(log);
	if (existsSync(folder) && !statSync(folder).isDirectory())
		throw new Error(`log folder is not a folder: ${folder}`);
	return existsSync(log) ? readFileSync(log, "utf-8") : "";
}

/** The reader's stdout for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const opts = parseArgs(argv);
	const repo = orThrow(
		readCommonDir(
			gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			cwd,
		),
	);
	if (repo.outside) throw new Error(`not a git repository: ${cwd}`);
	const branch =
		opts.branch === undefined
			? currentBranch(cwd)
			: opts.branch === DETACHED
				? null
				: opts.branch;
	const log = cycleLogPath(repo.common);
	if (opts.archive) return archiveBranch(log, branch);
	return `${summarise(readLog(log), branch, log).join("\n")}\n`;
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(`cycles: broken: ${err?.message ?? err}\n`);
		process.exitCode = 2;
	}
}
