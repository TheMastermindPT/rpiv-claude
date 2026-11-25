// session-state-preserve.test.mjs — golden-fixture test for session-state-preserve.mjs.
// Points CLAUDE_PROJECT_DIR at a throwaway dir and asserts the state file shape
// and non-blocking exit.
//
//   node .claude/hooks/session-state-preserve.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

// --- Test 1: bare project (no git) — writes valid state ----

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
    assert.equal("agentActivity" in state, false, "bare: no agent-activity block");
    console.log("OK — bare project: valid state file written, exit 0.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
