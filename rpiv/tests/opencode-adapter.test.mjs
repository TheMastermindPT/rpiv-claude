import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	adaptAgent,
	adaptSkill,
	adaptSupportMarkdown,
	buildOpenCodeDefinitions,
	generateOpenCodeSkills,
} from "../opencode/adapter.mjs";
import {
	applyRpivConfig,
	buildClaudeToolEvent,
	collectTouchedFiles,
	extractAdditionalContext,
} from "../opencode/plugin-support.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function listRelativeFiles(root, prefix = "") {
	return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
		(entry) => {
			const relative = join(prefix, entry.name);
			return entry.isDirectory()
				? listRelativeFiles(root, relative)
				: [relative];
		},
	);
}

describe("OpenCode agent adapter", () => {
	it.each([
		["fable", "openai/gpt-6-astra"],
		["opus", "openai/gpt-5.6-terra"],
		["sonnet", "openai/gpt-5.6-luna"],
	])("maps %s to %s", (sourceModel, expectedModel) => {
		const source = `---\nname: sample\ndescription: Sample agent\ntools: Read, Grep, Glob\nmodel: ${sourceModel}\neffort: low\n---\n\nPrompt`;

		expect(adaptAgent(source, "sample")).toMatchObject({
			id: "rpiv:sample",
			config: {
				model: expectedModel,
				mode: "subagent",
				permission: { edit: "deny", bash: "deny" },
			},
		});
		expect(adaptAgent(source, "sample").config.tools).toEqual({
			"*": false,
			glob: true,
			grep: true,
			read: true,
		});
	});

	it("keeps the two shell agents read-only with narrow command allowlists", () => {
		const claimSource = readFileSync(
			join(ROOT, "agents", "claim-verifier.md"),
			"utf8",
		);
		const precedentSource = readFileSync(
			join(ROOT, "agents", "precedent-locator.md"),
			"utf8",
		);

		expect(
			adaptAgent(claimSource, "claim-verifier").config.permission.bash,
		).toEqual({
			"*": "deny",
			"git show *": "allow",
			"*&&*": "deny",
			"*;*": "deny",
			"*|*": "deny",
			"*>*": "deny",
			"*--ext-diff*": "deny",
			"*--output*": "deny",
			"*--textconv*": "deny",
		});
		expect(
			adaptAgent(precedentSource, "precedent-locator").config.permission.bash,
		).toEqual({
			"*": "deny",
			"git diff *": "allow",
			"git log *": "allow",
			"git rev-parse *": "allow",
			"git show *": "allow",
			"*&&*": "deny",
			"*;*": "deny",
			"*|*": "deny",
			"*>*": "deny",
			"*--ext-diff*": "deny",
			"*--output*": "deny",
			"*--textconv*": "deny",
		});
	});

	it("prefers Exa in the generated web researcher", () => {
		const source = readFileSync(
			join(ROOT, "agents", "web-search-researcher.md"),
			"utf8",
		);
		const agent = adaptAgent(source, "web-search-researcher");

		expect(agent.config.model).toBe("openai/gpt-5.6-terra");
		expect(agent.config.prompt).toContain("exa-search_web_search_exa");
		expect(agent.config.prompt).toContain("exa-search_web_fetch_exa");
		expect(agent.config.prompt).toContain("fallback");
		expect(agent.config.tools).toMatchObject({
			"*": false,
			"exa-search_*": true,
			webfetch: true,
			websearch: true,
		});
	});

	it("uses the permitted OpenCode Context Mode tool names", () => {
		const source = readFileSync(
			join(ROOT, "agents", "codebase-analyzer.md"),
			"utf8",
		);
		const agent = adaptAgent(source, "codebase-analyzer");

		expect(agent.config.prompt).toContain("context-mode_ctx_search");
		expect(agent.config.prompt).toContain("context-mode_ctx_execute_file");
		expect(agent.config.prompt).not.toMatch(
			/(?<!context-mode_)\bctx_(?:search|execute_file)\b/,
		);
		expect(agent.config.tools).toMatchObject({
			"*": false,
			"context-mode_*": true,
		});
	});
});

describe("OpenCode skill adapter", () => {
	it("creates a portable RPIV skill and command name", () => {
		const source = `---\nname: research\ndescription: Research a codebase\nallowed-tools: Agent, Read\nshell-timeout: 10\n---\n\nAgent({ subagent_type: "rpiv:scope-tracer" })\n\nUse ask_user_question.\n\n\`\`\`!\nnode "\${CLAUDE_PLUGIN_ROOT}/skills/_shared/now.mjs"\n\`\`\``;
		const result = adaptSkill(source, "research");

		expect(result.id).toBe("rpiv-research");
		expect(result.commandName).toBe("rpiv:research");
		expect(result.content).toContain("name: rpiv-research");
		expect(result.content).not.toContain("allowed-tools:");
		expect(result.content).not.toContain("shell-timeout:");
		expect(result.content).toContain(
			'task({ subagent_type: "rpiv:scope-tracer" })',
		);
		expect(result.content).toContain("Use question.");
		expect(result.content).toContain(
			"$RPIV_PLUGIN_ROOT/skills/_shared/now.mjs",
		);
		expect(result.content).toContain("Run this command with the `bash` tool");
	});

	it("adapts MCP names in bundled Markdown references", () => {
		const adapted = adaptSupportMarkdown(
			"Use mcp__sonarqube__analyze_file_list and mcp__codescene__code_health_review.",
		);

		expect(adapted).toBe(
			"Use sonarqube_analyze_file_list and codescene_code_health_review.",
		);
	});
});

