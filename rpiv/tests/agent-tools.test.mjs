// agent-tools.test.mjs — every rpiv agent names its tools, and the read-only guard sees
// every tool that writes a file or runs a shell.
//
// An agent definition without a `tools:` line inherits every tool, Write and Edit
// included, and the read-only guard (.claude/hooks/enforce-readonly-agent.mjs) only runs
// for the tools its hooks.json matcher names. Either gap lets a read-only agent change
// files.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { splitFrontmatter } from "../.claude/hooks/_shared.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "agents");
const GUARD =
	'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/enforce-readonly-agent.mjs"';

const FILE_WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
// Agents allowed to write files. Every rpiv agent today reports back to the skill that
// dispatched it and never writes; an agent that must write is added here on purpose.
const WRITING_AGENTS = [];

const agentTools = () =>
	readdirSync(AGENTS)
		.filter((name) => name.endsWith(".md"))
		.map((name) => {
			const { fm } = splitFrontmatter(
				readFileSync(join(AGENTS, name), "utf-8").replaceAll("\r\n", "\n"),
			);
			return {
				agent: name.slice(0, -3),
				tools:
					fm.tools === undefined
						? undefined
						: fm.tools
								.split(",")
								.map((t) => t.trim())
								.filter(Boolean),
			};
		});

describe("agent tool declarations", () => {
	it("every agent declares a non-empty tools: line", () => {
		const agents = agentTools();
		expect(agents.length).toBeGreaterThan(0);
		const undeclared = agents
			.filter(({ tools }) => !tools || tools.length === 0)
			.map(({ agent }) => agent);
		expect(undeclared).toEqual([]);
	});

	it("no read-only agent lists a file-writing tool", () => {
		const writers = agentTools()
			.filter(({ agent }) => !WRITING_AGENTS.includes(agent))
			.flatMap(({ agent, tools = [] }) =>
				tools
					.filter((t) => FILE_WRITE_TOOLS.includes(t))
					.map((t) => `${agent}: ${t}`),
			);
		expect(writers).toEqual([]);
	});

	it("the read-only guard runs for every file-writing and shell tool", () => {
		const pre = JSON.parse(
			readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
		).hooks.PreToolUse;
		const entry = pre.find((e) => e.hooks.some((h) => h.command === GUARD));
		expect(entry).toBeDefined();
		const matcher = new RegExp(`^(?:${entry.matcher})$`);
		const missed = [...FILE_WRITE_TOOLS, "Bash", "PowerShell"].filter(
			(tool) => !matcher.test(tool),
		);
		expect(missed).toEqual([]);
		expect(
			["Read", "Grep", "Glob", "BashOutput"].filter((t) => matcher.test(t)),
		).toEqual([]);
	});
});
