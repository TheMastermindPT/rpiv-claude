// _branch-creations.mjs — which branch a git invocation creates by a literal
// name (D14), and the per-tool-call note of branches that existed before it
// ran (D14 S2 rev. 1). Shared by the outward-action hook (PreToolUse: writes the
// note) and the approval recorder (PostToolUse: reads it).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Options whose next word names the branch being created (D14).
const NAME_OPTIONS = {
	switch: /^(-[a-zA-Z]*[cC]|--create|--force-create)$/,
	checkout: /^-[a-zA-Z]*[bB]$/,
	worktree: /^-[a-zA-Z]*[bB]$/,
};
const JOINED_NAME_OPTION = /^--(create|force-create)=(.+)$/;
// `git branch <name>` creates only with these options; any other option lists,
// deletes, renames or copies.
const BRANCH_CREATE_OPTIONS = new Set([
	"-f",
	"--force",
	"-q",
	"--quiet",
	"-t",
	"--track",
	"--no-track",
]);

/** The word naming the branch a git invocation (`sub` with arguments from
    `args.from`) creates, if any. */
export function createdNameWord(sub, args) {
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

// ---- the before-note, keyed by the tool call ---------------------------------------

const NOTES_DIR = join(tmpdir(), "rpiv-branch-notes");
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const notePath = (toolUseId) =>
	TOOL_USE_ID.test(toolUseId ?? "")
		? join(NOTES_DIR, `${toolUseId}.json`)
		: null;

/** Saves `{ <dir>: <branch names> | null }` for the tool call; false when the
    id is unusable or the note cannot be written. */
export function writeBeforeNote(toolUseId, branchesByDir) {
	const path = notePath(toolUseId);
	if (path === null) return false;
	try {
		mkdirSync(NOTES_DIR, { recursive: true });
		writeFileSync(path, JSON.stringify(branchesByDir));
		return true;
	} catch {
		return false;
	}
}

/** Reads and removes the tool call's note: the saved object, or null. */
export function takeBeforeNote(toolUseId) {
	const path = notePath(toolUseId);
	if (path === null) return null;
	try {
		const note = JSON.parse(readFileSync(path, "utf-8"));
		rmSync(path, { force: true });
		return note;
	} catch {
		return null;
	}
}
