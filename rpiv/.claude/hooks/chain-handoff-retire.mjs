// chain-handoff-retire.mjs — UserPromptExpansion and PostToolUse(Skill) hook that
// retires a pending chain handoff when the next chain stage starts (S31-handoff-clear,
// D41). A pipeline skill writes `<git-dir>/rpiv/handoff.json` as it ends its stage
// (skills/_shared/handoff.mjs); when a chain stage then starts — typed as
// `/rpiv:<stage>` or started by the model — this hook renames that file to
// `handoff.superseded.json`, so the clear hook (chain-handoff-restore.mjs) never
// shows a step that is already under way. A stage that ends on a stop leaves
// nothing pending; a stage run without `/clear` retires the handoff it follows.
//
// Other skills and events, a worktree with nothing pending and a directory in no
// repository say nothing. A handoff that could not be retired is said
// (degrade-distinguishes-broken): `[rpiv-hook] handoff not retired: <why>`, and the
// file stays. Never blocks; always exits 0.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { OUTSIDE_REPOSITORY, stageName } from "../../skills/_shared/cycles.mjs";
import { isMain } from "../../skills/_shared/is-main.mjs";
import { limitGitTime, runGit } from "./_git-branch.mjs";
import { sanitizeForContext } from "./_shared.mjs";

// The handoff writers, and pr: validate's next step (D41).
const CHAIN_STAGES = new Set([
	"discover",
	"research",
	"design",
	"plan",
	"implement",
	"deep-review",
	"validate",
	"pr",
]);
const EVENTS = new Set(["PostToolUse", "UserPromptExpansion"]);

/** The chain stage this event starts, or null. */
function chainStage(event) {
	let name;
	if (event?.hook_event_name === "UserPromptExpansion")
		name = event.command_name;
	else if (
		event?.hook_event_name === "PostToolUse" &&
		event.tool_name === "Skill"
	)
		name = event.tool_input?.skill;
	const stage = stageName(name);
	return CHAIN_STAGES.has(stage) ? stage : null;
}

/** The worktree's absolute git dir for `dir`, or null outside a repository;
    any other failure throws its reason. */
function gitDirOf(dir) {
	if (!existsSync(dir)) throw new Error(`cwd does not exist: ${dir}`);
	const res = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	if (res.error) throw new Error(`git could not run (${res.error})`);
	if (res.status === 0) return res.out;
	// Only git's "no repository at all" answer is outside; a `.git` pointer to a
	// missing folder is broken (cycles.mjs owns the text; S31 revision 1).
	if (res.err.includes(OUTSIDE_REPOSITORY)) return null;
	throw new Error(`git refused ${dir}: ${res.err.split("\n")[0]}`);
}

/** Retires the pending handoff of `dir`'s worktree, if any. */
function retire(dir) {
	const gitDir = gitDirOf(dir);
	if (gitDir === null) return;
	const path = `${gitDir}/rpiv/handoff.json`;
	if (!existsSync(path)) return;
	try {
		renameSync(path, `${gitDir}/rpiv/handoff.superseded.json`);
	} catch (err) {
		throw new Error(
			`cannot move ${path} (${err?.code ?? err?.message ?? err})`,
		);
	}
}

/** The hook event from `read()` (stdin by default): `{ event }`, or `{ problem }`
    telling an unreadable input from one that is not JSON (S31 revision 1). */
export function readEvent(read = () => readFileSync(0, "utf-8")) {
	let text;
	try {
		text = read();
	} catch (err) {
		return {
			problem: `cannot read the hook event (${err?.code ?? err?.message ?? err})`,
		};
	}
	try {
		return { event: JSON.parse(text) };
	} catch {
		return { problem: "the hook event is not valid JSON" };
	}
}

/** `{ eventName, note }`: the note says why nothing was retired, or is null. */
function readAndRetire() {
	const { event, problem } = readEvent();
	if (problem) return { eventName: "PostToolUse", note: problem };
	const name = event?.hook_event_name;
	const eventName = EVENTS.has(name) ? name : "PostToolUse";
	if (chainStage(event) === null) return { eventName, note: null };
	try {
		retire(typeof event.cwd === "string" ? event.cwd : process.cwd());
		return { eventName, note: null };
	} catch (err) {
		return { eventName, note: err?.message ?? String(err) };
	}
}

function main() {
	limitGitTime(6_000);
	const { eventName, note } = readAndRetire();
	if (!note) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: eventName,
				additionalContext: `[rpiv-hook] handoff not retired: ${sanitizeForContext(note)}`,
			},
		}),
	);
}

if (isMain(import.meta.url)) main();
