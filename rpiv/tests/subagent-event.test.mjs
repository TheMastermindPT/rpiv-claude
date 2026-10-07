// tests/subagent-event.test.mjs — contract tests for how the SubagentStop checks read their
// event (slice S28-subagent-event, D28, B105–B108, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// Claude Code sends the agent's text as `last_assistant_message` and a plugin agent's type
// with its prefix (`rpiv:claim-verifier`); OpenCode sends `result`. No network: row-lint runs
// with a data: module that replaces globalThis.fetch and reports each call on stderr.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROW_LINT = join(ROOT, "scripts/jev-row-lint.mjs");
const CITE_CHECK = join(ROOT, "scripts/agent-cite-check.mjs");
const OUTPUT_CHECK = join(ROOT, ".claude/hooks/subagent-output-check.mjs");
const ROWS = "FINDING Q1 | Verified | the code matches at src/a.mjs:12";
const CITES =
	"FINDING Q1 | Verified | a.mjs:12\nFINDING Q2 | Verified | b.mjs:3";
const NO_OUTPUT =
	"no agent output in the event (result or last_assistant_message)";
const FETCH_STUB = `globalThis.fetch = async (_url, opts) => { process.stderr.write("FETCH " + JSON.parse(opts.body).state.row + "\\n"); return { ok: true, json: async () => ({ answers: { consistent: { noul: 0.9 } } }) }; };`;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Spawns one hook with `event` on stdin in a fresh temp cwd holding a claim-verifier agent. */
const run = (args, event) => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-subagent-event-"));
	dirs.push(cwd);
	mkdirSync(join(cwd, "agents"));
	writeFileSync(
		join(cwd, "agents", "claim-verifier.md"),
		"---\neffort: high\n---\n",
	);
	const r = spawnSync(process.execPath, args(cwd), {
		cwd,
		input: JSON.stringify(event),
		encoding: "utf-8",
		env: {
			...process.env,
			TYPESAFE_API_KEY: "t",
			RPIV_AGENTS_DIR: join(cwd, "agents"),
		},
	});
	const logPath = join(cwd, "reports", "jev-lint-shadow.log");
	const log = existsSync(logPath)
		? readFileSync(logPath, "utf-8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
		: [];
	const fetches = (r.stderr.match(/^FETCH .*$/gm) ?? []).map((l) => l.slice(6));
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, log, fetches };
};

const rowLint = () => [
	"--import",
	`data:text/javascript,${encodeURIComponent(FETCH_STUB)}`,
	ROW_LINT,
];
const citeCheck = (cwd) => [CITE_CHECK, "--root", cwd];
const outputCheck = () => [OUTPUT_CHECK];

describe("S28 row-lint reads Claude Code's event (B105, B106)", () => {
	it("row-lint reads last_assistant_message", () => {
		for (const event of [
			{ agent_type: "rpiv:claim-verifier", last_assistant_message: ROWS },
			{ agent_type: "rpiv:claim-verifier", result: ROWS },
		]) {
			const r = run(rowLint, event);
			expect(r.status, r.stderr).toBe(0);
			expect(r.fetches).toHaveLength(1);
			expect(r.log).toHaveLength(1);
			expect(r.log[0]).toMatchObject({
				agent: "claim-verifier",
				id: "Q1",
				verdict: "ok",
			});
		}

		const both = run(rowLint, {
			agent_type: "rpiv:claim-verifier",
			result: ROWS,
			last_assistant_message: "FINDING Q9 | Verified | other at src/b.mjs:1",
		});
		expect(both.log.map((l) => l.id)).toEqual(["Q1"]);
	});

	it("row-lint reports an event without agent output", () => {
		for (const event of [
			{ agent_type: "rpiv:claim-verifier" },
			{
				agent_type: "rpiv:claim-verifier",
				result: "",
				last_assistant_message: "  ",
			},
		]) {
			const r = run(rowLint, event);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe(
				`[jev-lint] UNAVAILABLE: ${NO_OUTPUT} — rows not linted\n`,
			);
			expect(r.fetches).toHaveLength(0);
		}
		expect(run(rowLint, { agent_type: "Explore" }).stdout).toBe("");
	});
});

describe("S28 cite-check reads Claude Code's event (B107)", () => {
	it("cite-check reads last_assistant_message and reports a missing output", () => {
		const fromClaude = run(citeCheck, {
			agent_type: "rpiv:claim-verifier",
			last_assistant_message: CITES,
		});
		const fromOpenCode = run(citeCheck, {
			agent_type: "rpiv:claim-verifier",
			result: CITES,
		});
		expect(fromOpenCode.stdout).not.toBe("");
		expect(fromClaude.stdout).toBe(fromOpenCode.stdout);

		expect(run(citeCheck, { agent_type: "rpiv:claim-verifier" }).stdout).toBe(
			`[cite-check] claim-verifier: ${NO_OUTPUT} — citations not checked\n`,
		);
		expect(run(citeCheck, { agent_type: "Explore" }).stdout).toBe("");
	});
});

