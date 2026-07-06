// validate-agent-model.test.mjs — golden-fixture test for validate-agent-model.mjs.
// Builds a throwaway plugin root with agent .md files in various states (missing model,
// missing effort, alignment mismatches, over-provisioning) and asserts hook stderr output.
//
//   node .claude/hooks/validate-agent-model.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "validate-agent-model.mjs");

const runHook = (repo, stdin) =>
  spawnSync("node", [HOOK], {
    cwd: repo, input: JSON.stringify(stdin), encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, RPIV_AGENTS_DIR: join(repo, "agents") },
  });

// --- Test 1: no agent_type — exits silently ---------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-none-"));
  try {
    const { stderr } = runHook(repo, {});
    assert.equal(stderr.trim(), "", "no agent_type: no stderr");
    console.log("OK — no agent_type: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: missing model — warns ------------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-nomodel-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\neffort: high\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.match(stderr, /WARNING: agent "test-agent" has no 'model' field/);
    console.log("OK — missing model: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: model present, no effort — notes --------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-noeff-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: sonnet\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.match(stderr, /NOTE: agent "test-agent" has model "sonnet" but no 'effort' field/);
    console.log("OK — no effort: notes.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: low effort + haiku — silent (valid) ----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-low-ok-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: haiku\neffort: low\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.equal(stderr.trim(), "", `low+haiku should be silent, got: ${stderr}`);
    console.log("OK — low effort + haiku: silent (valid).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: high effort + haiku — warns (under-provisioned) -----------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-under-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: haiku\neffort: high\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.match(stderr, /WARNING: agent "test-agent" has model "haiku".*expects sonnet or opus/);
    console.log("OK — high effort + haiku: warns (under-provisioned).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: xhigh + opus — silent (valid) ----------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-xhi-ok-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: opus\neffort: xhigh\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.equal(stderr.trim(), "", `xhigh+opus should be silent, got: ${stderr}`);
    console.log("OK — xhigh effort + opus: silent (valid).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: low effort + opus — notes (over-provisioned) -------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-over-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: opus\neffort: low\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.match(stderr, /NOTE: agent "test-agent" has effort "low" but model "opus".*Consider downgrading/);
    console.log("OK — low effort + opus: notes (over-provisioned).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: not an rpiv agent (no agents dir) — silent ---------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-norpiv-"));
  try {
    const { stderr } = runHook(repo, { agent_type: "external-agent" });
    assert.equal(stderr.trim(), "", "non-rpiv agent: silent");
    console.log("OK — non-rpiv agent: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 9: medium effort + sonnet — silent (valid) ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-med-ok-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\nmodel: sonnet\neffort: medium\n---\n`);
    const { stderr } = runHook(repo, { agent_type: "test-agent" });
    assert.equal(stderr.trim(), "", `medium+sonnet should be silent, got: ${stderr}`);
    console.log("OK — medium effort + sonnet: silent (valid).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 10: stdin parse failure — silent ----------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vam-badstdin-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    const { stderr } = runHook(repo, {}); // empty input (no JSON) — hook's readFileSync(0) gets ""
    assert.equal(stderr.trim(), "", "bad stdin: silent exit");
    console.log("OK — invalid stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
