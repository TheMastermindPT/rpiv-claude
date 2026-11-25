// readonly-guard-matcher.mjs — the read-only guard's hooks.json matcher, then and now.
//
// Tests that pin "every other hook entry is as it was at <commit>" compare against an
// older hooks.json. Since then the guard's matcher was deliberately widened from
// Edit/Write/Bash to every file-writing and shell tool (MultiEdit, NotebookEdit,
// PowerShell). withWidenedGuard applies that one change to the old file, so a test still
// fails on any other difference.

const READONLY_GUARD = "/.claude/hooks/enforce-readonly-agent.mjs";
const MATCHER_BEFORE = "Edit|Write|Bash";
const MATCHER_NOW = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell";

const widen = (entry) =>
	entry.matcher === MATCHER_BEFORE &&
	entry.hooks.some((hook) => hook.command.includes(READONLY_GUARD))
		? { ...entry, matcher: MATCHER_NOW }
		: entry;

/** `hooks` (a hooks.json `hooks` map) with the read-only guard's matcher widened. */
export const withWidenedGuard = (hooks) =>
	Object.fromEntries(
		Object.entries(hooks).map(([event, entries]) => [
			event,
			entries.map(widen),
		]),
	);
