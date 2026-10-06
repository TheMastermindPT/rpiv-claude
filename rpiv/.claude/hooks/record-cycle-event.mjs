// record-cycle-event.mjs — PostToolUse, SubagentStart and UserPromptExpansion hook
// (S15-cycle-metrics, D24). Appends one line to the cycle metrics log
// (skills/_shared/cycles.mjs owns where it lives and reads it) per cycle event:
//   - stage: a typed `/rpiv:<name>` command (UserPromptExpansion) or an rpiv skill
//     the model starts (PostToolUse of Skill);
//   - decision: an answered AskUserQuestion (PostToolUse fires only after the tool
//     succeeded), counting each of its questions;
//   - dispatch: a subagent start (SubagentStart; also fires on resume, so the reader
//     counts distinct agent ids).
// Lines are keyed by the branch checked out in the event's directory and hold no
// prompt, argument, question or answer text. A directory outside any repository and
// any other event record nothing and say nothing; a broken event, git or write says
// why. The hook never blocks.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	cycleLogPath,
	readCommonDir,
	readHeadBranch,
	stageName,
} from "../../skills/_shared/cycles.mjs";
import { limitGitTime, runGit } from "./_git-branch.mjs";

const textOrNull = (value) => (typeof value === "string" ? value : null);

/** The fields this event adds to a line, or null when it is no cycle event. */
function eventFields(event) {
	if (event.hook_event_name === "SubagentStart")
		return {
			event: "dispatch",
			agent: textOrNull(event.agent_type),
			agent_id: textOrNull(event.agent_id),
		};
	if (event.hook_event_name === "UserPromptExpansion")
		return stageFields(event.command_name, "command");
	if (event.hook_event_name !== "PostToolUse") return null;
	if (event.tool_name === "Skill")
		return stageFields(event.tool_input?.skill, "skill");
	if (event.tool_name !== "AskUserQuestion") return null;
	const questions = event.tool_input?.questions;
	// A changed tool shape must not silently count zero decisions (W2).
	if (!Array.isArray(questions))
		return { problem: "AskUserQuestion input has no questions list" };
	return { event: "decision", questions: questions.length };
}

/** A stage line's fields for an rpiv command or skill name, else null. */
function stageFields(name, via) {
	const stage = stageName(name);
	return stage ? { event: "stage", stage, via } : null;
}

const gitFailed = (error) => ({ problem: `git could not run (${error})` });

/** `{ log, branch }` for the repository at `dir`, `{ absent: true }` when `dir`
    is in no repository, or `{ problem }` when git could not run, refused the
    repository or could not read its HEAD (degrade-distinguishes-broken). */
function placeOf(dir) {
	// A vanished directory (a worktree removed mid-session) is a dropped event,
	// not an absent repository (S15 revision 3).
	if (!existsSync(dir)) return { problem: `cwd does not exist: ${dir}` };
	const res = runGit(dir, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (res.error) return gitFailed(res.error);
	const repo = readCommonDir(res, dir);
	if (repo.outside) return { absent: true };
	if (repo.problem) return repo;
	const ref = runGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
	if (ref.error) return gitFailed(ref.error);
	const head = readHeadBranch(ref);
	if (head.problem) return head;
	return { log: cycleLogPath(repo.common), branch: head.branch };
}

/** Appends this event's line: null, or why it was not recorded. */
function recordEvent(event) {
	const fields = eventFields(event);
	if (!fields) return null;
	if (fields.problem) return fields.problem;
	const place = placeOf(typeof event.cwd === "string" ? event.cwd : process.cwd());
	if (place.absent) return null;
	if (place.problem) return place.problem;
	const line = {
		v: 1,
		time: new Date().toISOString(),
		branch: place.branch,
		session: textOrNull(event.session_id),
		...fields,
	};
	try {
		mkdirSync(dirname(place.log), { recursive: true });
		appendFileSync(place.log, `${JSON.stringify(line)}\n`);
	} catch (err) {
		return `cannot write ${place.log} (${err?.code ?? err?.message ?? err})`;
	}
	return null;
}

const EVENTS = new Set(["PostToolUse", "SubagentStart", "UserPromptExpansion"]);

/** `{ eventName, note }`: the note says why nothing was recorded, or is null. */
function readAndRecord() {
	let event;
	try {
		event = JSON.parse(readFileSync(0, "utf-8"));
	} catch {
		return { eventName: "PostToolUse", note: "the hook event is not valid JSON" };
	}
	const name = event?.hook_event_name;
	const eventName = EVENTS.has(name) ? name : "PostToolUse";
	try {
		return { eventName, note: recordEvent(event) };
	} catch (err) {
		return { eventName, note: `internal error: ${err?.message ?? err}` };
	}
}

/** A line that could not be recorded is told to Claude, never dropped silently
    (degrade-distinguishes-broken); the hook never blocks. */
function main() {
	// Recording stays inside the 10-second hook timeout (D13).
	limitGitTime(6_000);
	const { eventName, note } = readAndRecord();
	if (!note) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: eventName,
				additionalContext: `[rpiv-hook] cycle event not recorded: ${note}`,
			},
		}),
	);
}

main();
