// Runs the actual plugin callbacks under OpenCode's embedded Bun.
// Modes: validation (no-op), artifact (real invalid fixture), jev (fast path).
// No model request. Temporary artifact fixtures are removed when the probe exits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../../opencode/plugin.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mode = process.argv[2] ?? "validation";
let directory = root;
let touchedPath = fileURLToPath(new URL("../../package.json", import.meta.url));
if (mode === "artifact") {
	directory = mkdtempSync(join(tmpdir(), "rpiv-hook-artifact-"));
	process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
	const artifacts = join(directory, ".rpiv", "artifacts", "research");
	mkdirSync(artifacts, { recursive: true });
	touchedPath = join(artifacts, "invalid-fixture.md");
	writeFileSync(touchedPath, "# Deliberately missing required frontmatter\n");
}
if (mode === "jev") {
	assert.notEqual(
		process.env.RPIV_JEV_GATE,
		"off",
		"Jev hook must be enabled for this probe",
	);
	const config = JSON.parse(
		readFileSync(new URL("../../.jev-gate.json", import.meta.url), "utf8"),
	);
	assert.notEqual(
		config.hook?.enabled,
		false,
		"Jev hook must be enabled in configuration",
	);
}
const hooks = await plugin({
	client: { app: { log: async () => ({}) } },
	project: {},
	directory,
	worktree: directory,
	$: {},
	serverUrl: new URL("http://localhost"),
	experimental_workspace: { register() {} },
});
const output = { title: "probe", output: "probe completed", metadata: {} };
const gateLog = new URL("../../reports/jev-gate-shadow.log", import.meta.url);
function logText() {
	try {
		return readFileSync(gateLog, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}
const before = mode === "jev" ? logText().length : 0;
const idleMs = Number(process.argv[3] ?? 0);
if (idleMs > 0) {
	const node =
		process.env.RPIV_NODE_EXECUTABLE ?? "C:/Program Files/nodejs/node.exe";
	const warmup = spawnSync(node, ["-e", "process.stdout.write('ready')"], {
		encoding: "utf8",
		timeout: 1000,
	});
	assert.equal(
		warmup.status,
		0,
		"warmup must succeed before testing idle behavior",
	);
	await new Promise((resolve) => setTimeout(resolve, idleMs));
}
const start = performance.now();
if (mode === "validation" || mode === "artifact") {
	await hooks["tool.execute.after"](
		{
			tool: "edit",
			sessionID: "timeout-probe",
			callID: "probe",
			args: {
				filePath: touchedPath,
			},
		},
		output,
	);
} else if (mode === "jev") {
	await hooks["tool.execute.before"](
		{ tool: "bash", sessionID: "timeout-probe", callID: "probe" },
		{ args: { command: "git status --short" } },
	);
} else {
	throw new Error("expected validation, artifact, or jev");
}
const elapsedMs = Math.round(performance.now() - start);
const observed = mode === "jev" ? logText().slice(before) : output.output;
const timedOut = /ETIMEDOUT|timed out/.test(observed);
const failed = /failed|unavailable|skipped|"phase":"broken"/i.test(observed);
const validatorWarning = observed.includes("Artifact validation warnings");
console.log(
	JSON.stringify({
		mode,
		runtime: process.versions.bun
			? `bun-${process.versions.bun}`
			: `node-${process.versions.node}`,
		idleMs,
		elapsedMs,
		timedOut,
		failed,
		validatorWarning,
	}),
);
assert.equal(timedOut, false, "actual plugin callback reports a child timeout");
assert.equal(failed, false, "actual plugin callback reports a hook failure");
if (mode === "artifact")
	assert.equal(
		validatorWarning,
		true,
		"actual artifact validator must run and report the invalid fixture",
	);
assert.ok(
	elapsedMs < 5000,
	"no-network no-op hooks must settle within five seconds",
);
