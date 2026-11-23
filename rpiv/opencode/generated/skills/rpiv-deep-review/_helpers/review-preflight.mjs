import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "../../_shared/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_PROBE = join(HERE, "..", "..", "_shared", "tool-probe.mjs");

/** `key=value` fields as an object; a field without `=` is `true`. */
const fieldsOf = (fields) =>
	Object.fromEntries(
		fields.map((field) => {
			const split = field.indexOf("=");
			return split < 0
				? [field, true]
				: [field.slice(0, split), field.slice(split + 1)];
		}),
	);

/** The text after `<key>:` on a head line, or undefined for another line. */
const headValue = (line, key) =>
	line.startsWith(`${key}:`) ? line.slice(key.length + 1).trim() : undefined;

/** A head line: the first root and its ecosystem, or a further root (`also_root:`). */
const readHead = (state, line) => {
	const root = headValue(line, "root");
	if (root !== undefined) state.firstRoot = root;
	const ecosystem = headValue(line, "ecosystem");
	if (ecosystem !== undefined) state.ecosystem = ecosystem;
	const also = headValue(line, "also_root");
	if (also !== undefined) {
		const [path, ...fields] = also.split("\t");
		state.rootOf(path).ecosystem = fieldsOf(fields).ecosystem ?? "unknown";
	}
};

/** A tool row: kept under its root, and in `local` when it is the first of its name. */
const readTool = (state, line) => {
	const [name, ...fields] = line.split("\t");
	const row = fieldsOf(fields);
	state.local[name] ??= row;
	state.rootOf(row.root ?? state.firstRoot).local[name] = row;
};

/** Parse the stable text contract emitted by tool-probe.mjs. `local` holds the first row
    of each tool name (the first root's, as a single root reads); `roots` holds every
    root's ecosystem and rows, keyed by its path (D34 of the Python-support design). */
export function parseToolProbe(output) {
	const roots = {};
	const state = {
		section: "head",
		ecosystem: "unknown",
		firstRoot: "",
		local: {},
		reports: {},
		rootOf: (path) => {
			roots[path] ??= { ecosystem: "unknown", local: {} };
			return roots[path];
		},
	};
	for (const line of output.split("\n")) {
		if (line === "---tool-coverage---") state.section = "tools";
		else if (line === "---report-status---") state.section = "reports";
		else if (state.section === "head") readHead(state, line);
		else if (state.section === "tools" && line.includes("\t"))
			readTool(state, line);
		else if (state.section === "reports" && line.includes(":")) {
			const split = line.indexOf(":");
			state.reports[line.slice(0, split)] = line.slice(split + 1).trim();
		}
	}
	if (state.firstRoot)
		state.rootOf(state.firstRoot).ecosystem = state.ecosystem;
	return {
		ecosystem: state.ecosystem,
		local: state.local,
		reports: state.reports,
		roots,
	};
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
		: { ecosystem: "unknown", local: {}, reports: {}, roots: {} };
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
