// record-approved-branch.mjs — PostToolUse hook (S2-approved-branch, D14). After a
// Bash or PowerShell command succeeds (Claude Code fires PostToolUse only then),
// every branch it created by a literal name is marked approved with
// `branch.<name>.rpivApproved = true`. The outward-action hook asked before each
// such creation, so a recorded branch is one the developer approved creating.
// The commit gate in approve-outward-actions.mjs reads the marker.

import { readFileSync } from "node:fs";
import {
	gitTimeLeft,
	isRepository,
	limitGitTime,
	runGit,
} from "./_git-branch.mjs";
import {
	forEachGitInvocation,
	isComputed,
	tokenize,
} from "./approve-outward-actions.mjs";

const SHELL_MODES = { Bash: "bash", PowerShell: "ps" };

// Options whose next word names the branch being created (D14).
const NAME_OPTIONS = {
	switch: /^(-[a-zA-Z]*[cC]|--create|--force-create)$/,
	checkout: /^-[a-zA-Z]*[bB]$/,
	worktree: /^-[a-zA-Z]*[bB]$/,
};
const JOINED_NAME_OPTION = /^--(create|force-create)=(.+)$/;
// `git branch <name>` creates only with these options; any other option lists,
// deletes, renames or copies, and is not recorded.
const BRANCH_CREATE_OPTIONS = new Set([
	"-f",
	"--force",
	"-q",
	"--quiet",
	"-t",
	"--track",
	"--no-track",
]);

/** The word naming the branch a git invocation creates, if any. */
function createdNameWord(sub, args) {
	if (sub === "branch") return branchNameWord(args);
	if (sub === "worktree" && args.words[args.from]?.value !== "add")
		return undefined;
	return Object.hasOwn(NAME_OPTIONS, sub)
		? optionNameWord(sub, args)
		: undefined;
}

/** The word after a name-taking option (or joined `--create=<name>`). */
function optionNameWord(sub, { words, from }) {
	for (let k = from; k < words.length && words[k].value !== "--"; k++) {
		const joined = sub === "switch" && JOINED_NAME_OPTION.exec(words[k].value);
		if (joined) return { ...words[k], value: joined[2] };
		if (NAME_OPTIONS[sub].test(words[k].value)) return words[k + 1];
	}
	return undefined;
}

/** `git branch <name> [<start>]`: the first non-option word, unless an option
    makes the invocation something other than a creation. */
function branchNameWord({ words, from }) {
	let name;
	for (let k = from; k < words.length; k++) {
		const { value } = words[k];
		if (!value.startsWith("-")) name ??= words[k];
		else if (!BRANCH_CREATE_OPTIONS.has(value)) return undefined;
	}
	return name;
}

/** Marks `name` approved where the creation ran, when the branch exists: a
    note when it cannot, null otherwise (a missing branch was not created). */
function recordCreation(name, place) {
	if (place.problem) return `${name}: ${place.problem}`;
	if (gitTimeLeft() <= 0) return `${name}: no time left to record it`;
	if (!isRepository(place.dir))
		return `${name}: ${place.dir} is not a readable git repository`;
	const exists = runGit(place.dir, [
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${name}`,
	]);
	if (exists.status !== 0) return null;
	const set = runGit(place.dir, [
		"config",
		`branch.${name}.rpivApproved`,
		"true",
	]);
	return set.status === 0 ? null : `${name}: git config failed`;
}

/** Records the event's creations; returns notes on what it could not record. */
function recordEvent(event) {
	const input = shellInput(event);
	if (input.notes) return input.notes;
	const notes = [];
	forEachGitInvocation(input.segments, input.mode, event.cwd ?? ".", (git) => {
		const note = creationNote(git);
		if (note) notes.push(note);
	});
	return notes;
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

/** Records the branch one git invocation created; a note when it cannot. */
function creationNote(git) {
	const word = createdNameWord(git.sub, git.args);
	if (word === undefined) return null;
	if (isComputed(word)) return "a branch name is computed";
	return recordCreation(word.value, git.place);
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
