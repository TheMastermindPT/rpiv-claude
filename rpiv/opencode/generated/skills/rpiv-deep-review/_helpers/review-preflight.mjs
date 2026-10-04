import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "../../_shared/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_PROBE = join(HERE, "..", "..", "_shared", "tool-probe.mjs");

/** Parse the stable text contract emitted by tool-probe.mjs. */
export function parseToolProbe(output) {
	const local = {};
	const reports = {};
	let section = "head";
	let ecosystem = "unknown";
	for (const line of output.split("\n")) {
		if (line === "---tool-coverage---") {
			section = "tools";
			continue;
		}
		if (line === "---report-status---") {
			section = "reports";
			continue;
		}
		if (line.startsWith("ecosystem:"))
			ecosystem = line.slice(line.indexOf(":") + 1).trim();
		if (section === "tools" && line.includes("\t")) {
			const [name, ...fields] = line.split("\t");
			local[name] = Object.fromEntries(
				fields.map((field) => {
					const split = field.indexOf("=");
					return split < 0
						? [field, true]
						: [field.slice(0, split), field.slice(split + 1)];
				}),
			);
		}
		if (section === "reports" && line.includes(":")) {
			const split = line.indexOf(":");
			reports[line.slice(0, split)] = line.slice(split + 1).trim();
		}
	}
	return { ecosystem, local, reports };
}

/** Agent-instruction files a target repository uses to declare its own rules. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];

/** MCP capability keys are spelled differently in prose; local tools match by name. */
const PROSE_NAMES = {
	codescene: "code ?scene",
	sonarqube: "sonar(?:qube|cloud)?",
};

const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find tools a project's agent instructions explicitly declare unused, e.g.
 * "SonarQube is not used" or "opengrep: not used". Returns `{ tool: "file:line" }`
 * for the first declaring line per tool — evidence the orchestrator confirms,
 * not a verdict.
 */
export function findDeclaredUnused(files, toolNames) {
	const declared = {};
	for (const tool of toolNames) {
		const name = PROSE_NAMES[tool] ?? escapeName(tool);
		const pattern = new RegExp(
			`\\b${name}\\b(?:[^.;\\n]{0,40}?\\b(?:is|are|was)\\s+(?:not|no longer|never)\\s+(?:used|in use)\\b|\\s*[:—–-]\\s*(?:not used|unused|disabled)\\b)`,
			"i",
		);
		for (const file of files) {
			if (declared[tool] || typeof file.text !== "string") continue;
			const index = file.text
				.split(/\r?\n/)
				.findIndex((line) => pattern.test(line));
			if (index >= 0) declared[tool] = `${file.path}:${index + 1}`;
		}
	}
	return declared;
}

/** Read the instruction files under root; a read failure is reported, never dropped. */
export function readInstructionFiles(root) {
	return INSTRUCTION_FILES.filter((path) => existsSync(join(root, path))).map(
		(path) => {
			try {
				return { path, text: readFileSync(join(root, path), "utf8") };
			} catch (error) {
				return { path, error: error.code ?? error.message };
			}
		},
	);
}

/** Merge local detection with the OpenCode runtime snapshot. */
export function buildPreflight({
	probeOutput,
	runtimeJson,
	instructionFiles = [],
}) {
	let runtime = {};
	try {
		runtime = JSON.parse(runtimeJson || "{}");
	} catch {
		runtime = {};
	}
	if (typeof runtime !== "object" || runtime === null || Array.isArray(runtime))
		runtime = {};
	const parsed = probeOutput
		? parseToolProbe(probeOutput)
		: { ecosystem: "unknown", local: {}, reports: {} };
	return {
		version: 1,
		localStatus: probeOutput ? "available" : "unknown",
		ecosystem: parsed.ecosystem,
		local: parsed.local,
		reports: parsed.reports,
		mcp: {
			codescene: runtime.mcp?.codescene ?? "unknown",
			sonarqube: runtime.mcp?.sonarqube ?? "unknown",
			contextMode: runtime.mcp?.contextMode ?? "unknown",
		},
		processes: {
			nodeHook: runtime.processes?.nodeHook ?? "unknown",
			sonarHook: runtime.processes?.sonarHook ?? "unknown",
		},
		declaredUnused: findDeclaredUnused(instructionFiles, [
			...Object.keys(parsed.local),
			"codescene",
			"sonarqube",
		]),
		instructionErrors: instructionFiles
			.filter((file) => file.error)
			.map(({ path, error }) => ({ path, error })),
	};
}

if (isMain(import.meta.url)) {
	let probeOutput = "";
	try {
		probeOutput = execFileSync(
			"node",
			[
				TOOL_PROBE,
				...(process.argv.slice(2).length ? process.argv.slice(2) : ["."]),
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		probeOutput = "";
	}
	const preflight = buildPreflight({
		probeOutput,
		runtimeJson: process.env.RPIV_CAPABILITIES,
		instructionFiles: readInstructionFiles(process.argv[2] ?? "."),
	});
	process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
}
