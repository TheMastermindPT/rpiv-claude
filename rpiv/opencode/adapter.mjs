import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { splitFrontmatter } from "../skills/_shared/frontmatter.mjs";

const MODEL_MAP = Object.freeze({
	fable: "openai/gpt-6-astra",
	opus: "openai/gpt-5.6-terra",
	sonnet: "openai/gpt-5.6-luna",
});

const BASH_PERMISSIONS = Object.freeze({
	"claim-verifier": Object.freeze({
		"*": "deny",
		"git show *": "allow",
		"*&&*": "deny",
		"*;*": "deny",
		"*|*": "deny",
		"*>*": "deny",
		"*--ext-diff*": "deny",
		"*--output*": "deny",
		"*--textconv*": "deny",
	}),
	"precedent-locator": Object.freeze({
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
	}),
});

const TOOL_REPLACEMENTS = Object.freeze([
	[
		/mcp__plugin_context-mode_context-mode__ctx_execute_file/g,
		"context-mode_ctx_execute_file",
	],
	[
		/mcp__plugin_context-mode_context-mode__ctx_search/g,
		"context-mode_ctx_search",
	],
	[/mcp__context-mode__ctx_execute_file/g, "context-mode_ctx_execute_file"],
	[/mcp__context-mode__ctx_search/g, "context-mode_ctx_search"],
	[/(?<!context-mode_)\bctx_execute_file\b/g, "context-mode_ctx_execute_file"],
	[/(?<!context-mode_)\bctx_search\b/g, "context-mode_ctx_search"],
	[/(?<!context-mode_)\bctx_index\b/g, "context-mode_ctx_index"],
	[/mcp__codescene__/g, "codescene_"],
	[/mcp__sonarqube__/g, "sonarqube_"],
	[/ask_user_question/g, "question"],
	[/WebSearch/g, "exa-search_web_search_exa"],
	[/WebFetch/g, "exa-search_web_fetch_exa"],
	[/\bAgent\b/g, "task"],
]);

const ADAPTER_PREAMBLE = `> OpenCode adapter: use lowercase native tool names. Treat \`task\` as the
> subagent dispatcher and \`question\` as the structured user-question tool. The text
> supplied after \`User arguments:\` by an \`/rpiv:*\` command is \`$ARGUMENTS\`.
> Resolve bundled scripts through \`$RPIV_PLUGIN_ROOT\` and project state through
> \`$RPIV_PROJECT_DIR\`.`;

const EXA_PREAMBLE = `> Web research policy: prefer \`exa-search_web_search_exa\` and
> \`exa-search_web_fetch_exa\`. Use OpenCode's standard web search or fetch only as a
> fallback when Exa is unavailable or fails.`;

const CONTEXT_MODE_PREAMBLE = `> Context Mode tools: use \`context-mode_ctx_search\`,
> \`context-mode_ctx_execute_file\`, and \`context-mode_ctx_index\` when available.`;

function adaptExecutableFences(body) {
	return body.replace(/^```!\r?\n([\s\S]*?)\r?\n```$/gm, (_match, command) => {
		return `Run this command with the \`bash\` tool and use its output:\n\n\`\`\`sh\n${command}\n\`\`\``;
	});
}

function adaptSyntax(body) {
	let adapted = body
		.replaceAll("${CLAUDE_PLUGIN_ROOT}", "$RPIV_PLUGIN_ROOT")
		.replaceAll("$CLAUDE_PROJECT_DIR", "$RPIV_PROJECT_DIR")
		.replaceAll("CLAUDE.md", "AGENTS.md");

	for (const [pattern, replacement] of TOOL_REPLACEMENTS) {
		adapted = adapted.replace(pattern, replacement);
	}

	return adaptExecutableFences(adapted);
}

function adaptBody(body, { webResearch = false } = {}) {
	const adapted = adaptSyntax(body);
	const preamble = webResearch
		? `${ADAPTER_PREAMBLE}\n\n${EXA_PREAMBLE}`
		: ADAPTER_PREAMBLE;
	return `${preamble}\n\n${adapted.trimStart()}`;
}

/**
 * Translate a bundled Markdown reference without adding skill frontmatter or a preamble.
 *
 * @param {string} source Canonical Claude-oriented Markdown.
 * @returns {string} OpenCode-oriented Markdown.
 */
export function adaptSupportMarkdown(source) {
	return adaptSyntax(source);
}

function normalizeDescription(description, fallback) {
	const normalized = (description || fallback).replace(/\s+/g, " ").trim();
	return normalized.length <= 1024
		? normalized
		: `${normalized.slice(0, 1021)}...`;
}

function splitSource(source) {
	return splitFrontmatter(
		source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"),
	);
}

function skillFrontmatter(id, description) {
	return `---
name: ${id}
description: ${JSON.stringify(description)}
compatibility: opencode
metadata:
  source: rpiv
  generated: "true"
---`;
}

