// tests/cycle-log.test.mjs — contract tests for the cycle metrics log, slice
// S15-cycle-metrics of .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md
// (D24). Seams: the hook process (.claude/hooks/record-cycle-event.mjs) with the
// event JSON on stdin; hooks/hooks.json read as data; the reader CLI
// (skills/_shared/cycles.mjs) spawned in fixture repositories.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	readCommonDir,
	readHeadBranch,
} from "../skills/_shared/cycles.mjs";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, ".claude", "hooks", "record-cycle-event.mjs");
const READER = join(ROOT, "skills", "_shared", "cycles.mjs");
const HOOK_COMMAND =
	'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/record-cycle-event.mjs"';
// The predecessor of S15: every other hook registration stays as it was there.
const BASE = "b05e775";
const NOT_RECORDED = "[rpiv-hook] cycle event not recorded:";
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const TEST_TIMEOUT = 60_000;

const TMP = mkdtempSync(join(tmpdir(), "rpiv-s15-")).replaceAll("\\", "/");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let count = 0;
/** A fresh repository, switched to `branch` unless it is `main`. */
function repoOn(branch) {
	const dir = initRepo(`${TMP}/r${count++}`);
	if (branch !== "main") git(dir, "switch", "-q", "-c", branch);
	return dir;
}

const commonDir = (dir) =>
	git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
const logPath = (dir) => resolve(commonDir(dir), "rpiv", "cycles.jsonl");

function logLines(dir) {
	const path = logPath(dir);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8").split("\n").filter(Boolean);
}

