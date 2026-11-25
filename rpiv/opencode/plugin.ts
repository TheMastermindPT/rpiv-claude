import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode-ai/plugin";
import { formatHookResult, runProcess } from "./hook-process.mjs";

import {
	applyRpivConfig,
	buildClaudeToolEvent,
	collectTouchedFiles,
	createCapabilitySnapshot,
	createHookFailureReporter,
	enforceSonarResult,
	extractAdditionalContext,
	hookOutputText,
	isChildSession,
	sanitizeEnvironment,
} from "./plugin-support.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const VALIDATE_HOOK = join(ROOT, ".claude", "hooks", "validate-on-write.mjs");
const DUPLICATION_HOOK = join(
	ROOT,
	".claude",
	"hooks",
	"fence-duplication-check.mjs",
);
const SKILL_CONTEXT = join(ROOT, "skills", "_shared", "skill-context.mjs");
const JEV_GATE = join(ROOT, "scripts", "jev-gate.mjs");
const JEV_SHADOW_LOG = join(ROOT, "reports", "jev-gate-shadow.log");
const JEV_VERIFIER_LINT = join(ROOT, "scripts", "jev-row-lint.mjs");
const CITE_CHECK = join(ROOT, "scripts", "agent-cite-check.mjs");
const IMPECCABLE_HOOK = join(
	homedir(),
	".claude",
	"skills",
	"impeccable",
	"scripts",
	"hook.mjs",
);

function firstExisting(paths: Array<string | undefined>) {
	return paths.find((path): path is string =>
		Boolean(path && resolve(path) === path && existsSync(path)),
	);
}

const NODE_EXECUTABLE = firstExisting(
	process.platform === "win32"
		? [
				process.env.RPIV_NODE_EXECUTABLE,
				process.env.ProgramFiles &&
					join(process.env.ProgramFiles, "nodejs", "node.exe"),
				process.execPath.toLowerCase().endsWith("node.exe")
					? process.execPath
					: undefined,
			]
		: [
				process.env.RPIV_NODE_EXECUTABLE,
				process.execPath.endsWith("/node") ? process.execPath : undefined,
				"/usr/bin/node",
				"/usr/local/bin/node",
			],
);
const SONAR_EXECUTABLE = firstExisting(
	process.platform === "win32"
		? [
				process.env.RPIV_SONAR_EXECUTABLE,
				process.env.LOCALAPPDATA &&
					join(process.env.LOCALAPPDATA, "sonarqube-cli", "bin", "sonar.exe"),
			]
		: [
				process.env.RPIV_SONAR_EXECUTABLE,
				process.env.HOME && join(process.env.HOME, ".local", "bin", "sonar"),
				"/usr/local/bin/sonar",
				"/usr/bin/sonar",
			],
);

function hookEnvironment(directory: string) {
	const environment = sanitizeEnvironment(process.env);
	for (const key of Object.keys(environment)) {
		if (key.toLowerCase() === "path") delete environment[key];
	}
	const trustedPath = [
		NODE_EXECUTABLE && dirname(NODE_EXECUTABLE),
		SONAR_EXECUTABLE && dirname(SONAR_EXECUTABLE),
		process.env.SystemRoot && join(process.env.SystemRoot, "System32"),
		process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "cmd"),
	].filter(Boolean);
	return {
		...environment,
		PATH: trustedPath.join(process.platform === "win32" ? ";" : ":"),
		CLAUDE_PROJECT_DIR: directory,
		RPIV_PLUGIN_ROOT: ROOT,
		RPIV_PROJECT_DIR: directory,
	};
}

async function runNodeHook(
	script: string,
	event: Record<string, unknown>,
	directory: string,
	timeout: number,
) {
	if (!existsSync(script)) return "";
	if (!NODE_EXECUTABLE)
		return `[rpiv-hook] Node executable unavailable; skipped ${script}.`;
	const result = await runProcess(NODE_EXECUTABLE, [script], {
		cwd: directory,
		input: JSON.stringify(event),
		timeout,
		env: hookEnvironment(directory),
	});
	return formatHookResult(script, {
		...result,
		stdout: hookOutputText(result.stdout),
	});
}

