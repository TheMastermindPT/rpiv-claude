// tests/record-approved-branch.test.mjs — contract tests for the approval recorder
// (.claude/hooks/record-approved-branch.mjs), slice S2-approved-branch of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md (D14).
// Seam: the recorder process — PostToolUse event JSON on stdin; effect is the
// `branch.<name>.rpivApproved` key in the fixture repository.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
const HOOKS = join(ROOT, ".claude", "hooks");
const RECORDER = join(HOOKS, "record-approved-branch.mjs");
const PRE_HOOK = join(HOOKS, "approve-outward-actions.mjs");
const TEST_TIMEOUT = 120_000;
// The accepted S1 commit: hooks.json entries other than the recorder's stay as
// they were there (B21).
const S1_ACCEPTED = "8b045e41b5cf10dfb1400b53d73e841dd11ef58c";
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

function runHookFile(file, stdin, spawnOptions = {}) {
	const res = spawnSync(process.execPath, [file], {
		input: stdin,
		encoding: "utf-8",
		timeout: 20_000,
		...spawnOptions,
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

const runRecorder = (stdin, spawnOptions) =>
	runHookFile(RECORDER, stdin, spawnOptions);

const postEvent = (command, cwd, extra = {}) =>
	JSON.stringify({
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: {},
		cwd,
		duration_ms: 50,
		...extra,
	});

let toolUseCount = 0;
/** The PreToolUse event for the same tool call: the hook notes which branch
    names exist before the command runs (D14 S2 revision 1). */
function sendPreToolUse(command, cwd, extra = {}) {
	const event = {
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command },
		cwd,
		...extra,
	};
	runHookFile(PRE_HOOK, JSON.stringify(event));
}

/** One tool call: PreToolUse, then the command's effect, then PostToolUse. */
function toolCall({
	command,
	cwd,
	before = [],
	effect = () => {},
	extra = {},
}) {
	const repo = freshRepo(before);
	const where = cwd ?? repo;
	const text = command(repo);
	const id = { tool_use_id: `toolu_test_${toolUseCount++}` };
	const toolName = extra.tool_name ? { tool_name: extra.tool_name } : {};
	sendPreToolUse(text, where, { ...id, ...toolName });
	effect(repo);
	const started = Date.now();
	const res = runRecorder(postEvent(text, where, { ...id, ...extra }));
	return { repo, res, recorderMs: Date.now() - started };
}

/** Records nothing unexpected: exit 0, empty stdout. */
function quietProblem(label, res) {
	if (res.status !== 0) return `${label}: exit ${res.status}`;
	if (res.stdout !== "") return `${label}: unexpected stdout ${res.stdout}`;
	return null;
}

/** After the tool call, each named branch's key must read `want`. `before`
    branches exist before the command; `created` ones are its effect. */
function recordFailures({
	label,
	command,
	branches,
	before = [],
	created = branches,
	cwd,
	extra,
	want,
}) {
	const effect = (repo) => {
		for (const branch of created) git(repo, "branch", "-f", branch);
	};
	const { repo, res } = toolCall({ command, cwd, before, effect, extra });
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
	// S2 revision 1 pins.
	{ command: literal("git checkout -B feat/b2"), branches: ["feat/b2"] },
	{
		command: literal("git worktree add -B feat/e2 ../wt-e2"),
		branches: ["feat/e2"],
	},
	{ command: literal("git switch --create=feat/l"), branches: ["feat/l"] },
];

const existed = (branch) => ({ before: [branch], created: [] });

const NOT_RECORDED_QUIETLY = [
	{
		command: literal("git switch -c feat/missing"),
		branches: ["feat/missing"],
		created: [],
	},
	{
		command: literal("git switch feat/x"),
		branches: ["feat/x"],
		...existed("feat/x"),
	},
	{
		command: literal("git branch -d feat/x"),
		branches: ["feat/x"],
		...existed("feat/x"),
	},
	{
		command: literal("git branch --list"),
		branches: ["feat/x"],
		...existed("feat/x"),
	},
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
	// S2 revision 1: a branch that existed before the command is not recorded.
	{
		command: literal("git branch -f main HEAD"),
		branches: ["main"],
		created: [],
	},
	{
		command: literal("git switch -C feat/x"),
		branches: ["feat/x"],
		...existed("feat/x"),
	},
	{
		command: literal("git branch feat/c || true"),
		branches: ["feat/c"],
		...existed("feat/c"),
	},
];

/** A report: exit 0 and exactly one PostToolUse additionalContext object
    (that contains `text`, when given). */
function reportProblem(label, res, text = "") {
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
	const context = out.additionalContext;
	return context.startsWith(NOT_RECORDED) && context.includes(text)
		? null
		: `${label}: context lacks ${NOT_RECORDED} … ${text}: ${context}`;
}

/** Creates `branch` in `repo` (the command's effect). */
const creates = (branch) => (repo) => git(repo, "branch", branch);

// S2 revision 1 report cases: [label, tool call, text the report contains].
function revisionOneReports() {
	const noSnapshot = (() => {
		const repo = freshRepo();
		git(repo, "branch", "feat/n");
		const stdin = postEvent("git switch -c feat/n", repo, {
			tool_use_id: "toolu_never_seen",
		});
		return runRecorder(stdin);
	})();
	const call = (command, branch) =>
		toolCall({ command: literal(command), effect: creates(branch) }).res;
	const emptyPath = (() => {
		const repo = freshRepo();
		const id = { tool_use_id: "toolu_empty_path" };
		sendPreToolUse("git switch -c feat/z", repo, id);
		git(repo, "branch", "feat/z");
		return runRecorder(postEvent("git switch -c feat/z", repo, id), {
			env: { ...process.env, PATH: "", Path: "" },
		});
	})();
	const locked = toolCall({
		command: literal("git switch -c feat/lk"),
		effect: (repo) => {
			git(repo, "branch", "feat/lk");
			writeFileSync(`${repo}/.git/config.lock`, "");
		},
	}).res;
	return [
		["no PreToolUse note", noSnapshot, ""],
		["wrapper string", call("bash -c 'git switch -c feat/w'", "feat/w"), ""],
		[
			"inline alias",
			call("git -c alias.nb='switch -c' nb feat/v", "feat/v"),
			"",
		],
		["git cannot run", emptyPath, "git could not run"],
		["config.lock", locked, ""],
	];
}

// S2 revision 2 report cases: [label, tool call result, text the report contains].
function revisionTwoReports() {
	const call = (command, branch) =>
		toolCall({ command: literal(command), effect: creates(branch) }).res;
	const notRepository = toolCall({
		command: literal("git switch -c feat/z"),
		cwd: FX.plain,
	}).res;
	return [
		[
			"! alias",
			call("git -c alias.nb='!git switch -c' nb feat/v", "feat/v"),
			"",
		],
		["branch --", call("git branch -- feat/x2", "feat/x2"), ""],
		["not a repository", notRepository, "not a readable git repository"],
	];
}

const NOTES_DIR = join(tmpdir(), "rpiv-branch-notes");

/** A note older than one hour is removed when a new note is written. */
function staleNoteProblem() {
	mkdirSync(NOTES_DIR, { recursive: true });
	const stale = join(NOTES_DIR, `toolu_stale_${process.pid}.json`);
	writeFileSync(stale, "{}");
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	utimesSync(stale, old, old);
	sendPreToolUse("git switch -c feat/s", freshRepo(), {
		tool_use_id: `toolu_fresh_${process.pid}`,
	});
	const left = existsSync(stale);
	rmSync(stale, { force: true });
	return left ? "a note older than one hour was not removed" : null;
}

/** 300 creations in one command: answered within 10 s, summarised. */
function manyCreationsProblem() {
	const names = Array.from({ length: 300 }, (_, k) => `b${k}`);
	const { res, recorderMs } = toolCall({
		command: literal(names.map((b) => `git branch ${b}`).join("; ")),
		effect: (repo) => {
			for (const b of names) git(repo, "branch", b);
		},
	});
	return (
		reportProblem("300 creations", res, "more") ??
		(recorderMs >= 10_000
			? `300 creations: recorder took ${recorderMs} ms`
			: null)
	);
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
			// S2 revision 2: old before-notes are cleaned up.
			expect.soft(staleNoteProblem()).toBeNull();
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
			// S2 revision 1: what the recorder cannot follow or confirm is reported.
			const revisionOne = revisionOneReports()
				.map(([label, res, text]) => reportProblem(label, res, text))
				.filter(Boolean);
			expect.soft(revisionOne).toEqual([]);
			expect.soft(manyCreationsProblem()).toBeNull();
			// S2 revision 2: more creations the recorder cannot follow; reasons.
			const revisionTwo = revisionTwoReports()
				.map(([label, res, text]) => reportProblem(label, res, text))
				.filter(Boolean);
			expect.soft(revisionTwo).toEqual([]);
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
		// S2 revision 1: every other entry is as it was at 8b045e4.
		const base = JSON.parse(
			git(ROOT, "show", `${S1_ACCEPTED}:./hooks/hooks.json`),
		).hooks;
		// S15 (D24) adds the cycle-event entries; they are pinned by
		// tests/cycle-log.test.mjs, so they are left out here.
		// Later slices' entries are pinned by their own tests too (S17:
		// chain-handoff-restore.mjs; S8: jev-lane.mjs).
		const LATER = ["record-cycle-event.mjs", "chain-handoff-restore.mjs", "jev-lane.mjs"];
		const isCycleEntry = (e) =>
			e.hooks.some((h) => LATER.some((name) => h.command.includes(name)));
		const others = {};
		for (const [event, list] of Object.entries(hooks)) {
			const kept = list.filter((e) => e !== entry && !isCycleEntry(e));
			if (kept.length > 0) others[event] = kept;
		}
		expect(others).toEqual(base);
		// S2 revision 1: the entry-point guard must not silence the hook,
		// however its path is spelled.
		const link = join(FX.root, "hooks-link");
		symlinkSync(HOOKS, link, "junction");
		const event = JSON.stringify({
			tool_name: "Bash",
			tool_input: { command: "git push" },
			cwd: FX.ok,
		});
		const paths = [
			PRE_HOOK.replaceAll("\\", "/"),
			join(link, "approve-outward-actions.mjs"),
		];
		const silent = paths.filter(
			(path) =>
				!runHookFile(path, event).stdout.includes("outward action: git push"),
		);
		expect(silent).toEqual([]);
	});
});