function runHook(input, env, cwd) {
	const stdin = typeof input === "string" ? input : JSON.stringify(input);
	const res = spawnSync(process.execPath, [HOOK], {
		input: stdin,
		encoding: "utf-8",
		// The hook's own timeout in hooks.json is 10 seconds.
		timeout: 10_000,
		...(env ? { env } : {}),
		...(cwd ? { cwd } : {}),
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

function expectSilent(res) {
	expect(res.status).toBe(0);
	expect(res.stdout).toBe("");
}

/** The additionalContext a broken run printed. */
function noteOf(res) {
	expect(res.status).toBe(0);
	expect(res.stdout, "the hook printed no note").not.toBe("");
	const out = JSON.parse(res.stdout);
	expect(out).not.toHaveProperty("decision");
	expect(out.hookSpecificOutput).not.toHaveProperty("permissionDecision");
	return out.hookSpecificOutput;
}

const decisionEvent = (cwd, questions = 2) => ({
	hook_event_name: "PostToolUse",
	tool_name: "AskUserQuestion",
	session_id: "s1",
	cwd,
	tool_input: {
		questions: Array.from({ length: questions }, (_, k) => ({
			question: k === 0 ? "Secret A?" : "Secret B?",
			header: "h",
			options: [{ label: "a" }, { label: "b" }],
		})),
	},
	tool_response: { answers: { "Secret A?": "a" } },
});

function expectTimeWithin(time, start, end) {
	expect(time).toMatch(ISO_UTC);
	const at = Date.parse(time);
	expect(at).toBeGreaterThanOrEqual(start - 1);
	expect(at).toBeLessThanOrEqual(end + 1);
}

describe("S15 cycle-event hook", () => {
	it(
		"records an answered question as a decision line on the branch's shared log",
		() => {
			const repo = repoOn("feat/x");
			expect(existsSync(join(commonDir(repo), "rpiv"))).toBe(false);
			const start = Date.now();
			expectSilent(runHook(decisionEvent(repo)));
			const end = Date.now();
			const lines = logLines(repo);
			expect(lines).toHaveLength(1);
			expect(lines[0]).not.toContain("Secret A");
			expect(lines[0]).not.toContain("Secret B");
			const rec = JSON.parse(lines[0]);
			expect(Object.keys(rec).sort()).toEqual(
				["branch", "event", "questions", "session", "time", "v"].sort(),
			);
			expect(rec).toMatchObject({
				v: 1,
				branch: "feat/x",
				session: "s1",
				event: "decision",
				questions: 2,
			});
			expectTimeWithin(rec.time, start, end);

			const wt = `${TMP}/wt${count++}`;
			git(repo, "worktree", "add", "-q", "-b", "feat/y", wt);
			expectSilent(runHook(decisionEvent(wt, 1)));
			const both = logLines(repo);
			expect(both).toHaveLength(2);
			expect(JSON.parse(both[1])).toMatchObject({
				branch: "feat/y",
				questions: 1,
			});
			const wtGitDir = git(wt, "rev-parse", "--absolute-git-dir");
			expect(existsSync(join(wtGitDir, "rpiv", "cycles.jsonl"))).toBe(false);
		},
		TEST_TIMEOUT,
	);

	it(
		"records a subagent start as a dispatch line",
		() => {
			const repo = repoOn("feat/x");
			const base = {
				hook_event_name: "SubagentStart",
				agent_type: "rpiv:slice-verifier",
				session_id: "s1",
				cwd: repo,
			};
			expectSilent(runHook({ ...base, agent_id: "a1" }));
			expectSilent(runHook(base));
			const lines = logLines(repo);
			expect(lines).toHaveLength(2);
			const [first, second] = lines.map((l) => JSON.parse(l));
			expect(Object.keys(first).sort()).toEqual(
				["agent", "agent_id", "branch", "event", "session", "time", "v"].sort(),
			);
			expect(first).toMatchObject({
				v: 1,
				branch: "feat/x",
				session: "s1",
				event: "dispatch",
				agent: "rpiv:slice-verifier",
				agent_id: "a1",
			});
			expect(second.agent_id).toBeNull();
		},
		TEST_TIMEOUT,
	);

	it(
		"records rpiv stage starts and ignores other commands and tools",
		() => {
			const repo = repoOn("feat/x");
			const common = { session_id: "s1", cwd: repo };
			const expansion = (name) => ({
				...common,
				hook_event_name: "UserPromptExpansion",
				expansion_type: "slash_command",
				command_name: name,
				command_args: "secret-args.md S15",
				command_source: "plugin",
				prompt: `/${name} secret-args.md S15`,
			});
			const skill = (name) => ({
				...common,
				hook_event_name: "PostToolUse",
				tool_name: "Skill",
				tool_input: { skill: name, args: "secret-args" },
				tool_response: {},
			});
			expectSilent(runHook(expansion("rpiv:implement")));
			expectSilent(runHook(skill("rpiv:validate")));
			for (const other of [
				expansion("vitest"),
				expansion("rpiv:"),
				skill("simplify"),
				{
					...common,
					hook_event_name: "PostToolUse",
					tool_name: "Bash",
					tool_input: { command: "git status" },
				},
				{ ...common, hook_event_name: "Stop" },
			])
				expectSilent(runHook(other));
			const lines = logLines(repo);
			expect(lines).toHaveLength(2);
			for (const line of lines) expect(line).not.toContain("secret-args");
			const [cmd, sk] = lines.map((l) => JSON.parse(l));
			expect(Object.keys(cmd).sort()).toEqual(
				["branch", "event", "session", "stage", "time", "v", "via"].sort(),
			);
			expect(cmd).toMatchObject({
				event: "stage",
				stage: "implement",
				via: "command",
				branch: "feat/x",
			});
			expect(sk).toMatchObject({
				event: "stage",
				stage: "validate",
				via: "skill",
			});
		},
		TEST_TIMEOUT,
	);

	it(
		"stays silent without a repository and reports a broken event or write",
		() => {
			// (a) detached HEAD keeps the line, with no branch.
			const det = repoOn("main");
			git(det, "checkout", "-q", "--detach");
			expectSilent(runHook(decisionEvent(det)));
			const detLines = logLines(det);
			expect(detLines).toHaveLength(1);
			expect(JSON.parse(detLines[0]).branch).toBeNull();

			// (b) a directory that is not a repository: nothing written, nothing said.
			const plain = `${TMP}/plain${count++}`;
			mkdirSync(plain);
			expectSilent(runHook(decisionEvent(plain)));
			expect(readdirSync(plain)).toEqual([]);

			// (c) an event that is not JSON.
			const bad = noteOf(runHook("not json"));
			expect(bad.additionalContext.startsWith(NOT_RECORDED)).toBe(true);
			expect(bad.additionalContext).toContain("not valid JSON");

			// (d) the log folder cannot be created.
			const blocked = repoOn("feat/x");
			writeFileSync(join(commonDir(blocked), "rpiv"), "x");
			const write = noteOf(runHook(decisionEvent(blocked)));
			expect(write.hookEventName).toBe("PostToolUse");
			expect(write.additionalContext.startsWith(NOT_RECORDED)).toBe(true);
			expect(write.additionalContext).toContain("cannot write");

			// (e) git cannot run.
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
			);
			env.PATH = dirname(process.execPath);
			const noGit = noteOf(runHook(decisionEvent(repoOn("feat/x")), env));
			expect(noGit.additionalContext.startsWith(NOT_RECORDED)).toBe(true);
			expect(noGit.additionalContext).toContain("git could not run");

			// S15 revision 2 (W1): a repository git refuses is broken, not absent.
			const refused = (dir, ...words) => {
				const res = runHook(decisionEvent(dir));
				const note = noteOf(res).additionalContext;
				expect(note.startsWith(NOT_RECORDED)).toBe(true);
				for (const word of words) expect(note).toContain(word);
			};
			// (f) git refuses an unknown repository format.
			const format = repoOn("feat/x");
			git(format, "config", "core.repositoryformatversion", "99");
			refused(format, "git refused", "Expected git repo version");
			expect(existsSync(join(format, ".git", "rpiv"))).toBe(false);
			// (g) a .git file pointing nowhere.
			const pointer = `${TMP}/ptr${count++}`;
			mkdirSync(pointer);
			writeFileSync(join(pointer, ".git"), `gitdir: ${TMP}/missing-git-dir\n`);
			refused(pointer, "git refused");
			// (h) HEAD git cannot read is not a detached HEAD.
			const head = repoOn("feat/x");
			writeFileSync(join(head, ".git", "HEAD"), "ref: refs/heads/a..b\n");
			refused(head, "git could not read HEAD");
			expect(logLines(head)).toEqual([]);

			// (i) S15 revision 2 (W2): an AskUserQuestion without its questions list.
			const shapeless = repoOn("feat/x");
			const { tool_input: _dropped, ...noInput } = decisionEvent(shapeless);
			const shape = noteOf(runHook(noInput)).additionalContext;
			expect(shape).toContain("AskUserQuestion input has no questions list");
			expect(logLines(shapeless)).toEqual([]);

			// (j) S15 revision 3 (R2-W2): a cwd that does not exist is broken.
			const gone = noteOf(
				runHook(decisionEvent(`${TMP}/no-such-dir-${count++}`)),
			).additionalContext;
			expect(gone.startsWith(NOT_RECORDED)).toBe(true);
			expect(gone).toContain("cwd does not exist");

			// Pin (W5): an internal error says so.
			const internal = noteOf(runHook("null")).additionalContext;
			expect(internal.startsWith(NOT_RECORDED)).toBe(true);
			expect(internal).toContain("internal error");
		},
		TEST_TIMEOUT,
	);
});

/** The environment with a PATH that holds no git. */
function envWithoutGit() {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"),
	);
	env.PATH = dirname(process.execPath);
	return env;
}

// Pins added after mutation run 2 (developer choice "Pins para as lacunas"):
// behavior already built, fixed by tests only. `Expected red: none — pin`.
describe("S15 mutation pins", () => {
	it(
		"pins the hook's edge events",
		() => {
			const repo = repoOn("feat/x");
			const missing = `${TMP}/gone${count++}`;
			// A broken note names the event that fired.
			const sub = noteOf(
				runHook({
					hook_event_name: "SubagentStart",
					agent_type: "x",
					agent_id: "a",
					cwd: missing,
				}),
			);
			expect(sub.hookEventName).toBe("SubagentStart");
			const exp = noteOf(
				runHook({
					hook_event_name: "UserPromptExpansion",
					command_name: "rpiv:implement",
					cwd: missing,
				}),
			);
			expect(exp.hookEventName).toBe("UserPromptExpansion");
			// A Skill event without input and a non-text command name are no stage.
			expectSilent(
				runHook({ hook_event_name: "PostToolUse", tool_name: "Skill", cwd: repo }),
			);
			expectSilent(
				runHook({
					hook_event_name: "UserPromptExpansion",
					command_name: 5,
					cwd: repo,
				}),
			);
			expect(logLines(repo)).toEqual([]);
			// Without `cwd` in the event, the hook's own directory is used.
			const { cwd: _unused, ...noCwd } = decisionEvent(repo);
			expectSilent(runHook(noCwd, undefined, repo));
			expect(logLines(repo)).toHaveLength(1);
		},
		TEST_TIMEOUT,
	);

	it(
		"pins the reader's edge lines and broken calls",
		() => {
			const repo = repoOn("feat/x");
			const path = logPath(repo);
			mkdirSync(dirname(path), { recursive: true });
			const line = (fields) =>
				JSON.stringify({
					v: 1,
					time: "2026-10-06T10:00:00.000Z",
					branch: "feat/x",
					session: "s1",
					...fields,
				});
			writeFileSync(
				path,
				`${[
					"5",
					"[]",
					"null",
					'"s"',
					"{broken",
					"",
					line({ event: "decision", questions: "2" }),
					line({ event: "decision", questions: -1 }),
					line({ event: "decision", questions: 1.5 }),
					line({ event: "decision", questions: 3 }),
					line({ event: "dispatch", agent: "x", agent_id: 7 }),
					line({ event: "dispatch", agent: "x" }),
				].join("\n")}\n`,
			);
			const run = (cwd, args, env) =>
				spawnSync(process.execPath, [READER, ...args], {
					cwd,
					encoding: "utf-8",
					timeout: 20_000,
					...(env ? { env } : {}),
				});
			const ok = run(repo, []);
			expect(ok.status).toBe(0);
			const lines = ok.stdout.split(/\r?\n/).filter(Boolean);
			expect(lines).toContain("decisions: 3");
			expect(lines).toContain("dispatches: 2");
			expect(lines.at(-1)).toBe("diagnostic: 5 unreadable lines");

			const plain = `${TMP}/plain${count++}`;
			mkdirSync(plain);
			const outside = run(plain, []);
			expect(outside.status).toBe(2);
			expect(outside.stderr).toContain("cycles: broken: not a git repository: ");
			for (const args of [
				["--branch", ""],
				["--branch", "--x"],
			]) {
				const res = run(repo, args);
				expect(res.status).toBe(2);
				expect(res.stderr).toContain("--branch needs a branch name");
			}
			const noGit = run(repo, [], envWithoutGit());
			expect(noGit.status).toBe(2);
			expect(noGit.stderr).toContain("cycles: broken: git could not run");
		},
		TEST_TIMEOUT,
	);
});

describe("S15 git answers", () => {
	// S15 revision 3 (R2-W1, R2-W3): the one owner of reading git's answers.
	it("reads git's repository and HEAD answers", () => {
		const no = (err) => readCommonDir({ status: 128, out: "", err }, "/x");
		expect(
			no(
				"fatal: not a git repository (or any parent up to mount point /mnt)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).",
			),
		).toEqual({ outside: true });
		expect(
			no("fatal: not a git repository (or any of the parent directories): .git"),
		).toEqual({ outside: true });
		const pointer = no("fatal: not a git repository: /missing");
		expect(pointer.problem).toContain("git refused /x");
		expect(pointer.problem).toContain("/missing");
		expect(readCommonDir({ status: 0, out: "/c", err: "" }, "/x")).toEqual({
			common: "/c",
		});

		expect(
			readHeadBranch({ status: 0, out: "refs/heads/feat/x", err: "" }),
		).toEqual({ branch: "feat/x" });
		expect(
			readHeadBranch({ status: 0, out: "refs/remotes/origin/x", err: "" }),
		).toEqual({ branch: null });
		expect(readHeadBranch({ status: 1, out: "", err: "" })).toEqual({
			branch: null,
		});
		expect(
			readHeadBranch({ status: 128, out: "", err: "fatal: No such ref: HEAD" })
				.problem,
		).toContain("git could not read HEAD: fatal: No such ref: HEAD");
	});
});

describe("S15 hook registration", () => {
	const isCycleEntry = (entry) =>
		entry.hooks.some((h) => h.command.includes("record-cycle-event.mjs"));

	/** `hooks` without the cycle-event entries (and events left empty). */
	function withoutCycleEntries(hooks) {
		const out = {};
		for (const [event, entries] of Object.entries(hooks)) {
			const kept = entries.filter((e) => !isCycleEntry(e));
			if (kept.length > 0) out[event] = kept;
		}
		return out;
	}

	it("registers the cycle-event hook and leaves the other hooks as they were", () => {
		const now = JSON.parse(
			readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
		).hooks;
		const expected = {
			type: "command",
			command: HOOK_COMMAND,
			timeout: 10,
		};
		for (const [event, matcher] of [
			["PostToolUse", "AskUserQuestion|Skill"],
			["SubagentStart", ""],
			["UserPromptExpansion", ""],
		]) {
			const entries = (now[event] ?? []).filter(isCycleEntry);
			expect(entries, event).toHaveLength(1);
			expect(entries[0].matcher, event).toBe(matcher);
			expect(entries[0].hooks, event).toEqual([expected]);
		}
		const base = JSON.parse(
			git(ROOT, "show", `${BASE}:./hooks/hooks.json`),
		).hooks;
		expect(withoutCycleEntries(now)).toEqual(base);
		// The registered matcher read as a full-match regex over the tool name.
		const [post] = now.PostToolUse.filter(isCycleEntry);
		const full = new RegExp(`^(?:${post.matcher})$`);
		expect(["AskUserQuestion", "Skill"].every((t) => full.test(t))).toBe(true);
		expect(["Bash", "SkillX"].some((t) => full.test(t))).toBe(false);
	});
});

describe("S15 cycles reader", () => {
	function runReader(cwd, ...args) {
		const res = spawnSync(process.execPath, [READER, ...args], {
			cwd,
			encoding: "utf-8",
			timeout: 20_000,
		});
		return {
			status: res.status,
			lines: (res.stdout ?? "").split(/\r?\n/).filter(Boolean),
			stdout: res.stdout ?? "",
			stderr: res.stderr ?? "",
		};
	}

	const t = (n) => `2026-10-06T10:0${n}:00.000Z`;
	const rec = (n, branch, fields) =>
		JSON.stringify({ v: 1, time: t(n), branch, session: "s1", ...fields });

	it(
		"summarises one branch's cycle and reports missing and broken logs",
		() => {
			const repo = repoOn("feat/x");
			const path = logPath(repo);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`${[
					rec(1, "feat/x", { event: "stage", stage: "implement", via: "command" }),
					rec(2, "feat/x", { event: "decision", questions: 2 }),
					rec(3, "feat/x", { event: "decision", questions: 1 }),
					rec(4, "feat/y", { event: "stage", stage: "implement", via: "skill" }),
					rec(5, "feat/x", { event: "dispatch", agent: "x", agent_id: "a1" }),
					"{broken",
					rec(6, "feat/x", { event: "dispatch", agent: "x", agent_id: "a1" }),
					rec(7, "feat/x", { event: "dispatch", agent: "x", agent_id: "a2" }),
					rec(8, "feat/x", { event: "dispatch", agent: "x", agent_id: null }),
					rec(9, "feat/x", { event: "stage", stage: "deep-review", via: "skill" }),
				].join("\n")}\n`,
			);

			const x = runReader(repo, "--branch", "feat/x");
			expect(x.status).toBe(0);
			expect(x.lines).toEqual([
				"cycles: feat/x",
				`log: ${path}`,
				`stage: ${t(1)} implement`,
				`stage: ${t(9)} deep-review`,
				"decisions: 3",
				"dispatches: 3",
				`first: ${t(1)}`,
				`last: ${t(9)}`,
				"diagnostic: 1 unreadable line",
			]);

			const wt = `${TMP}/wt${count++}`;
			git(repo, "worktree", "add", "-q", "-b", "feat/y", wt);
			const y = runReader(wt);
			expect(y.status).toBe(0);
			expect(y.lines).toEqual([
				"cycles: feat/y",
				`log: ${path}`,
				`stage: ${t(4)} implement`,
				"decisions: 0",
				"dispatches: 0",
				`first: ${t(4)}`,
				`last: ${t(4)}`,
				"diagnostic: 1 unreadable line",
			]);

			const z = runReader(repo, "--branch", "feat/z");
			expect(z.status).toBe(0);
			expect(z.lines.slice(0, 2)).toEqual(["cycles: feat/z", "records: none"]);

			const empty = runReader(repoOn("main"));
			expect(empty.status).toBe(0);
			expect(empty.lines).toEqual(["cycles: main", "records: none"]);

			// Pin (W5): a detached HEAD reads the lines written with no branch.
			const det = repoOn("main");
			git(det, "checkout", "-q", "--detach");
			const detLog = logPath(det);
			mkdirSync(dirname(detLog), { recursive: true });
			writeFileSync(
				detLog,
				`${[
					rec(1, null, { event: "decision", questions: 2 }),
					rec(2, "main", { event: "decision", questions: 5 }),
				].join("\n")}\n`,
			);
			for (const args of [[], ["--branch", "(detached)"]]) {
				const d = runReader(det, ...args);
				expect(d.status).toBe(0);
				expect(d.lines[0]).toBe("cycles: (detached)");
				expect(d.lines).toContain("decisions: 2");
			}

			const plain = `${TMP}/plain${count++}`;
			mkdirSync(plain);
			// S15 revision 2 (W1): refused repositories, unreadable HEAD and a log
			// folder that is not a folder are broken, not empty.
			const format = repoOn("feat/x");
			git(format, "config", "core.repositoryformatversion", "99");
			const head = repoOn("feat/x");
			writeFileSync(join(head, ".git", "HEAD"), "ref: refs/heads/a..b\n");
			const fileFolder = repoOn("feat/x");
			writeFileSync(join(commonDir(fileFolder), "rpiv"), "x");
			for (const [cwd, args, word] of [
				[plain, [], "git"],
				[repo, ["--branch"], "--branch"],
				[repo, ["--frob"], "--frob"],
				[format, [], "git refused"],
				[head, [], "git could not read HEAD"],
				[fileFolder, [], "log folder is not a folder"],
			]) {
				const res = runReader(cwd, ...args);
				expect(res.status, word).toBe(2);
				expect(res.stdout, word).toBe("");
				expect(res.stderr.startsWith("cycles: broken: "), word).toBe(true);
				expect(res.stderr, word).toContain(word);
			}
		},
		TEST_TIMEOUT,
	);

	it(
		"cycles --archive moves one branch's lines to the archive",
		() => {
			const repo = repoOn("main");
			const log = logPath(repo);
			const archive = resolve(commonDir(repo), "rpiv", "cycles-archive.jsonl");
			const [l0, l1, l2, l4] = [
				rec(0, "feat/x", { event: "stage", stage: "old" }),
				rec(1, "feat/x", { event: "stage", stage: "implement" }),
				rec(2, "main", { event: "stage", stage: "discover" }),
				rec(4, "feat/x", { event: "decision", questions: 1 }),
			];
			const l3 = "not json";
			mkdirSync(dirname(log), { recursive: true });
			writeFileSync(log, `${[l1, l2, l3, l4].join("\n")}\n`);
			writeFileSync(archive, `${l0}\n`);
			const archivePath = archive.replaceAll("\\", "/");
			const first = runReader(repo, "--archive", "--branch", "feat/x");
			expect(first.stderr).toBe("");
			expect(first.status).toBe(0);
			expect(first.stdout.replaceAll("\\", "/")).toBe(`archived: 2 line(s) of feat/x to ${archivePath}\n`);
			expect(readFileSync(log, "utf-8")).toBe(`${l2}\n${l3}\n`);
			expect(readFileSync(archive, "utf-8")).toBe(`${l0}\n${l1}\n${l4}\n`);

			const again = runReader(repo, "--archive", "--branch", "feat/x");
			expect(again.stdout.replaceAll("\\", "/")).toBe(`archived: 0 line(s) of feat/x to ${archivePath}\n`);
			expect(readFileSync(log, "utf-8")).toBe(`${l2}\n${l3}\n`);
			expect(readFileSync(archive, "utf-8")).toBe(`${l0}\n${l1}\n${l4}\n`);

			const alone = runReader(repo, "--archive");
			expect(alone).toMatchObject({ status: 2, stdout: "", stderr: "cycles: broken: --archive needs --branch\n" });

			const empty = repoOn("main");
			const none = runReader(empty, "--archive", "--branch", "feat/x");
			expect(none.status).toBe(0);
			expect(none.stdout).toMatch(/^archived: 0 line\(s\) of feat\/x to /);
			expect(existsSync(logPath(empty))).toBe(false);
			expect(existsSync(resolve(commonDir(empty), "rpiv", "cycles-archive.jsonl"))).toBe(false);
		},
		TEST_TIMEOUT,
	);
});
