// tests/jev-lane.test.mjs — contract tests for the Jev lane shadow hook
// scripts/jev-lane.mjs (slice S8-jev-lane-shadow, D38, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// The hook is spawned with a `data:` module that replaces globalThis.fetch: it
// prints `FETCH <body>` on stderr and answers STUB_REPLY with STUB_STATUS. No
// network.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "jev-lane.mjs");
const TEST_TIMEOUT = 60_000;
const FETCH_STUB = [
	"globalThis.fetch = async (url, init) => {",
	'  process.stderr.write(`FETCH ${init.body}\\n`);',
	'  const status = Number(process.env.STUB_STATUS ?? "200");',
	"  return { ok: status < 400, status, json: async () => JSON.parse(process.env.STUB_REPLY) };",
	"};",
].join("\n");

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-s8-"))).replaceAll("\\", "/");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let count = 0;

const LEVELS = [
	"Docs, tests, or a small edit inside one module; no shared interface, data, security, build or review-gate impact",
	"An ordinary feature or fix across a few modules or a shared helper; no security, data migration, CI or review-gate impact",
	"Touches authentication, permissions or secrets, data migrations, CI or release configuration, review gates, or a widely used interface",
];
const NOULS = [
	"touches_security",
	"changes_data_or_migration",
	"changes_build_or_ci",
	"changes_shared_interface",
	"docs_or_tests_only",
];

/** A Jev reply with `score` and every noul at 0.1 (`omit` leaves an answer out). */
function reply(score, { omit, noul = {} } = {}) {
	const answers = {
		lane_risk: { type: "score", score, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } },
	};
	for (const id of NOULS) answers[id] = { type: "noul", noul: noul[id] ?? 0.1 };
	if (omit) delete answers[omit];
	return JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } });
}

/** A repository on `feat/x` with an untracked a.js. */
function repo() {
	const dir = initRepo(`${TMP}/r${count++}`);
	git(dir, "switch", "-q", "-c", "feat/x");
	writeFileSync(join(dir, "a.js"), "a\n");
	return dir;
}

const LANE_CMD = 'node "/p/skills/_shared/lane.mjs" --paths src/a.js docs/b.md --slices 2';

