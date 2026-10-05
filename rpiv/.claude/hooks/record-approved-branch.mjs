// record-approved-branch.mjs — PostToolUse hook (S2-approved-branch, D14). After a
// Bash or PowerShell command succeeds (Claude Code fires PostToolUse only then),
// every branch it created by a literal name is marked approved with
// `branch.<name>.rpivApproved = true`. The outward-action hook asked before each
// such creation, so a recorded branch is one the developer approved creating.
// The commit gate in approve-outward-actions.mjs reads the marker.

import { readFileSync } from "node:fs";
import { createdNameWord, takeBeforeNote } from "./_branch-creations.mjs";
import {
	branchExists,
	gitTimeLeft,
	limitGitTime,
	markApproved,
	repositoryProblem,
} from "./_git-branch.mjs";
import {
	forEachGitInvocation,
	isComputed,
	tokenize,
} from "./approve-outward-actions.mjs";

const SHELL_MODES = { Bash: "bash", PowerShell: "ps" };

/** Marks `name` approved where the creation ran when this command created it:
    it was not in the PreToolUse note and exists now (D14 S2 rev. 1). A note
    when it cannot tell, null otherwise. */
function recordCreation(name, place, before) {
	const why = cannotRecord(place, before);
	if (why) return `${name}: ${why}`;
	if (before[place.dir].includes(name)) return null;
	return markIfCreated(name, place.dir);
}

/** Why nothing can be recorded at `place`, or null. */
function cannotRecord(place, before) {
	if (place.problem) return place.problem;
	if (gitTimeLeft() <= 0) return "no time left to record it";
	// A directory that is not a repository has no note either; say why.
	const problem = repositoryProblem(place.dir);
	if (problem) return problem;
	return Array.isArray(before?.[place.dir])
		? null
		: "no note of the branches before the command";
}

/** Marks `name` approved in `dir` when it exists now; a note on failure. */
function markIfCreated(name, dir) {
	const now = branchExists(dir, name);
	if (now.problem) return `${name}: ${now.problem}`;
	if (!now.exists) return null;
	const failed = markApproved(dir, name);
	return failed ? `${name}: ${failed}` : null;
}

/** Records the event's creations; returns notes on what it could not record. */
function recordEvent(event) {
	const input = shellInput(event);
	if (input.notes) return input.notes;
	const before = takeBeforeNote(event.tool_use_id);
	const notes = [];
	forEachGitInvocation(input.segments, input.mode, event.cwd ?? ".", (git) => {
		const note = creationNote(git, before);
		if (note) notes.push(note);
	});
	if (createsInsideString(input.segments))
		notes.push(
			"a branch is created inside a string the recorder cannot follow",
		);
	return notes;
}

// Subcommands that can create a branch (D14 forms).
const CREATING = new Set(["switch", "checkout", "branch", "worktree"]);

/** Does a literal wrapper string (a quoted word holding a command, such as
    `bash -c 'git switch -c x'`) create a branch? Its creation is not followed,
    so it is reported (D14 S2 rev. 1). */
function createsInsideString(segments) {
	return segments.some(({ words }) =>
		words.some(
			(w) =>
				/\s/.test(w.value) && /\bgit\b/.test(w.value) && stringCreates(w.value),
		),
	);
}

function stringCreates(text) {
	let creates = false;
	try {
		forEachGitInvocation(tokenize(text, "bash"), "bash", ".", (git) => {
			creates ||= createdNameWord(git.sub, git.args) !== undefined;
		});
	} catch {
		return false;
	}
	return creates;
}

/** The event's parsed shell command `{ mode, segments }`, or `{ notes }` when
    there is nothing to record (other events and tools) or it cannot be read. */
function shellInput(event) {
	if (event?.hook_event_name !== "PostToolUse") return { notes: [] };
	if (!Object.hasOwn(SHELL_MODES, event.tool_name)) return { notes: [] };
	const mode = SHELL_MODES[event.tool_name];
	const command = event.tool_input?.command;
	if (typeof command !== "string") return { notes: ["the command is missing"] };
	try {
		return { mode, segments: tokenize(command, mode) };
	} catch (err) {
		return { notes: [`the command cannot be parsed (${err?.message ?? err})`] };
	}
}

/** A `!` inline alias runs its text in a shell with the command's later words
    appended, so a placeholder stands for them (D14 S2 rev. 2). */
const shellAliasCreates = (value) =>
	value?.startsWith("!") === true && stringCreates(`${value.slice(1)} name`);

/** Records the branch one git invocation created; a note when it cannot. */
function creationNote(git, before) {
	if (git.args.aliased && CREATING.has(git.sub))
		return "a branch may be created through an inline git alias";
	if (shellAliasCreates(git.args.aliasValue))
		return "a branch is created through a shell (!) git alias";
	const word = createdNameWord(git.sub, git.args);
	if (word === undefined) return null;
	if (isComputed(word)) return "a branch name is computed";
	if (word.unreadable)
		return `${word.value}: created in a form the recorder does not read`;
	return recordCreation(word.value, git.place, before);
}

function readNotes() {
	let event;
	try {
		event = JSON.parse(readFileSync(0, "utf-8"));
	} catch {
		return ["the hook event is not valid JSON"];
	}
	try {
		return recordEvent(event);
	} catch (err) {
		return [`internal error: ${err?.message ?? err}`];
	}
}

/** A creation that could not be recorded is told to Claude, never dropped
    silently (degrade-distinguishes-broken). */
function main() {
	// Recording stays inside the 10-second hook timeout (D13).
	limitGitTime(6_000);
	const notes = readNotes();
	if (notes.length === 0) return;
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: `[rpiv-hook] approval not recorded: ${summary(notes)}`,
			},
		}),
	);
}

const SHOWN_NOTES = 5;

const summary = (notes) =>
	notes.length <= SHOWN_NOTES
		? notes.join("; ")
		: `${notes.slice(0, SHOWN_NOTES).join("; ")}; and ${notes.length - SHOWN_NOTES} more`;

main();
