import { isAbsolute, join, resolve } from "node:path";

import { buildOpenCodeDefinitions } from "./adapter.mjs";

const TOOL_NAMES = Object.freeze({
	apply_patch: "apply_patch",
	edit: "Edit",
	read: "Read",
	write: "Write",
});

/**
 * Merge RPIV agents, commands, and generated skills into an OpenCode config.
 *
 * @param {Record<string, any>} config Mutable OpenCode config supplied to a plugin hook.
 * @param {string} root Absolute RPIV repository root.
 * @returns {void}
 */
export function applyRpivConfig(config, root) {
	const definitions = buildOpenCodeDefinitions(root);
	config.agent = { ...(config.agent || {}), ...definitions.agents };
	config.command = { ...(config.command || {}), ...definitions.commands };

	const generatedSkills = join(root, "opencode", "generated", "skills");
	const currentPaths = config.skills?.paths || [];
	config.skills = {
		...(config.skills || {}),
		paths: [...new Set([...currentPaths, generatedSkills])],
	};
}

const mcpStatus = (mcp, aliases) => {
	for (const [name, value] of Object.entries(mcp || {})) {
		const normalized = name.toLowerCase().replaceAll(/[-_]/g, "");
		if (!aliases.includes(normalized)) continue;
		return value?.enabled === false ? "disabled" : "configured";
	}
	return "unknown";
};

/** Build the immutable runtime capability snapshot exported to RPIV helpers. */
export function createCapabilitySnapshot(config, processes) {
	return {
		version: 1,
		mcp: {
			codescene: mcpStatus(config.mcp, ["codescene"]),
			sonarqube: mcpStatus(config.mcp, ["sonarqube", "sonar"]),
			contextMode: mcpStatus(config.mcp, ["contextmode"]),
		},
		processes,
	};
}

function absolutePath(path, directory) {
	return isAbsolute(path) ? path : resolve(directory, path);
}

/**
 * Return every file path represented by an OpenCode edit tool call.
 *
 * @param {string} tool OpenCode tool identifier.
 * @param {Record<string, any>} args Tool arguments.
 * @param {string} directory Active project directory.
 * @returns {string[]} Absolute, deduplicated touched paths.
 */
export function collectTouchedFiles(tool, args, directory) {
	if (!new Set(["apply_patch", "edit", "write"]).has(tool)) return [];
	const paths = [];
	const direct =
		args.filePath || args.file_path || args.path || args.target_file;
	if (typeof direct === "string" && direct)
		paths.push(absolutePath(direct, directory));

	const patch = args.patchText || args.command;
	if (tool === "apply_patch" && typeof patch === "string") {
		for (const match of patch.matchAll(
			/^\*\*\* (?:(?:Add|Update) File|Move to): (.+)$/gm,
		)) {
			paths.push(absolutePath(match[1].trim(), directory));
		}
	}
	return [...new Set(paths)];
}

/**
 * Remove credentials before passing the host environment to local hook processes.
 *
 * @param {NodeJS.ProcessEnv} environment Host process environment.
 * @returns {NodeJS.ProcessEnv} Environment without secret-bearing keys.
 */
export function sanitizeEnvironment(environment) {
	const allowed = new Set([
		"APPDATA",
		"COMSPEC",
		"HOME",
		"HOMEDRIVE",
		"HOMEPATH",
		"LANG",
		"LOCALAPPDATA",
		"NO_COLOR",
		"PATH",
		"PATHEXT",
		"PROGRAMDATA",
		"PROGRAMFILES",
		"PROGRAMFILES(X86)",
		"SYSTEMDRIVE",
		"SYSTEMROOT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"WINDIR",
	]);
	return Object.fromEntries(
		Object.entries(environment).filter(([key]) => {
			const normalized = key.toUpperCase();
			return (
				allowed.has(normalized) ||
				normalized.startsWith("LC_") ||
				normalized.startsWith("IMPECCABLE_")
			);
		}),
	);
}

/**
 * Convert an OpenCode tool call into the envelope consumed by existing hook adapters.
 *
 * @param {{ tool: string, args: Record<string, any>, directory: string, sessionID: string, eventName?: string }} input Call data.
 * @returns {Record<string, unknown>} Claude-compatible hook event.
 */
export function buildClaudeToolEvent({
	tool,
	args,
	directory,
	sessionID,
	eventName = "PostToolUse",
}) {
	const filePath =
		args.filePath || args.file_path || args.path || args.target_file;
	const toolInput = {};
	if (typeof filePath === "string" && filePath) toolInput.file_path = filePath;
	if (
		tool === "apply_patch" &&
		typeof (args.patchText || args.command) === "string"
	) {
		toolInput.command = args.patchText || args.command;
	}

	return {
		hook_event_name: eventName,
		tool_name: TOOL_NAMES[tool] || tool,
		tool_input: toolInput,
		cwd: directory,
		session_id: sessionID,
	};
}

/**
 * Read additional context from the two hook response shapes used by local skills.
 *
 * @param {string} stdout Hook standard output.
 * @returns {string} Additional context, or an empty string for malformed/no-op output.
 */
export function extractAdditionalContext(stdout) {
	try {
		const parsed = JSON.parse(stdout.trim());
		return (
			parsed.additionalContext ||
			parsed.hookSpecificOutput?.additionalContext ||
			""
		);
	} catch {
		return "";
	}
}

/** Extract an explicit denial from the Sonar Claude-hook response envelope. */
function sonarDenial(stdout) {
	try {
		const parsed = JSON.parse(stdout.trim());
		if (parsed.hookSpecificOutput?.permissionDecision === "deny") {
			return (
				parsed.hookSpecificOutput.permissionDecisionReason ||
				"Sonar Secrets blocked this input."
			);
		}
		if (parsed.hookSpecificOutput?.decision?.behavior === "deny") {
			return (
				parsed.hookSpecificOutput.decision.message ||
				"Sonar Secrets blocked this input."
			);
		}
	} catch {
		return "";
	}
	return "";
}

/** Route hook diagnostics through OpenCode without writing into the active TUI. */
export function createHookFailureReporter(client) {
	return (message) => {
		try {
			const request = client.app.log({
				body: {
					service: "rpiv-hook",
					level: "warn",
					message,
				},
			});
			void Promise.resolve(request).catch(() => {});
		} catch {
			// Logging must never turn an operational scanner failure into a hook failure.
		}
	};
}

/** Block explicit Sonar denials while allowing operational scanner failures. */
export function enforceSonarResult(result, reportFailure = (_message) => {}) {
	const denial = sonarDenial(result.stdout);
	if (denial) throw new Error(denial);
	if (result.status === 0) return;
	const detail = (result.error || result.stderr || `exit ${result.status}`)
		.trim()
		.slice(0, 2_000);
	reportFailure(`[rpiv-hook] Sonar Secrets hook failed open: ${detail}`);
}

/**
 * Check whether an OpenCode session was created as a child task session.
 *
 * @param {{ session: { get: (input: { path: { id: string }, query: { directory: string } }) => Promise<{ data?: { parentID?: string } }> } }} client OpenCode client.
 * @param {string} sessionID Session to inspect.
 * @param {string} directory Active project directory.
 * @returns {Promise<boolean>} True only when the session has a parent.
 */
export async function isChildSession(client, sessionID, directory) {
	try {
		const result = await client.session.get({
			path: { id: sessionID },
			query: { directory },
		});
		return Boolean(result.data?.parentID);
	} catch {
		// A failed lookup must not disable scanning for a primary user prompt.
		return false;
	}
}
