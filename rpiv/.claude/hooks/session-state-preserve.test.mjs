// session-state-preserve.test.mjs — golden-fixture test for session-state-preserve.mjs.
// Points CLAUDE_PROJECT_DIR at a throwaway dir and asserts the state file shape,
// agent-batch continuity, and non-blocking exit.
//
//   node .claude/hooks/session-state-preserve.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "session-state-preserve.mjs");

const runHook = (projectDir) =>
  spawnSync("node", [HOOK], {
    cwd: projectDir, input: "{}", encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });

const stateFile = (projectDir) => join(projectDir, ".rpiv", ".claude", "session-state.json");

// --- Test 1: bare project (no git, no prior batches) — writes valid state ----

{
  const repo = mkdtempSync(join(tmpdir(), "ssp-bare-"));
  try {
    const { stderr, status } = runHook(repo);
    assert.equal(status, 0, "bare: exit 0");
    assert.match(stderr, /Session state preserved/, "bare: confirmation on stderr");
    assert.ok(existsSync(stateFile(repo)), "bare: state file written");
    const state = JSON.parse(readFileSync(stateFile(repo), "utf-8"));
    assert.ok(!Number.isNaN(new Date(state.compactedAt).getTime()), "bare: compactedAt is a valid timestamp");
    assert.equal(state.project, repo, "bare: project recorded");
    assert.ok(state.git && typeof state.git.branch === "string", "bare: git.branch present (fallback ok)");
    assert.equal(state.agentActivity.lastBatchCount, 0, "bare: no prior batches");
    assert.deepEqual(state.agentActivity.recentFiles, [], "bare: no recent files");
    console.log("OK — bare project: valid state file written, exit 0.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: prior agent-batch state — carried into the snapshot -------------

{
  const repo = mkdtempSync(join(tmpdir(), "ssp-batch-"));
  try {
    mkdirSync(join(repo, ".rpiv", ".claude"), { recursive: true });
    writeFileSync(join(repo, ".rpiv", ".claude", "agent-batch-state.json"), JSON.stringify({
      batches: [
        { agentCount: 2, filesTouched: ["old.ts"] },
        { agentCount: 5, filesTouched: ["a.ts", "b.ts"] },
      ],
    }));
    const { status } = runHook(repo);
    assert.equal(status, 0, "batch: exit 0");
    const state = JSON.parse(readFileSync(stateFile(repo), "utf-8"));
    assert.equal(state.agentActivity.lastBatchCount, 5, "batch: last batch agentCount carried");
    assert.deepEqual(state.agentActivity.recentFiles, ["a.ts", "b.ts"], "batch: last batch files carried");
    console.log("OK — prior batch state: carried into snapshot.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: corrupt agent-batch state — ignored, still writes ---------------

{
  const repo = mkdtempSync(join(tmpdir(), "ssp-corrupt-"));
  try {
    mkdirSync(join(repo, ".rpiv", ".claude"), { recursive: true });
    writeFileSync(join(repo, ".rpiv", ".claude", "agent-batch-state.json"), "{broken");
    const { status } = runHook(repo);
    assert.equal(status, 0, "corrupt batch: exit 0");
    const state = JSON.parse(readFileSync(stateFile(repo), "utf-8"));
    assert.equal(state.agentActivity.lastBatchCount, 0, "corrupt batch: treated as none");
    console.log("OK — corrupt agent-batch state: ignored, snapshot still written.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
