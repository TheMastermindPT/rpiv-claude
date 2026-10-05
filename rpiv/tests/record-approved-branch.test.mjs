// tests/record-approved-branch.test.mjs — contract tests for the approval recorder
// (.claude/hooks/record-approved-branch.mjs), slice S2-approved-branch of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md (D14).
// Seam: the recorder process — PostToolUse event JSON on stdin; effect is the
// `branch.<name>.rpivApproved` key in the fixture repository.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	approvalOf,
	git,
	initRepo,
	makeFixtures,
} from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDER = join(ROOT, ".claude", "hooks", "record-approved-branch.mjs");
const TEST_TIMEOUT = 120_000;
const NOT_RECORDED = "[rpiv-hook] approval not recorded:";

const FX = makeFixtures();
afterAll(() => FX.cleanup());

let repoCount = 0;
/** A fresh repository on `main` with the given branches already created. */
function freshRepo(branches = []) {
	const dir = initRepo(`${FX.root}/rec-${repoCount++}`);
	for (const branch of branches) git(dir, "branch", branch);
	return dir;
}

function runRecorder(stdin) {
	const res = spawnSync(process.execPath, [RECORDER], {
		input: stdin,
		encoding: "utf-8",
		timeout: 10_000,
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

const postEvent = (command, cwd, extra = {}) =>
	JSON.stringify({
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: {},
		cwd,
		...extra,
	});

/** Records nothing unexpected: exit 0, empty stdout. */
function quietProblem(label, res) {
	if (res.status !== 0) return `${label}: exit ${res.status}`;
	if (res.stdout !== "") return `${label}: unexpected stdout ${res.stdout}`;
	return null;
}

/** After the event, each named branch's key must read `want`. */
function recordFailures({
	label,
	command,
	branches,
	created = branches,
	cwd,
	extra,
	want,
}) {
	const repo = freshRepo(created);
	const res = runRecorder(postEvent(command(repo), cwd ?? repo, extra));
	const problems = [quietProblem(label, res)];
	for (const branch of branches) {
		const got = approvalOf(repo, branch);
		if (got !== want)
			problems.push(
				`${label}: ${branch} marker ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
			);
	}
	return problems.filter(Boolean);
}

const literal = (command) => () => command;

const RECORDED = [
	{ command: literal("git switch -c feat/a"), branches: ["feat/a"] },
	{ command: literal("git switch -C feat/d"), branches: ["feat/d"] },
	{ command: literal("git checkout -b feat/b"), branches: ["feat/b"] },
	{ command: literal("git branch feat/c"), branches: ["feat/c"] },
	{ command: literal("git branch feat/c2 main"), branches: ["feat/c2"] },
	{
		command: literal("git worktree add -b feat/e ../wt-e"),
		branches: ["feat/e"],
	},
	{
		command: literal("git branch feat/i && git branch feat/j"),
		branches: ["feat/i", "feat/j"],
	},
	{
		command: (repo) => `git -C "${repo}" switch -c feat/g`,
		branches: ["feat/g"],
		cwd: FX.plain,
	},
	{
		command: (repo) => `cd "${repo}" && git switch -c feat/f`,
		branches: ["feat/f"],
		cwd: FX.plain,
	},
	{
		command: literal("git switch -c feat/h"),
		branches: ["feat/h"],
		extra: { tool_name: "PowerShell" },
	},
];

const NOT_RECORDED_QUIETLY = [
	{
		command: literal("git switch -c feat/missing"),
		branches: ["feat/missing"],
		created: [],
	},
	{ command: literal("git switch feat/x"), branches: ["feat/x"] },
	{ command: literal("git branch -d feat/x"), branches: ["feat/x"] },
	{ command: literal("git branch --list"), branches: ["feat/x"] },
	{
		command: literal("git switch -c feat/a"),
		branches: ["feat/a"],
		extra: { tool_name: "Write" },
	},
	{
		command: literal("git switch -c feat/a"),
		branches: ["feat/a"],
		extra: { hook_event_name: "PostToolUseFailure" },
	},
];

/** A report: exit 0 and exactly one PostToolUse additionalContext object. */
function reportProblem(label, res) {
	if (res.status !== 0) return `${label}: exit ${res.status}`;
	let parsed;
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		return `${label}: stdout is not one JSON object: ${JSON.stringify(res.stdout)}`;
	}
	const out = parsed?.hookSpecificOutput;
	const shapeOk =
		Object.keys(parsed ?? {}).join(",") === "hookSpecificOutput" &&
		Object.keys(out ?? {})
			.sort()
			.join(",") === "additionalContext,hookEventName" &&
		out.hookEventName === "PostToolUse";
	if (!shapeOk) return `${label}: unexpected shape ${res.stdout}`;
	return out.additionalContext.startsWith(NOT_RECORDED)
		? null
		: `${label}: context lacks prefix: ${out.additionalContext}`;
}

describe("record-approved-branch hook", () => {
	it(
		"records a branch the developer approved creating",
		() => {
			const failures = [
				...RECORDED.map((c, n) => ({
					...c,
					want: "true",
					label: `recorded #${n}`,
				})),
				...NOT_RECORDED_QUIETLY.map((c, n) => ({
					...c,
					want: "",
					label: `quiet #${n}`,
				})),
			].flatMap((c) => recordFailures(c));
			expect.soft(failures).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it(
		"reports a branch creation it could not record",
		() => {
			const repo = freshRepo();
			const cases = [
				["computed name", postEvent("git switch -c $B", repo)],
				["unparseable", postEvent('git switch -c "feat/z', repo)],
				["not JSON", "{not json"],
				["no repository", postEvent("git switch -c feat/z", FX.plain)],
			];
			const failures = cases
				.map(([label, stdin]) => reportProblem(label, runRecorder(stdin)))
				.filter(Boolean);
			expect.soft(failures).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it("registers the approval recorder for Bash and PowerShell", () => {
		const hooks = JSON.parse(
			readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
		).hooks;
		const command =
			'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/record-approved-branch.mjs"';
		const entries = (hooks.PostToolUse ?? []).filter((e) =>
			e.hooks.some((h) => h.command === command),
		);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		const matcher = new RegExp(`^(?:${entry.matcher})$`);
		for (const tool of ["Bash", "PowerShell"])
			expect(matcher.test(tool)).toBe(true);
		for (const tool of ["Write", "Edit", "mcp__github__create_issue"])
			expect(matcher.test(tool)).toBe(false);
		expect(entry.hooks).toHaveLength(1);
		expect(entry.hooks[0].type).toBe("command");
		expect(entry.hooks[0].timeout).toBeLessThanOrEqual(10);
	});
});
