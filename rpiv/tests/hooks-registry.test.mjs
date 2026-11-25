// hooks.json names scripts by path; a script deleted without its entry would
// only show up as a hook that silently never runs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const registry = JSON.parse(
	readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
);
const commands = Object.values(registry.hooks)
	.flat()
	.flatMap((group) => group.hooks.map((hook) => hook.command));
const scriptOf = (command) =>
	command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)?.[1];

describe("hook registry", () => {
	it("every registered hook script exists", () => {
		// An empty or misread registry must not pass by having nothing to check.
		expect(commands.length).toBeGreaterThanOrEqual(15);
		const missing = commands.filter((command) => {
			const script = scriptOf(command);
			return !script || !existsSync(`${PLUGIN}/${script}`);
		});
		expect(missing).toEqual([]);
	});

	it("registers nothing on PostToolBatch, whose payload carries no tool results", () => {
		// cross-agent-consistency.mjs read `result`, `tool_output` and `agent_type`
		// there; the event never sends them, so it ran on every batch for nothing.
		expect(registry.hooks.PostToolBatch).toBeUndefined();
		expect(
			commands.filter((command) => command.includes("cross-agent-consistency")),
		).toEqual([]);
		expect(
			existsSync(`${PLUGIN}/.claude/hooks/cross-agent-consistency.mjs`),
		).toBe(false);
	});
});
