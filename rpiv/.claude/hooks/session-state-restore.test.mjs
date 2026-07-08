// session-state-restore.test.mjs — golden-fixture test for session-state-restore.mjs.
// Points CLAUDE_PROJECT_DIR at a throwaway dir and asserts the restored-context
// summary on stdout (SessionStart(compact) contract: stdout reaches the model),
// plus silent handling of missing/corrupt state.
//
//   node .claude/hooks/session-state-restore.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "session-state-restore.mjs");

const runHook = (projectDir) =>
  spawnSync("node", [HOOK], {
    cwd: projectDir, input: "{}", encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });

const writeState = (projectDir, state) => {
  mkdirSync(join(projectDir, ".rpiv", ".claude"), { recursive: true });
  writeFileSync(
    join(projectDir, ".rpiv", ".claude", "session-state.json"),
    typeof state === "string" ? state : JSON.stringify(state, null, 2),
  );
};

// --- Test 1: no state file — quiet no-op --------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "ssr-none-"));
  try {
    const { stdout, stderr, status } = runHook(repo);
    assert.equal(status, 0, "none: exit 0");
    assert.equal(stdout.trim(), "", "none: nothing injected into context");
    assert.match(stderr, /No preserved session state/, "none: note on stderr");
    console.log("OK — missing state file: quiet no-op.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: valid state — summary printed to stdout --------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "ssr-ok-"));
  try {
    writeState(repo, {
      compactedAt: new Date().toISOString(),
      project: repo,
      git: { branch: "feat/x", commit: "abc1234", root: repo },
      agentActivity: { lastBatchCount: 2, recentFiles: ["x.ts", "y.ts"] },
    });
    const { stdout, status } = runHook(repo);
    assert.equal(status, 0, "ok: exit 0");
    assert.match(stdout, /\[rpiv\] Session restored \(compacted just now\)/, "ok: banner with age");
    assert.match(stdout, /Branch: {2}feat\/x/, "ok: branch restored");
    assert.match(stdout, /Commit: {2}abc1234/, "ok: commit restored");
    assert.match(stdout, /Recent files \(2\):/, "ok: recent files header");
    assert.match(stdout, /- x\.ts/, "ok: recent file listed");
    console.log("OK — valid state: summary printed to stdout for context injection.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: corrupt state file — quiet no-op ----------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "ssr-corrupt-"));
  try {
    writeState(repo, "{broken json");
    const { stdout, stderr, status } = runHook(repo);
    assert.equal(status, 0, "corrupt: exit 0");
    assert.equal(stdout.trim(), "", "corrupt: nothing injected");
    assert.match(stderr, /Corrupt session state/, "corrupt: note on stderr");
    console.log("OK — corrupt state file: quiet no-op.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: missing recentFiles — summary still prints, no file section ------

{
  const repo = mkdtempSync(join(tmpdir(), "ssr-nofiles-"));
  try {
    writeState(repo, {
      compactedAt: new Date().toISOString(),
      project: repo,
      git: { branch: "main", commit: "def5678", root: repo },
      agentActivity: {},
    });
    const { stdout, status } = runHook(repo);
    assert.equal(status, 0, "nofiles: exit 0");
    assert.match(stdout, /Session restored/, "nofiles: banner present");
    assert.doesNotMatch(stdout, /Recent files/, "nofiles: no file section");
    console.log("OK — no recent files: summary without file section.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
