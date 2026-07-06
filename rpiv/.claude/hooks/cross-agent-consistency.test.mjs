// cross-agent-consistency.test.mjs — golden-fixture test for cross-agent-consistency.mjs.
// Pipes synthetic PostToolBatch JSON to stdin via spawnSync and asserts conflict detection,
// overlap notes, and state file persistence.
//
//   node .claude/hooks/cross-agent-consistency.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "cross-agent-consistency.mjs");

const runInRepo = (repo, stdin) =>
  spawnSync("node", [HOOK], {
    cwd: repo, input: JSON.stringify(stdin), encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });

// --- Test 1: fewer than 2 agent results — silent ----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-solo-"));
  try {
    const { stderr } = runInRepo(repo, {
      tool_calls: [{ tool_name: "Agent", agent_type: "diff-auditor", result: "everything ok" }],
    });
    assert.equal(stderr.trim(), "", "solo agent: silent");
    console.log("OK — < 2 agent results: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: two agents on same file, same verdict — no conflict -------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-same-"));
  try {
    const { stderr } = runInRepo(repo, {
      tool_calls: [
        { tool_name: "Agent", agent_type: "diff-auditor", result: "lib/foo.ts is clean and verified" },
        { tool_name: "Agent", agent_type: "codebase-analyzer", result: "lib/foo.ts looks good" },
      ],
    });
    assert.ok(!/WARNING: cross-agent conflicts/.test(stderr), `same verdict: no conflict warning, got: ${stderr}`);
    console.log("OK — same file, same verdict: no conflict.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: opposing verdicts on same file — conflict -----------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-conflict-"));
  try {
    const { stderr } = runInRepo(repo, {
      tool_calls: [
        { tool_name: "Agent", agent_type: "diff-auditor", result: "src/utils.ts is clean" },
        { tool_name: "Agent", agent_type: "codebase-analyzer", result: "src/utils.ts has a critical blocker" },
      ],
    });
    assert.match(stderr, /WARNING: cross-agent conflict:.*disagree \(good vs bad\)/);
    console.log("OK — opposing verdicts: conflict detected.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: three agents on same file — overlap note ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-overlap-"));
  try {
    const { stderr } = runInRepo(repo, {
      tool_calls: [
        { tool_name: "Agent", agent_type: "diff-auditor", result: "app/page.tsx is clean" },
        { tool_name: "Agent", agent_type: "codebase-analyzer", result: "app/page.tsx is clean" },
        { tool_name: "Agent", agent_type: "peer-comparator", result: "app/page.tsx is clean" },
      ],
    });
    assert.match(stderr, /NOTE: 3 agents.*all report on "app\/page\.tsx"/);
    assert.ok(!/WARNING: cross-agent conflicts/.test(stderr), "all-clean should not flag conflict");
    console.log("OK — 3 agents on same file: overlap note, no conflict.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: state file persisted -------------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-state-"));
  try {
    runInRepo(repo, {
      tool_calls: [
        { tool_name: "Agent", agent_type: "diff-auditor", result: "lib/bar.ts is clean" },
        { tool_name: "Agent", agent_type: "codebase-analyzer", result: "lib/bar.ts is clean" },
      ],
    });
    const stateFile = join(repo, ".rpiv", ".claude", "agent-batch-state.json");
    assert.ok(existsSync(stateFile), "state file must exist after run");
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.ok(Array.isArray(state.batches), "batches must be an array");
    assert.equal(state.batches.length, 1, "one batch recorded");
    assert.equal(state.batches[0].agentCount, 2, "agentCount matches");
    console.log("OK — state file persisted with correct batch data.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: state file pruned to last 10 batches ---------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-prune-"));
  try {
    for (let i = 0; i < 12; i += 1) {
      runInRepo(repo, {
        tool_calls: [
          { tool_name: "Agent", agent_type: "diff-auditor", result: `lib/run${i}.ts is clean` },
          { tool_name: "Agent", agent_type: "codebase-analyzer", result: `lib/run${i}.ts is clean` },
        ],
      });
    }
    const stateFile = join(repo, ".rpiv", ".claude", "agent-batch-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert.equal(state.batches.length, 10, "pruned to 10 batches");
    const tss = state.batches.map((b) => new Date(b.ts).getTime());
    assert.ok(tss.every((t, i) => i === 0 || t >= tss[i - 1]), "batches are chronological");
    console.log("OK — state file pruned to last 10 batches.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: empty tool_calls array — silent ---------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-empty-"));
  try {
    const { stderr } = runInRepo(repo, { tool_calls: [] });
    assert.equal(stderr.trim(), "", "empty calls: silent");
    console.log("OK — empty tool_calls: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: no file references in any result — silent ----------------------

{
  const repo = mkdtempSync(join(tmpdir(), "cac-nofiles-"));
  try {
    const { stderr } = runInRepo(repo, {
      tool_calls: [
        { tool_name: "Agent", agent_type: "diff-auditor", result: "everything is fine" },
        { tool_name: "Agent", agent_type: "codebase-analyzer", result: "no issues found" },
      ],
    });
    assert.equal(stderr.trim(), "", "no file refs: silent");
    console.log("OK — no file references: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
