// tests/sweeper-constituents.test.mjs — contract tests for how row-lint finds the
// interaction-sweeper's dispatch prompt in Claude Code (slice S29-sweeper-constituents, D32,
// B118–B119, of .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// Claude Code's SubagentStop event carries no prompt; the subagent's own transcript
// (agent_transcript_path) holds it as its first non-meta user line. OpenCode sends `prompt`.
// No network: fetch is replaced by a data: module that reports each call on stderr.

import { spawnSync } from "node:child_process";
import {
	existsSync,
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
const FETCH_STUB = `globalThis.fetch = async () => { process.stderr.write("FETCH\\n"); return { ok: true, json: async () => ({ answers: { consistent: { noul: 0.9 } } }) }; };`;
const SWEEP =
	"### IX-1 — headline\n\n- **Kind:** shared-root\n- **Constituents:** X4, X1\n";
const findingRows = (a, b) =>
	[
		"Findings:",
		`${a} | VIOLATION | \`src/a.mjs:3\` | \`const a = 1\` | L1 | a is mutable`,
		`${b} | VIOLATION | \`src/b.mjs:9\` | \`let b\` | L2 | b leaks`,
		"",
	].join("\n");
const PROMPT = findingRows("X1", "X4");
const BROKEN = (reason) =>
	`[jev-lint] BROKEN: dispatch prompt unreadable from agent_transcript_path (${reason}) — rows not linted\n`;
const META_LINE = JSON.stringify({
	type: "user",
	isMeta: true,
	message: { role: "user", content: "<system-reminder>x</system-reminder>" },
});
const userLine = (content) =>
	JSON.stringify({
		type: "user",
		isSidechain: true,
		agentId: "1",
		message: { role: "user", content },
	});

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Spawns row-lint in a fresh temp cwd; `transcript` (lines) is written there when given. */
function run({ transcript, path, ...extra } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-sweeper-"));
	dirs.push(cwd);
	const transcriptPath = path ?? join(cwd, "agent-1.jsonl");
	if (transcript) writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
	const event = {
		hook_event_name: "SubagentStop",
		agent_id: "1",
		agent_type: "rpiv:interaction-sweeper",
		agent_transcript_path: transcriptPath,
		last_assistant_message: SWEEP,
		...extra,
	};
	const r = spawnSync(
		process.execPath,
		[
			"--import",
			`data:text/javascript,${encodeURIComponent(FETCH_STUB)}`,
			ROW_LINT,
		],
		{
			cwd,
			input: JSON.stringify(event),
			encoding: "utf-8",
			env: { ...process.env, TYPESAFE_API_KEY: "t" },
		},
	);
	const logPath = join(cwd, "reports", "jev-lint-shadow.log");
	const log = existsSync(logPath)
		? readFileSync(logPath, "utf-8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l))
		: [];
	const fetches = (r.stderr.match(/^FETCH$/gm) ?? []).length;
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, log, fetches };
}

describe("S29 row-lint reads the sweeper prompt in Claude Code", () => {
	it("row-lint reads the sweeper prompt from agent_transcript_path", () => {
		for (const first of [
			userLine(PROMPT),
			userLine([{ type: "text", text: PROMPT }]),
		]) {
			const r = run({ transcript: [first, META_LINE] });
			expect(r.status, r.stderr).toBe(0);
			expect(r.fetches).toBe(1);
			expect(r.log).toHaveLength(1);
			expect(r.log[0]).toMatchObject({
				agent: "interaction-sweeper",
				mode: "constituent-aware",
				id: "IX-1",
			});
			expect(r.log[0].broken).toBeUndefined();
		}

		const prompted = run({
			transcript: [userLine(findingRows("Z1", "Z2"))],
			prompt: PROMPT,
		});
		expect(prompted.fetches).toBe(1);
		expect(prompted.log[0].broken).toBeUndefined();
	});

	it("row-lint reports an unreadable sweeper transcript", () => {
		const cases = [
			[
				{ path: join(tmpdir(), "rpiv-no-such-dir", "agent-9.jsonl") },
				"cannot read: ENOENT",
			],
			[{ transcript: ["{oops", userLine(PROMPT)] }, "line 1 is not JSON"],
			[{ transcript: [META_LINE] }, "no user message"],
			[{ transcript: [userLine([])] }, "no text in the user message"],
		];
		for (const [input, reason] of cases) {
			const r = run(input);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toBe(BROKEN(reason));
			expect(r.fetches).toBe(0);
		}

		const neither = run({ agent_transcript_path: undefined });
		expect(neither.stdout).toBe(
			"[jev-lint] UNAVAILABLE: constituent findings not supplied (no dispatch prompt) — rows not linted\n",
		);
		expect(neither.fetches).toBe(0);
	});
});