describe("OpenCode definition inventory", () => {
	it("registers every RPIV agent, skill, and namespaced command", () => {
		const definitions = buildOpenCodeDefinitions(ROOT);

		expect(Object.keys(definitions.agents)).toHaveLength(20);
		expect(definitions.skills).toHaveLength(20);
		expect(Object.keys(definitions.commands)).toHaveLength(20);
		expect(definitions.commands["rpiv:plan"].template).toContain("rpiv-plan");
		expect(definitions.commands["rpiv:plan"].template).toContain("$ARGUMENTS");
	});

	it("writes discoverable generated skills", () => {
		const output = join(
			mkdtempSync(join(tmpdir(), "rpiv-opencode-")),
			"skills",
		);

		const result = generateOpenCodeSkills(ROOT, output);

		expect(result).toEqual({ count: 20, output });
		const plan = readFileSync(join(output, "rpiv-plan", "SKILL.md"), "utf8");
		expect(plan).toContain("name: rpiv-plan");
		expect(plan).toContain("$RPIV_PLUGIN_ROOT");
		expect(
			readFileSync(
				join(output, "rpiv-discover", "templates", "frd.md"),
				"utf8",
			),
		).toContain("# FRD:");
		expect(
			readFileSync(join(output, "_shared", "source-vocab.mjs"), "utf8"),
		).toContain("SOURCE_EXT");
		const dispatch = readFileSync(
			join(output, "_shared", "artifact-review-dispatch.md"),
			"utf8",
		);
		expect(dispatch).toContain("task({");
		expect(dispatch).not.toContain("Agent({");
	});

	it("keeps committed generated skills synchronized with their sources", () => {
		const definitions = buildOpenCodeDefinitions(ROOT);

		for (const skill of definitions.skills) {
			const generatedDirectory = join(
				ROOT,
				"opencode",
				"generated",
				"skills",
				skill.id,
			);
			const generated = readFileSync(
				join(generatedDirectory, "SKILL.md"),
				"utf8",
			);
			expect(generated, skill.id).toBe(skill.content);

			const sourceDirectory = join(ROOT, "skills", skill.sourceName);
			const supportFiles = listRelativeFiles(sourceDirectory).filter(
				(path) => path !== "SKILL.md",
			);
			expect(listRelativeFiles(generatedDirectory).sort(), skill.id).toEqual(
				["SKILL.md", ...supportFiles].sort(),
			);
			for (const path of supportFiles) {
				const source = readFileSync(join(sourceDirectory, path));
				const expected = path.endsWith(".md")
					? Buffer.from(adaptSupportMarkdown(source.toString("utf8")))
					: source;
				expect(
					readFileSync(join(generatedDirectory, path)),
					`${skill.id}/${path}`,
				).toEqual(expected);
			}
		}

		const sharedSource = join(ROOT, "skills", "_shared");
		const sharedGenerated = join(
			ROOT,
			"opencode",
			"generated",
			"skills",
			"_shared",
		);
		const sharedFiles = listRelativeFiles(sharedSource).sort();
		expect(listRelativeFiles(sharedGenerated).sort()).toEqual(sharedFiles);
		for (const path of sharedFiles) {
			const source = readFileSync(join(sharedSource, path));
			const expected = path.endsWith(".md")
				? Buffer.from(adaptSupportMarkdown(source.toString("utf8")))
				: source;
			expect(
				readFileSync(join(sharedGenerated, path)),
				`_shared/${path}`,
			).toEqual(expected);
		}
	});
});

describe("OpenCode plugin support", () => {
	it("merges RPIV definitions without replacing existing config", () => {
		const config = {
			agent: { existing: { description: "keep" } },
			command: { existing: { template: "keep" } },
			skills: { paths: ["C:/existing"] },
		};

		applyRpivConfig(config, ROOT);

		expect(config.agent.existing).toEqual({ description: "keep" });
		expect(config.agent["rpiv:scope-tracer"]).toBeDefined();
		expect(config.command.existing).toEqual({ template: "keep" });
		expect(config.command["rpiv:research"]).toBeDefined();
		expect(config.skills.paths).toEqual([
			"C:/existing",
			join(ROOT, "opencode", "generated", "skills"),
		]);
	});

	it("extracts all files touched by apply_patch", () => {
		const patchText = `*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/moved.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** End Patch`;

		expect(
			collectTouchedFiles("apply_patch", { patchText }, "C:/repo"),
		).toEqual([
			join("C:/repo", "src/a.ts"),
			join("C:/repo", "src/moved.ts"),
			join("C:/repo", "src/b.ts"),
		]);
	});

	it("normalizes OpenCode calls into the Claude hook envelope", () => {
		expect(
			buildClaudeToolEvent({
				tool: "edit",
				args: { filePath: "src/a.ts" },
				directory: "C:/repo",
				sessionID: "session-1",
			}),
		).toEqual({
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "src/a.ts" },
			cwd: "C:/repo",
			session_id: "session-1",
		});
	});

	it("extracts additional context from both supported hook envelopes", () => {
		expect(extractAdditionalContext('{"additionalContext":"first"}')).toBe(
			"first",
		);
		expect(
			extractAdditionalContext(
				'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"second"}}',
			),
		).toBe("second");
		expect(extractAdditionalContext("not-json")).toBe("");
	});
});