function buildAgentTools(toolsValue, webResearch) {
	const sourceTools = new Set(
		(toolsValue || "")
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
	);
	const tools = { "*": false };
	if (sourceTools.has("Read")) tools.read = true;
	if (sourceTools.has("Grep")) tools.grep = true;
	if (sourceTools.has("Glob")) tools.glob = true;
	if (sourceTools.has("Bash")) tools.bash = true;
	if ([...sourceTools].some((tool) => tool.includes("context-mode"))) {
		tools["context-mode_*"] = true;
	}
	if (webResearch) {
		tools["exa-search_*"] = true;
		tools.webfetch = true;
		tools.websearch = true;
	}
	return tools;
}

/**
 * Convert one Claude subagent definition into an OpenCode subagent config.
 *
 * @param {string} source Markdown agent definition.
 * @param {string} fallbackName File-derived name used when frontmatter omits it.
 * @returns {{ id: string, config: Record<string, unknown> }} OpenCode agent entry.
 */
export function adaptAgent(source, fallbackName) {
	const { fm, body } = splitSource(source);
	const name = fm.name || fallbackName;
	const sourceModel = fm.model;
	const model =
		name === "web-search-researcher"
			? "openai/gpt-5.6-terra"
			: MODEL_MAP[sourceModel];
	if (!model)
		throw new Error(`Unsupported RPIV agent model "${sourceModel}" in ${name}`);

	const bash = BASH_PERMISSIONS[name] || "deny";
	const webResearch = name === "web-search-researcher";
	const contextMode = fm.tools?.includes("context-mode") || false;
	const prompt = adaptBody(body, { webResearch });
	return {
		id: `rpiv:${name}`,
		config: {
			description: normalizeDescription(
				fm.description,
				`RPIV ${name} subagent`,
			),
			mode: "subagent",
			model,
			prompt: contextMode ? `${CONTEXT_MODE_PREAMBLE}\n\n${prompt}` : prompt,
			tools: buildAgentTools(fm.tools, webResearch),
			permission: {
				edit: "deny",
				bash,
				task: "deny",
				todowrite: "deny",
			},
		},
	};
}

/**
 * Convert one Claude skill into a portable OpenCode skill and namespaced command.
 *
 * @param {string} source Claude SKILL.md content.
 * @param {string} fallbackName Directory-derived skill name.
 * @returns {{ id: string, commandName: string, description: string, content: string }} Generated skill.
 */
export function adaptSkill(source, fallbackName) {
	const { fm, body } = splitSource(source);
	const name = fm.name || fallbackName;
	const id = `rpiv-${name}`;
	const description = normalizeDescription(
		fm.description,
		`Run the RPIV ${name} workflow`,
	);

	return {
		id,
		sourceName: name,
		commandName: `rpiv:${name}`,
		description,
		content: `${skillFrontmatter(id, description)}\n\n${adaptBody(body)}\n`,
	};
}

function readAgentDefinitions(root) {
	const agentsDir = join(root, "agents");
	return readdirSync(agentsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			const name = entry.name.slice(0, -3);
			return adaptAgent(
				readFileSync(join(agentsDir, entry.name), "utf8"),
				name,
			);
		});
}

function readSkillDefinitions(root) {
	const skillsDir = join(root, "skills");
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "_shared")
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((entry) => {
			const path = join(skillsDir, entry.name, "SKILL.md");
			return adaptSkill(readFileSync(path, "utf8"), entry.name);
		});
}

function copySupportTree(source, destination) {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === "SKILL.md") continue;
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) {
			copySupportTree(sourcePath, destinationPath);
		} else if (entry.name.endsWith(".md")) {
			writeFileSync(
				destinationPath,
				adaptSupportMarkdown(readFileSync(sourcePath, "utf8")),
				"utf8",
			);
		} else {
			cpSync(sourcePath, destinationPath);
		}
	}
}

/**
 * Build the complete OpenCode registration inventory from the canonical RPIV sources.
 *
 * @param {string} root Absolute RPIV repository root.
 * @returns {{ agents: Record<string, unknown>, skills: ReturnType<typeof adaptSkill>[], commands: Record<string, unknown> }} Definitions.
 */
export function buildOpenCodeDefinitions(root) {
	const agentEntries = readAgentDefinitions(root);
	const skills = readSkillDefinitions(root);
	return {
		agents: Object.fromEntries(
			agentEntries.map(({ id, config }) => [id, config]),
		),
		skills,
		commands: Object.fromEntries(
			skills.map((skill) => [
				skill.commandName,
				{
					description: skill.description,
					template:
						`Load the \`${skill.id}\` skill with the skill tool before doing anything else.\n\n` +
						"User arguments: $ARGUMENTS\n\n" +
						"Treat those user arguments as the skill's `$ARGUMENTS` and follow the skill exactly.",
				},
			]),
		),
	};
}

/**
 * Regenerate the OpenCode skill tree from the canonical Claude skill sources.
 *
 * @param {string} root Absolute RPIV repository root.
 * @param {string} output Absolute generated skills directory.
 * @returns {{ count: number, output: string }} Generation summary.
 */
export function generateOpenCodeSkills(root, output) {
	const { skills } = buildOpenCodeDefinitions(root);
	rmSync(output, { recursive: true, force: true });
	for (const skill of skills) {
		const directory = join(output, skill.id);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), skill.content, "utf8");
		copySupportTree(join(root, "skills", skill.sourceName), directory);
	}
	copySupportTree(join(root, "skills", "_shared"), join(output, "_shared"));
	return { count: skills.length, output };
}