describe("S28 output-check reads Claude Code's event (B108)", () => {
	it("output-check reads prefixed agents and last_assistant_message", () => {
		const short = run(outputCheck, {
			agent_type: "rpiv:claim-verifier",
			last_assistant_message: "ok",
		});
		expect(short.status).toBe(0);
		expect(short.stderr).toContain(
			'WARNING: agent "rpiv:claim-verifier" (effort: high) returned suspiciously short output (2 chars).',
		);
		expect(short.stderr).toContain(
			"output missing expected format: FINDING rows",
		);

		const none = run(outputCheck, { agent_type: "rpiv:claim-verifier" });
		expect(none.status).toBe(0);
		expect(none.stderr).toBe(
			`[rpiv-hook] WARNING: agent "rpiv:claim-verifier" — ${NO_OUTPUT}; output checks skipped.\n`,
		);

		const unknown = run(outputCheck, {
			agent_type: "rpiv:unknown-agent",
			last_assistant_message: "ok",
		});
		expect(unknown.status).toBe(0);
		expect(unknown.stderr).toBe("");
	});
});

// ---- S28 revision 2: one rpiv: prefix rule for every hook (B109–B112) ----------

const GUARD = join(ROOT, ".claude/hooks/enforce-readonly-agent.mjs");
const AUTO_APPROVE = join(ROOT, ".claude/hooks/auto-approve-readonly.mjs");
const MODEL_CHECK = join(ROOT, ".claude/hooks/validate-agent-model.mjs");

/** Spawns `hook` with `event` and an agents folder holding the revision-2 test agents. */
const runHook = (hook, event) => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-subagent-prefix-"));
	dirs.push(cwd);
	const agents = join(cwd, "agents");
	mkdirSync(agents);
	writeFileSync(join(agents, "ro-agent.md"), "---\ntools: Read, Grep\n---\n");
	writeFileSync(
		join(agents, "precedent-locator.md"),
		"---\ntools: Read, Grep, Glob, Bash\n---\n",
	);
	writeFileSync(join(agents, "no-model-agent.md"), "---\neffort: high\n---\n");
	writeFileSync(join(agents, "claim-verifier.md"), "---\neffort: high\n---\n");
	const r = spawnSync(process.execPath, [hook], {
		cwd,
		input: JSON.stringify(event),
		encoding: "utf-8",
		env: { ...process.env, RPIV_AGENTS_DIR: agents },
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const decisionOf = (stdout) =>
	stdout.trim() ? JSON.parse(stdout.trim()) : null;

describe("S28 revision 2: prefixed agents in every hook (B109–B112)", () => {
	it("the read-only guard reads prefixed agents", () => {
		const write = decisionOf(
			runHook(GUARD, { agent_type: "rpiv:ro-agent", tool_name: "Write" })
				.stdout,
		);
		expect(write?.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(write?.hookSpecificOutput.permissionDecisionReason).toContain(
			'"Write" blocked: agent "rpiv:ro-agent" is read-only',
		);
		const bash = (command) =>
			runHook(GUARD, {
				agent_type: "rpiv:precedent-locator",
				tool_name: "Bash",
				tool_input: { command },
			}).stdout;
		expect(bash("git log --oneline")).toBe("");
		expect(
			decisionOf(bash("git fetch origin"))?.hookSpecificOutput
				.permissionDecision,
		).toBe("deny");
		const bare = decisionOf(
			runHook(GUARD, { agent_type: "ro-agent", tool_name: "Write" }).stdout,
		);
		expect(bare?.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("auto-approve reads prefixed agents", () => {
		const read = decisionOf(
			runHook(AUTO_APPROVE, { agent_type: "rpiv:ro-agent", tool_name: "Read" })
				.stdout,
		);
		expect(read?.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
		expect(read?.hookSpecificOutput.decision.behavior).toBe("allow");
		expect(
			runHook(AUTO_APPROVE, { agent_type: "rpiv:ro-agent", tool_name: "Write" })
				.stdout,
		).toBe("");
		expect(
			runHook(AUTO_APPROVE, {
				agent_type: "rpiv:unknown-agent",
				tool_name: "Read",
			}).stdout,
		).toBe("");
	});

	it("the model check reads prefixed agents", () => {
		const r = runHook(MODEL_CHECK, { agent_type: "rpiv:no-model-agent" });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			`agent "rpiv:no-model-agent" has no 'model' field`,
		);
	});

	it("non-string and unsafe agent types stay silent", () => {
		const hooks = [
			[OUTPUT_CHECK, {}],
			[GUARD, { tool_name: "Write" }],
			[AUTO_APPROVE, { tool_name: "Read" }],
			[MODEL_CHECK, {}],
		];
		for (const [hook, extra] of hooks) {
			for (const agent_type of [5, {}, "rpiv:../ro-agent"]) {
				const r = runHook(hook, { agent_type, ...extra });
				expect({ hook, agent_type, ...r }).toEqual({
					hook,
					agent_type,
					status: 0,
					stdout: "",
					stderr: "",
				});
			}
		}
	});
});
