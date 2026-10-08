// rpiv-issue-pending.mjs — SessionStart hook that says when rpiv issue drafts are
// pending (S20-rpiv-issue-reports, D43). Agents draft issues about rpiv itself with
// skills/_shared/rpiv-issue.mjs into `<git-common-dir>/rpiv/issues/`; this hook
// prints `[rpiv] <N> rpiv issue draft(s) pending — /rpiv:issue` so they are filed
// or dropped rather than forgotten.
//
// An empty or missing queue and a directory in no repository say nothing. A queue
// the hook could not read is said (degrade-distinguishes-broken):
// `[rpiv-hook] issue drafts not checked: <why>`. Never blocks; always exits 0.

import { existsSync, readdirSync } from "node:fs";
import { readCommonDir } from "../../skills/_shared/cycles.mjs";
import { isMain } from "../../skills/_shared/is-main.mjs";
import { issuesDir } from "../../skills/_shared/rpiv-issue.mjs";
import { limitGitTime, runGit } from "./_git-branch.mjs";
import { sanitizeForContext } from "./_shared.mjs";
import { readEvent } from "./chain-handoff-retire.mjs";

/** The absolute git common dir of `dir`, or null outside a repository; any other
    failure throws its reason. */
function commonDirOf(dir) {
	if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
	const res = runGit(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (res.error) throw new Error(`git could not run (${res.error})`);
	const { common, outside, problem } = readCommonDir(res, dir);
	if (problem) throw new Error(problem);
	return outside ? null : common;
}

/** The number of pending drafts in `dir`'s queue; a missing queue holds none. */
function pendingCount(dir) {
	const common = commonDirOf(dir);
	if (common === null) return 0;
	const queue = issuesDir(common);
	let entries;
	try {
		entries = readdirSync(queue, { withFileTypes: true });
	} catch (err) {
		if (err?.code === "ENOENT") return 0;
		throw new Error(`cannot read ${queue} (${err?.code ?? err?.message})`);
	}
	return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).length;
}

/** The context line for this session start, or "" when there is nothing to say. */
function context() {
	const { event, problem } = readEvent();
	if (problem) return `[rpiv-hook] issue drafts not checked: ${problem}`;
	try {
		const count = pendingCount(
			typeof event?.cwd === "string" ? event.cwd : process.cwd(),
		);
		if (count === 0) return "";
		const drafts = count === 1 ? "draft" : "drafts";
		return `[rpiv] ${count} rpiv issue ${drafts} pending — /rpiv:issue`;
	} catch (err) {
		return `[rpiv-hook] issue drafts not checked: ${sanitizeForContext(err?.message ?? String(err))}`;
	}
}

function main() {
	limitGitTime(6_000);
	const additionalContext = context();
	if (!additionalContext) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
		}),
	);
}

if (isMain(import.meta.url)) main();
