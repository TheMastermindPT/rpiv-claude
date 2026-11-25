// The PreCompact/SessionStart(compact) pair: what is saved before compaction and
// what is told to Claude after it.
import { spawnSync } from "node:child_process";
import {
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

const HOOKS = fileURLToPath(new URL("../.claude/hooks/", import.meta.url));
const temps = [];
const tempRepo = () => {
	const dir = mkdtempSync(join(tmpdir(), "session-state-"));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const runHook = (name, repo) =>
	spawnSync(process.execPath, [join(HOOKS, name)], {
		cwd: repo,
		input: "{}",
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
	});

const stateFile = (repo) => join(repo, ".rpiv", ".claude", "session-state.json");
const put = (file, text) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
};

describe("session-state-preserve", () => {
	it("saves no agent-activity block, even when an old batch-state file exists", () => {
		const repo = tempRepo();
		// Left behind by the removed cross-agent-consistency hook.
		put(
			join(repo, ".rpiv", ".claude", "agent-batch-state.json"),
			JSON.stringify({ batches: [{ agentCount: 3, filesTouched: ["a.ts"] }] }),
		);
		const { status } = runHook("session-state-preserve.mjs", repo);
		expect(status).toBe(0);
		const state = JSON.parse(readFileSync(stateFile(repo), "utf8"));
		expect(state.project).toBe(repo);
		expect(typeof state.git.branch).toBe("string");
		expect(state).not.toHaveProperty("agentActivity");
	});
});

describe("session-state-restore", () => {
	it("prints no recent-files block from an old state file", () => {
		const repo = tempRepo();
		put(
			stateFile(repo),
			JSON.stringify({
				compactedAt: new Date().toISOString(),
				project: repo,
				git: { branch: "feat/x", commit: "abc1234" },
				agentActivity: { lastBatchCount: 1, recentFiles: ["x.ts"] },
			}),
		);
		const { stdout, status } = runHook("session-state-restore.mjs", repo);
		expect(status).toBe(0);
		expect(stdout).toContain("Branch:  feat/x");
		expect(stdout).toContain("Commit:  abc1234");
		expect(stdout).not.toContain("Recent files");
		expect(stdout).not.toContain("x.ts");
	});
});