/** Runs the hook in `cwd` for a Bash event (or raw `stdin`). */
function run(cwd, { top, command = LANE_CMD, stdout = "lane: normal\nreason: slices: 2 > 1\n", tool = "Bash", stdin, env = {}, stub = reply(1.2) } = {}) {
	const event = { hook_event_name: "PostToolUse", tool_name: tool, cwd, tool_input: { command }, tool_response: { stdout } };
	const res = spawnSync(
		process.execPath,
		["--import", `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, HOOK],
		{
			cwd,
			input: stdin ?? JSON.stringify(event),
			encoding: "utf-8",
			timeout: 30_000,
			env: { ...process.env, TYPESAFE_API_KEY: "t", STUB_REPLY: stub, ...env },
		},
	);
	const fetches = (res.stderr ?? "")
		.split("\n")
		.filter((l) => l.startsWith("FETCH "))
		.map((l) => JSON.parse(l.slice("FETCH ".length)));
	const logPath = join(top ?? cwd, ".rpiv", "logs", "jev-lane-shadow.log");
	const log = existsSync(logPath)
		? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
		: [];
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", fetches, log };
}

describe("Jev lane shadow hook (S8)", () => {
	it(
		"the shadow log lives under .rpiv/logs",
		() => {
			// S8 revision 1 (B162): never a file `lane.mjs --working` would count.
			const dir = repo();
			const res = run(dir);
			expect(res.log).toHaveLength(1);
			expect(existsSync(join(dir, "reports"))).toBe(false);
			const sub = join(dir, "sub");
			mkdirSync(sub);
			const fromSub = run(sub, { top: dir, command: "node lane.mjs --paths ../a.js" });
			expect(fromSub.log.at(-1)).toMatchObject({ status: "ok" });
			expect(existsSync(join(sub, ".rpiv"))).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"a log that cannot be written is reported",
		() => {
			// S8 revision 1 (B163): never a silent ok.
			const dir = repo();
			mkdirSync(join(dir, ".rpiv"));
			writeFileSync(join(dir, ".rpiv", "logs"), "a file where the log folder should be");
			const res = run(dir);
			expect(res.status).toBe(0);
			const context = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
			expect(context.startsWith("[jev-lane] LOG UNAVAILABLE: ")).toBe(true);
			expect(context.endsWith(" — shadow lane not logged")).toBe(true);
		},
		TEST_TIMEOUT,
	);

	it(
		"the lane.mjs call is read as the shell reads it",
		() => {
			// S8 revision 1 (B164).
			const dir = repo();
			for (const [label, command, tool = "Bash"] of [
				["glued ;", 'node lane.mjs --paths src/a.js --slices 1; echo "exit=$?"'],
				["redirect", "node lane.mjs --paths src/a.js --slices 1 2>&1"],
				["two lines", "node lane.mjs --paths src/a.js\necho secret-token"],
				["earlier mention", "git diff -- skills/_shared/lane.mjs && node lane.mjs --paths src/a.js"],
				["absolute path", `node lane.mjs --paths ${dir}/src/a.js`],
				["PowerShell", 'node "C:\\p\\lane.mjs" --paths src/a.js; Write-Host done', "PowerShell"],
			]) {
				const res = run(dir, { command, tool });
				expect.soft(res.stdout, label).toBe("");
				expect.soft(res.fetches[0]?.state.files, label).toEqual(["src/a.js"]);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"computed lane.mjs arguments are skipped",
		() => {
			// S8 revision 2 (B167): the shell's values are not the command's text.
			for (const command of [
				"node lane.mjs --paths $(git diff --name-only)",
				'node lane.mjs --range "$BASE"..HEAD',
			]) {
				const res = run(repo(), { command });
				expect.soft(res.fetches, command).toEqual([]);
				expect.soft(res.stdout, command).toBe("");
				expect.soft(res.log, command).toEqual([
					expect.objectContaining({ status: "skipped", reason: "computed lane.mjs arguments", lane: "normal" }),
				]);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"a log failure never hides a broken reason",
		() => {
			// S8 revision 2 (B171).
			const dir = repo();
			mkdirSync(join(dir, ".rpiv"));
			writeFileSync(join(dir, ".rpiv", "logs"), "a file where the log folder should be");
			const res = run(dir, { env: { STUB_STATUS: "500" } });
			const context = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
			expect(context).toContain("[jev-lane] BROKEN: HTTP 500 from Jev endpoint");
			expect(context).toContain("[jev-lane] LOG UNAVAILABLE: ");
		},
		TEST_TIMEOUT,
	);

	it(
		"the mode option may stand anywhere",
		() => {
			// S8 revision 2 (B170).
			const res = run(repo(), { command: "node lane.mjs --slices 2 --paths src/a.js" });
			expect(res.fetches).toHaveLength(1);
			expect(res.fetches[0].state).toMatchObject({ files: ["src/a.js"], slices: 2 });
		},
		TEST_TIMEOUT,
	);

	it(
		"paths are repository-relative from any cwd",
		() => {
			// S8 revision 2 (B169).
			const dir = repo();
			const sub = join(dir, "sub");
			mkdirSync(sub);
			const res = run(sub, { top: dir, command: "node lane.mjs --paths ../a.js x.js" });
			expect(res.fetches[0]?.state.files).toEqual(["a.js", "sub/x.js"]);
		},
		TEST_TIMEOUT,
	);

	it(
		"a thrown error keeps the lane",
		() => {
			// S8 revision 2 (B168).
			const res = run(repo(), { command: "node lane.mjs --range nosuch..HEAD", stdout: "lane: normal\n" });
			expect(res.log).toHaveLength(1);
			expect(res.log[0]).toMatchObject({ status: "broken", lane: "normal" });
			expect(res.log[0].reason).toMatch(/^git /);
			expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toBe(
				`[jev-lane] BROKEN: ${res.log[0].reason} — shadow lane not compared`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"a broken row keeps the lane and the change",
		() => {
			// S8 revision 1 (B166).
			const res = run(repo(), { stub: reply(2.5) });
			expect(res.log[0]).toMatchObject({
				status: "broken",
				reason: "malformed answer: lane_risk",
				lane: "normal",
				branch: "feat/x",
				mode: "paths",
				slices: 2,
				files: 2,
			});
		},
		TEST_TIMEOUT,
	);

	it(
		"only the first stdout line decides",
		() => {
			// S8 revision 1 (B165).
			const dir = repo();
			const res = run(dir, { stdout: "noise\nlane: normal\n" });
			expect(res.fetches).toEqual([]);
			expect(res.log).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it(
		"a lane.mjs run logs Jev's shadow lane",
		() => {
			const dir = repo();
			const res = run(dir);
			expect(res.stdout).toBe("");
			expect(res.status).toBe(0);
			expect(res.fetches).toHaveLength(1);
			const [body] = res.fetches;
			expect(body.model).toBe("jev-1.13.0");
			expect(body.state).toEqual({
				branch: "feat/x",
				mode: "paths",
				slices: 2,
				files: ["src/a.js", "docs/b.md"],
				files_total: 2,
			});
			expect(Object.keys(body.questions)).toEqual(["lane_risk", ...NOULS]);
			expect(body.questions.lane_risk.type).toBe("score");
			expect(body.questions.lane_risk.criteria).toEqual(LEVELS);
			for (const id of NOULS) expect(body.questions[id].type, id).toBe("noul");
			expect(res.log).toHaveLength(1);
			expect(res.log[0]).toMatchObject({
				lane: "normal",
				status: "ok",
				jevLane: "normal",
				score: 1.2,
				confidence: 0.8,
				files: 2,
				model: "jev-1.13.0",
				factors: Object.fromEntries(NOULS.map((id) => [id, 0.1])),
			});
			expect(typeof res.log[0].latencyMs).toBe("number");

			// Score boundaries.
			for (const [score, lane] of [[0.49, "fast"], [0.5, "normal"], [1.49, "normal"], [1.5, "rigorous"], [2, "rigorous"]]) {
				const one = run(repo(), { stub: reply(score) });
				expect.soft(one.log[0]?.jevLane, String(score)).toBe(lane);
			}

			// --working and --range list the files lane.mjs lists for them (a fresh
			// repository: the cases stay independent).
			const dir2 = repo();
			const working = run(dir2, { command: 'node "/p/lane.mjs" --working --slices 1', stdout: "lane: fast\n" });
			expect(working.fetches[0].state).toMatchObject({ mode: "working", files: ["a.js"], files_total: 1 });
			git(dir2, "add", "a.js");
			git(dir2, "commit", "-q", "-m", "a");
			const range = run(dir2, { command: 'node "/p/lane.mjs" --range main..feat/x --slices 1', stdout: "lane: fast\n" });
			expect(range.fetches[0].state).toMatchObject({ mode: "range", files: ["a.js"], files_total: 1 });

			// 250 paths: 200 sent, the total kept.
			const many = Array.from({ length: 250 }, (_, i) => `f${i}.js`).join(" ");
			const big = run(repo(), { command: `node lane.mjs --paths ${many}` });
			expect(big.fetches[0].state.files).toHaveLength(200);
			expect(big.fetches[0].state.files_total).toBe(250);
		},
		TEST_TIMEOUT,
	);

	it(
		"Jev failures are logged, never acted on",
		() => {
			const BROKEN = (reason) =>
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: `[jev-lane] BROKEN: ${reason} — shadow lane not compared`,
					},
				});
			// No key anywhere (env without the key, no .env in the repository).
			const env = { ...process.env };
			delete env.TYPESAFE_API_KEY;
			const dir = repo();
			const noKey = spawnSync(
				process.execPath,
				["--import", `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, HOOK],
				{
					cwd: dir,
					input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: LANE_CMD }, tool_response: { stdout: "lane: normal\n" } }),
					encoding: "utf-8",
					env: { ...env, STUB_REPLY: reply(1) },
				},
			);
			expect(noKey.status).toBe(0);
			expect(noKey.stdout).toBe("");
			expect(noKey.stderr).not.toContain("FETCH ");
			const [row] = readFileSync(join(dir, ".rpiv", "logs", "jev-lane-shadow.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			expect(row).toMatchObject({ status: "unavailable", reason: "no TYPESAFE_API_KEY in env or .env", lane: "normal" });

			const http = run(repo(), { env: { STUB_STATUS: "500" } });
			expect(http.status).toBe(0);
			expect(http.stdout).toBe(BROKEN("HTTP 500 from Jev endpoint"));
			expect(http.log[0]).toMatchObject({ status: "broken", reason: "HTTP 500 from Jev endpoint" });

			for (const [stub, id] of [
				[reply(2.5), "lane_risk"],
				[reply(1, { noul: { changes_build_or_ci: 1.2 } }), "changes_build_or_ci"],
				[reply(1, { omit: "docs_or_tests_only" }), "docs_or_tests_only"],
			]) {
				const bad = run(repo(), { stub });
				expect.soft(bad.status, id).toBe(0);
				expect.soft(bad.stdout, id).toBe(BROKEN(`malformed answer: ${id}`));
				expect.soft(bad.log[0]?.status, id).toBe("broken");
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"the Jev lane shadow hook is registered",
		() => {
			const post = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")).hooks.PostToolUse;
			const entries = post.filter((e) => e.hooks.some((h) => h.command.includes("scripts/jev-lane.mjs")));
			expect(entries).toHaveLength(1);
			const [entry] = entries;
			const matcher = new RegExp(`^(?:${entry.matcher})$`);
			for (const tool of ["Bash", "PowerShell"]) expect(matcher.test(tool), tool).toBe(true);
			for (const tool of ["Write", "Agent"]) expect(matcher.test(tool), tool).toBe(false);
			expect(entry.hooks).toHaveLength(1);
			expect(entry.hooks[0].timeout).toBeGreaterThanOrEqual(8);
			// A PowerShell event behaves as a Bash one.
			const res = run(repo(), { tool: "PowerShell" });
			expect(res.fetches).toHaveLength(1);
			expect(res.log[0]).toMatchObject({ status: "ok", lane: "normal" });
		},
		TEST_TIMEOUT,
	);

	it(
		"only successful lane.mjs runs reach Jev",
		() => {
			for (const [label, options] of [
				["not lane.mjs", { command: "git status", stdout: "On branch feat/x\n" }],
				["empty stdout", { stdout: "" }],
				["broken lane call", { stdout: "lane: broken: git diff failed\n" }],
				["a mention only", { command: "rg lane.mjs docs", stdout: "docs/x.md: lane.mjs\n" }],
			]) {
				const dir = repo();
				const res = run(dir, options);
				expect.soft(res.status, label).toBe(0);
				expect.soft(res.stdout, label).toBe("");
				expect.soft(res.fetches, label).toEqual([]);
				expect.soft(existsSync(join(dir, ".rpiv")), label).toBe(false);
			}
			const garbled = run(repo(), { stdin: "not json" });
			expect(garbled.status).toBe(0);
			expect(garbled.fetches).toEqual([]);
			expect(garbled.stdout).toBe(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "[jev-lane] BROKEN: the hook event is not valid JSON — shadow lane not compared",
					},
				}),
			);
		},
		TEST_TIMEOUT,
	);
});

describe("Jev lane shadow rows keep the paths (S30)", () => {
	it(
		"a shadow row keeps the paths Jev was sent",
		() => {
			// S30 revision 1 (B187): labels join a row on the paths it measured.
			const ok = run(repo());
			expect(ok.log).toHaveLength(1);
			expect(ok.log[0]).toMatchObject({ status: "ok", files: 2, paths: ["src/a.js", "docs/b.md"] });

			const many = Array.from({ length: 201 }, (_, i) => `p${i}.js`);
			const big = run(repo(), { command: `node lane.mjs --paths ${many.join(" ")}` });
			expect(big.log[0].files).toBe(201);
			expect(big.log[0].paths).toEqual(many.slice(0, 200));

			const noKey = run(repo(), { env: { TYPESAFE_API_KEY: "" } });
			expect(noKey.log[0]).toMatchObject({ status: "unavailable", paths: ["src/a.js", "docs/b.md"] });

			const skipped = run(repo(), { command: "node lane.mjs --paths $(git diff --name-only)" });
			expect(skipped.log[0].status).toBe("skipped");
			expect(skipped.log[0]).not.toHaveProperty("paths");
		},
		TEST_TIMEOUT,
	);
});
