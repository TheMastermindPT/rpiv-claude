import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import RpivOpenCodePlugin, * as pluginModule from "../opencode/plugin.ts";
import {
	createHookFailureReporter,
	enforceSonarResult,
	isChildSession,
	sanitizeEnvironment,
} from "../opencode/plugin-support.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("RPIV OpenCode plugin", () => {
	it("exports exactly one OpenCode plugin factory", () => {
		const factories = Object.entries(pluginModule)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name);

		expect(factories).toEqual(["default"]);
	});

	it("blocks explicit Sonar denials", () => {
		expect(() =>
			enforceSonarResult({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						permissionDecision: "deny",
						permissionDecisionReason: "blocked",
					},
				}),
				stderr: "",
				status: 0,
				error: "",
			}),
		).toThrow("blocked");
	});

	it("fails open when the Sonar process itself fails", () => {
		const failures = [];

		expect(() =>
			enforceSonarResult(
				{ stdout: "", stderr: "", status: 1, error: "" },
				(message) => failures.push(message),
			),
		).not.toThrow();
		expect(failures).toEqual([
			"[rpiv-hook] Sonar Secrets hook failed open: exit 1",
		]);
	});

	it("does not write Sonar operational failures to the TUI terminal", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			expect(() =>
				enforceSonarResult({
					stdout: "",
					stderr: "",
					status: null,
					error: "spawnSync sonar ETIMEDOUT",
				}),
			).not.toThrow();
			expect(warning).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
		}
	});

	it("routes Sonar operational failures through OpenCode logging", () => {
		const log = vi.fn().mockResolvedValue({ data: true });
		const reportFailure = createHookFailureReporter({ app: { log } });

		enforceSonarResult(
			{
				stdout: "",
				stderr: "",
				status: null,
				error: "spawnSync sonar ETIMEDOUT",
			},
			reportFailure,
		);

		expect(log).toHaveBeenCalledWith({
			body: {
				service: "rpiv-hook",
				level: "warn",
				message:
					"[rpiv-hook] Sonar Secrets hook failed open: spawnSync sonar ETIMEDOUT",
			},
		});
	});

	it("distinguishes task sessions from the primary session", async () => {
		const client = {
			session: {
				get: async ({ path }) => ({
					data: path.id === "child" ? { parentID: "primary" } : {},
				}),
			},
		};

		await expect(isChildSession(client, "child", "C:/project")).resolves.toBe(
			true,
		);
		await expect(isChildSession(client, "primary", "C:/project")).resolves.toBe(
			false,
		);
	});

	it("keeps prompt scanning enabled when session lookup fails", async () => {
		const client = {
			session: {
				get: async () => {
					throw new Error("unavailable");
				},
			},
		};

		await expect(isChildSession(client, "unknown", "C:/project")).resolves.toBe(
			false,
		);
	});

	it("does not submit child task prompts to the prompt hook", async () => {
		const hooks = await RpivOpenCodePlugin({
			client: {
				session: {
					get: async () => ({ data: { parentID: "primary" } }),
				},
			},
			project: {},
			directory: "C:/project",
			worktree: "C:/project",
			$: {},
			serverUrl: new URL("http://localhost"),
			experimental_workspace: { register() {} },
		});

		await expect(
			hooks["chat.message"]({ sessionID: "child" }, { parts: null }),
		).resolves.toBeUndefined();
	});

	it("removes secrets before launching local hook processes", () => {
		expect(
			sanitizeEnvironment({
				PATH: "C:/trusted",
				TEMP: "C:/temp",
				CS_ACCESS_TOKEN: "secret",
				SONARQUBE_TOKEN: "secret",
				DATABASE_URL: "secret",
				GITHUB_PAT: "secret",
				SENTRY_DSN: "secret",
				UNRELATED_VALUE: "drop",
			}),
		).toEqual({ PATH: "C:/trusted", TEMP: "C:/temp" });
	});

	it("registers RPIV config and shell environment", async () => {
		const hooks = await RpivOpenCodePlugin({
			client: {},
			project: {},
			directory: "C:/project",
			worktree: "C:/project",
			$: {},
			serverUrl: new URL("http://localhost"),
			experimental_workspace: { register() {} },
		});
		const config = { agent: { existing: { description: "keep" } } };
		await hooks.config(config);

		expect(config.agent.existing).toEqual({ description: "keep" });
		expect(config.agent["rpiv:web-search-researcher"].model).toBe(
			"openai/gpt-5.6-terra",
		);
		expect(config.command["rpiv:implement"]).toBeDefined();

		const output = { env: {} };
		await hooks["shell.env"]({ cwd: "C:/project" }, output);
		expect(output.env).toMatchObject({
			RPIV_PLUGIN_ROOT: ROOT.replace(/[\\/]$/, ""),
			RPIV_PROJECT_DIR: "C:/project",
		});
		expect(config.skills.paths).toContain(
			join(ROOT, "opencode", "generated", "skills"),
		);
	});

	it("publishes one normalized capability snapshot through the shell environment", async () => {
		const hooks = await RpivOpenCodePlugin({
			client: {},
			project: {},
			directory: "C:/project",
			worktree: "C:/project",
			$: {},
			serverUrl: new URL("http://localhost"),
			experimental_workspace: { register() {} },
		});
		const config = {
			mcp: {
				codescene: { enabled: true },
				sonarqube: { enabled: false },
				"context-mode": { enabled: true },
			},
		};
		await hooks.config(config);
		const first = { env: {} };
		const second = { env: {} };
		await hooks["shell.env"]({ cwd: "C:/project" }, first);
		await hooks["shell.env"]({ cwd: "C:/project" }, second);

		expect(first.env.RPIV_CAPABILITIES).toBe(second.env.RPIV_CAPABILITIES);
		expect(JSON.parse(first.env.RPIV_CAPABILITIES)).toMatchObject({
			mcp: {
				codescene: "configured",
				sonarqube: "disabled",
				contextMode: "configured",
			},
			processes: {
				nodeHook: expect.stringMatching(/available|unavailable/),
				sonarHook: expect.stringMatching(/available|unavailable/),
			},
		});
	});
});
