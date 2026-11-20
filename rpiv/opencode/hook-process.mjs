import { execFile } from "node:child_process";

/** @typedef {{ stdout: string, stderr: string, status: number | null, error: string }} ProcessResult */

/**
 * Run a trusted local hook with bounded execution and captured output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, input?: string, timeout?: number }} options
 * @returns {Promise<ProcessResult>}
 */
export function runProcess(command, args, options) {
	const timeout = options.timeout || 15_000;
	// Bun's Windows spawnSync clock can be stale after idle. Async execution
	// also keeps OpenCode responsive while the child waits on input or network.
	return new Promise((resolve) => {
		let inputError = "";
		const child = execFile(
			command,
			args,
			{
				cwd: options.cwd,
				env: options.env,
				encoding: "utf8",
				timeout,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				shell: false,
			},
			(error, stdout, stderr) => {
				resolve(processResult({ error, stdout, stderr, inputError, timeout }));
			},
		);
		child.stdin?.on("error", (error) => {
			if (options.input)
				inputError = `stdin delivery failed: ${error.code ?? error.name}`;
		});
		child.stdin?.end(options.input ?? "");
	});
}

function processResult({ error, stdout, stderr, inputError, timeout }) {
	return {
		stdout: stdout || "",
		stderr: stderr || "",
		status: error ? exitStatus(error) : inputError ? null : 0,
		error: processError(error, timeout) || inputError,
	};
}

function exitStatus(error) {
	return typeof error.code === "number" && !error.killed ? error.code : null;
}

function processError(error, timeout) {
	if (!error) return "";
	if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
		return "hook output exceeded maxBuffer";
	if (error.killed) return `ETIMEDOUT after ${timeout}ms`;
	// Do not echo argv/stdin: execFile's default message can include their contents.
	return `process failed: ${error.code ?? error.signal ?? error.name}`;
}

/**
 * Preserve child diagnostics without confusing partial output with success.
 * @param {string} script
 * @param {ProcessResult} result
 * @returns {string}
 */
export function formatHookResult(script, result) {
	const failure =
		result.status === 0
			? ""
			: `[rpiv-hook] ${script} failed: ${result.error || `exit ${result.status}`}`;
	return [result.stdout, result.stderr, failure]
		.filter(Boolean)
		.join("\n")
		.trim();
}
