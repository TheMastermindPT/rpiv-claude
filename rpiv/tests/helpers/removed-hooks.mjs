// removed-hooks.mjs — hook scripts deliberately removed since older pinned revisions.
//
// Tests that pin "every other hook entry is as it was at <commit>" compare against an
// older hooks.json. cross-agent-consistency.mjs was removed since then: it ran on
// PostToolBatch and read fields that payload never carries, so it never produced a
// result. withoutRemovedHooks drops that one entry from the old file (and an event
// left empty), so a test still fails on any other difference.

const REMOVED_HOOKS = ["/.claude/hooks/cross-agent-consistency.mjs"];

const isRemoved = (entry) =>
	entry.hooks.some((hook) =>
		REMOVED_HOOKS.some((name) => hook.command.includes(name)),
	);

/** `hooks` (a hooks.json `hooks` map) without the removed hooks' entries. */
export const withoutRemovedHooks = (hooks) =>
	Object.fromEntries(
		Object.entries(hooks)
			.map(([event, entries]) => [
				event,
				entries.filter((entry) => !isRemoved(entry)),
			])
			.filter(([, entries]) => entries.length > 0),
	);