function readJevHookConfig(path: string) {
	try {
		const hook = JSON.parse(readFileSync(path, "utf8"))?.hook;
		if (hook == null) return { enabled: true };
		return { enabled: hook.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

function extractBashCommand(output: { args: unknown }) {
	const args = output.args;
	if (typeof args === "string") return args;
	const command = (args as { command?: unknown })?.command;
	return typeof command === "string" ? command : undefined;
}

function appendJevBrokenLog(
	command: string,
	directory: string,
	reason: string,
) {
	try {
		appendFileSync(
			JEV_SHADOW_LOG,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				command,
				cwd: directory,
				mode: "shadow",
				phase: "broken",
				verdict: "broken",
				reasons: [`gate script failed: ${reason}`],
			})}\n`,
			"utf8",
		);
	} catch {
		// shadow log unavailable — nothing further to do
	}
}

async function runJevGate(command: string, directory: string) {
	if (!NODE_EXECUTABLE) {
		appendJevBrokenLog(command, directory, "Node executable unavailable");
		return;
	}
	const result = await runProcess(
		NODE_EXECUTABLE,
		[JEV_GATE, command, "--json"],
		{
			cwd: directory,
			env: hookEnvironment(directory),
			timeout: 10_000,
		},
	);
	// exit 0: judged. exit 2: gate already logged its own broken entry.
	if (result.status === 0 || result.status === 2) return;
	appendJevBrokenLog(
		command,
		directory,
		result.error || result.stderr || `exit ${result.status}`,
	);
}

async function runSonarHook(
	mode: "claude-pre-tool-use" | "claude-prompt-submit",
	event: Record<string, unknown>,
	cwd: string,
	reportFailure: (message: string) => void,
) {
	if (!SONAR_EXECUTABLE) return;
	const result = await runProcess(SONAR_EXECUTABLE, ["hook", mode], {
		cwd,
		input: JSON.stringify(event),
		env: hookEnvironment(cwd),
		timeout: 10_000,
	});
	enforceSonarResult(result, reportFailure);
}

function appendToolContext(output: { output: string }, context: string) {
	if (!context) return;
	output.output = `${output.output}\n\n${context}`.trim();
}

type AfterHook = NonNullable<Awaited<ReturnType<Plugin>>["tool.execute.after"]>;
interface AfterContext {
	input: Parameters<AfterHook>[0];
	output: Parameters<AfterHook>[1];
	directory: string;
}

async function runFileHooks(
	{ input, output, directory }: AfterContext,
	files: string[],
) {
	for (const filePath of files) {
		const event = buildClaudeToolEvent({
			tool: "edit",
			args: { filePath },
			directory,
			sessionID: input.sessionID,
		});
		appendToolContext(
			output,
			await runNodeHook(VALIDATE_HOOK, event, directory, 15_000),
		);
		appendToolContext(
			output,
			await runNodeHook(DUPLICATION_HOOK, event, directory, 30_000),
		);
	}
}

function impeccableContext(result: Awaited<ReturnType<typeof runProcess>>) {
	const context = extractAdditionalContext(result.stdout);
	if (result.status !== 0)
		return [
			context,
			`[rpiv-hook] Impeccable failed: ${result.error || result.stderr || `exit ${result.status}`}`,
		]
			.filter(Boolean)
			.join("\n");
	if (result.stdout.trim() && !context)
		return "[rpiv-hook] Impeccable returned malformed output; no guidance was applied.";
	return context;
}

async function runImpeccableHook({ input, output, directory }: AfterContext) {
	if (!existsSync(IMPECCABLE_HOOK)) return;
	if (!NODE_EXECUTABLE) {
		appendToolContext(
			output,
			"[rpiv-hook] Node executable unavailable; skipped Impeccable.",
		);
		return;
	}
	const event = buildClaudeToolEvent({
		tool: input.tool,
		args: input.args,
		directory,
		sessionID: input.sessionID,
	});
	const result = await runProcess(NODE_EXECUTABLE, [IMPECCABLE_HOOK], {
		cwd: directory,
		input: JSON.stringify(event),
		env: hookEnvironment(directory),
		timeout: 30_000,
	});
	appendToolContext(output, impeccableContext(result));
}

function rpivTask(input: AfterContext["input"]) {
	if (input.tool !== "task") return null;
	const args = (input.args ?? {}) as {
		subagent_type?: unknown;
		prompt?: unknown;
	};
	if (typeof args.subagent_type !== "string") return null;
	if (!args.subagent_type.startsWith("rpiv:")) return null;
	return {
		agentType: args.subagent_type,
		prompt: typeof args.prompt === "string" ? args.prompt : null,
	};
}

async function runTaskHooks({ input, output, directory }: AfterContext) {
	const task = rpivTask(input);
	if (!task) return;
	const agentText = typeof output.output === "string" ? output.output : "";
	if (!NODE_EXECUTABLE || !agentText.trim()) return;
	const event = { agent_type: task.agentType, result: agentText };
	const lintResult = await runProcess(NODE_EXECUTABLE, [JEV_VERIFIER_LINT], {
		cwd: directory,
		input: JSON.stringify({
			...event,
			prompt: task.prompt || null,
		}),
		env: hookEnvironment(directory),
		timeout: 45_000,
	});
	const citeResult = await runProcess(
		NODE_EXECUTABLE,
		[CITE_CHECK, "--root", directory],
		{
			cwd: directory,
			input: JSON.stringify(event),
			env: hookEnvironment(directory),
			timeout: 15_000,
		},
	);
	appendToolContext(
		output,
		[
			formatHookResult(JEV_VERIFIER_LINT, lintResult),
			formatHookResult(CITE_CHECK, citeResult),
		]
			.filter(Boolean)
			.join("\n")
			.trim(),
	);
}

/** Register RPIV agents, commands, skills, and supported lifecycle adapters. */
const RpivOpenCodePlugin: Plugin = async ({ client, directory }) => {
	let capabilities = createCapabilitySnapshot(
		{},
		{
			nodeHook: NODE_EXECUTABLE ? "available" : "unavailable",
			sonarHook: SONAR_EXECUTABLE ? "available" : "unavailable",
		},
	);
	const jevHookEnabled =
		process.env.RPIV_JEV_GATE !== "off" &&
		readJevHookConfig(join(ROOT, ".jev-gate.json")).enabled;
	return {
		config: async (config) => {
			applyRpivConfig(config as Record<string, unknown>, ROOT);
			capabilities = createCapabilitySnapshot(config, capabilities.processes);
		},

		"shell.env": async (input, output) => {
			output.env.RPIV_PLUGIN_ROOT = ROOT;
			output.env.RPIV_PROJECT_DIR = input.cwd || directory;
			output.env.RPIV_CAPABILITIES = JSON.stringify(capabilities);
		},

		"tool.execute.before": async (input, output) => {
			if (input.tool === "read") {
				await runSonarHook(
					"claude-pre-tool-use",
					buildClaudeToolEvent({
						tool: input.tool,
						args: output.args,
						directory,
						sessionID: input.sessionID,
						eventName: "PreToolUse",
					}),
					directory,
					createHookFailureReporter(client),
				);
				return;
			}
			if (input.tool !== "bash" || !jevHookEnabled) return;
			const command = extractBashCommand(output);
			if (typeof command === "string" && command.trim()) {
				await runJevGate(command, directory);
			}
		},

		"tool.execute.after": async (input, output) => {
			const touchedFiles = collectTouchedFiles(
				input.tool,
				input.args,
				directory,
			);
			const context = { input, output, directory };
			if (touchedFiles.length > 0) {
				await runFileHooks(context, touchedFiles);
				await runImpeccableHook(context);
			}
			await runTaskHooks(context);
		},

		"chat.message": async (input, output) => {
			if (await isChildSession(client, input.sessionID, directory)) return;
			const prompt = output.parts
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (!prompt) return;
			await runSonarHook(
				"claude-prompt-submit",
				{
					hook_event_name: "UserPromptSubmit",
					prompt,
					cwd: directory,
					session_id: input.sessionID,
				},
				directory,
				createHookFailureReporter(client),
			);
		},

		"experimental.session.compacting": async (_input, output) => {
			if (!NODE_EXECUTABLE) {
				output.context.push(
					"[rpiv] Continuation context unavailable: Node executable not found.",
				);
				return;
			}
			const result = await runProcess(
				NODE_EXECUTABLE,
				[SKILL_CONTEXT, "now", "git"],
				{
					cwd: directory,
					env: hookEnvironment(directory),
					timeout: 10_000,
				},
			);
			if (result.status === 0 && result.stdout.trim()) {
				output.context.push(
					`[rpiv] Continuation context\n${result.stdout.trim()}`,
				);
			} else {
				output.context.push(
					`[rpiv] Continuation context unavailable: ${result.error || result.stderr || `exit ${result.status}`}`,
				);
			}
		},
	};
};

export default RpivOpenCodePlugin;
