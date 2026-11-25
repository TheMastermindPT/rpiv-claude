import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runProcess: vi.fn(),
	appendFileSync: vi.fn(),
}));
vi.mock("../opencode/hook-process.mjs", async (original) => ({
	...(await original()),
	runProcess: mocks.runProcess,
}));
vi.mock("node:fs", async (original) => {
	const actual = await original();
	return {
		...actual,
		appendFileSync: mocks.appendFileSync,
		existsSync: (path) =>
			String(path)
				.replaceAll("\\", "/")
				.endsWith("impeccable/scripts/hook.mjs") || actual.existsSync(path),
	};
});
import plugin from "../opencode/plugin.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const clean = { stdout: "", stderr: "", status: 0, error: "" };
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("RPIV_JEV_GATE", "on");
	mocks.runProcess.mockResolvedValue(clean);
});
afterEach(() => vi.unstubAllEnvs());

async function hooks() {
	return plugin({
		client: {},
		project: {},
		directory: root,
		worktree: root,
		$: {},
		serverUrl: new URL("http://localhost"),
		experimental_workspace: { register() {} },
	});
}

it.each([
	{
		script: "validate-on-write.mjs",
		stdout: "partial validation output",
		context: "partial validation output",
		failure: "validate-on-write.mjs failed: ETIMEDOUT",
	},
	{
		script: "impeccable/scripts/hook.mjs",
		stdout: JSON.stringify({ additionalContext: "partial guidance" }),
		context: "partial guidance",
		failure: "Impeccable failed: ETIMEDOUT",
	},
])(
	"$script preserves partial output and surfaces its timeout",
	async ({ script, stdout, context, failure }) => {
		mocks.runProcess.mockImplementation(async (_command, args) =>
			args[0].replaceAll("\\", "/").endsWith(script)
				? {
						...clean,
						stdout,
						status: null,
						error: "ETIMEDOUT",
					}
				: clean,
		);
		const callbacks = await hooks();
		const output = { output: "edit completed" };
		await callbacks["tool.execute.after"](
			{
				tool: "edit",
				args: { filePath: `${root}/package.json` },
				sessionID: "fixture",
				callID: "fixture",
			},
			output,
		);
		expect(output.output).toContain(context);
		expect(output.output).toContain(failure);
	},
);

it("shows a node hook's additionalContext as plain text, not JSON", async () => {
	const warning =
		"[rpiv-hook] Artifact validation warnings for a.md:\nbad frontmatter";
	mocks.runProcess.mockImplementation(async (_command, args) =>
		args[0].replaceAll("\\", "/").endsWith("validate-on-write.mjs")
			? {
					...clean,
					stdout: JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "PostToolUse",
							additionalContext: warning,
						},
					}),
					stderr: "also on stderr\n",
				}
			: clean,
	);
	const callbacks = await hooks();
	const output = { output: "edit completed" };
	await callbacks["tool.execute.after"](
		{
			tool: "edit",
			args: { filePath: `${root}/package.json` },
			sessionID: "fixture",
			callID: "fixture",
		},
		output,
	);
	expect(output.output).toContain(warning);
	expect(output.output).toContain("also on stderr");
	expect(output.output).not.toContain("hookSpecificOutput");
});

it("surfaces task-lint and citation-check process failures even with empty pipes", async () => {
	mocks.runProcess.mockResolvedValue({
		...clean,
		status: null,
		error: "ETIMEDOUT",
	});
	const callbacks = await hooks();
	const output = { output: "FINDING Q1 | Verified | fixture" };
	await callbacks["tool.execute.after"](
		{
			tool: "task",
			args: { subagent_type: "rpiv:claim-verifier" },
			sessionID: "fixture",
			callID: "fixture",
		},
		output,
	);
	expect(output.output).toContain("jev-row-lint.mjs failed: ETIMEDOUT");
	expect(output.output).toContain("agent-cite-check.mjs failed: ETIMEDOUT");
});

it("awaits the shell gate and records a failed process as broken", async () => {
	mocks.runProcess.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { ...clean, status: null, error: "ETIMEDOUT" };
	});
	const callbacks = await hooks();
	await callbacks["tool.execute.before"](
		{ tool: "bash", sessionID: "fixture", callID: "fixture" },
		{ args: { command: "git status --short" } },
	);
	expect(mocks.appendFileSync).toHaveBeenCalledTimes(1);
	expect(JSON.parse(mocks.appendFileSync.mock.calls[0][1])).toMatchObject({
		phase: "broken",
		verdict: "broken",
	});
});

it("awaits continuation context before completing its hook", async () => {
	mocks.runProcess.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { ...clean, stdout: "fixture context" };
	});
	const callbacks = await hooks();
	const output = { context: [] };
	await callbacks["experimental.session.compacting"]({}, output);
	expect(output.context).toEqual([
		"[rpiv] Continuation context\nfixture context",
	]);
});
