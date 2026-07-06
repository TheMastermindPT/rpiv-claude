// enforce-readonly-agent.test.mjs — golden-fixture test for enforce-readonly-agent.mjs.
// Builds a throwaway plugin root with agent .md files in various permission states and
// asserts the hook's deny/allow decisions in stdout JSON and warnings on stderr.
//
//   node .claude/hooks/enforce-readonly-agent.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "enforce-readonly-agent.mjs");

const runHook = (repo, stdin) => {
  const { stdout, stderr } = spawnSync("node", [HOOK], {
    cwd: repo, input: JSON.stringify(stdin), encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, RPIV_AGENTS_DIR: join(repo, "agents") },
  });
  const decision = stdout.trim() ? JSON.parse(stdout.trim()) : null;
  return { decision, stderr };
};

const mkAgent = (repo, name, tools) => {
  mkdirSync(join(repo, "agents"), { recursive: true });
  writeFileSync(join(repo, "agents", `${name}.md`), `---\ntools: ${tools}\n---\n`);
};

// --- Test 1: main session (no agent_type) — allow everything -----------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-main-"));
  try {
    const { decision, stderr } = runHook(repo, { tool_name: "Write" });
    assert.equal(decision, null, "main session: no deny decision");
    assert.equal(stderr.trim(), "", "main session: no stderr");
    console.log("OK — main session: allows everything.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: Write allowed — agent has Write in tools ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-write-ok-"));
  try {
    mkAgent(repo, "test-agent", "Read, Write");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.equal(decision, null, "write-allowed: no deny");
    console.log("OK — Write allowed: agent has Write tool.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: Write blocked — agent is read-only -----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-write-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.ok(decision, "write-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /"Write" blocked: agent "test-agent" is read-only/);
    console.log("OK — Write blocked: agent is read-only.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: Edit blocked — agent is read-only ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-edit-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read, Glob");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Edit" });
    assert.ok(decision, "edit-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /"Edit" blocked: agent "test-agent" is read-only/);
    console.log("OK — Edit blocked: agent is read-only.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: Bash blocked — agent doesn't allow Bash ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Bash", tool_input: { command: "ls" } });
    assert.ok(decision, "bash-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Bash blocked: agent "test-agent" does not allow Bash/);
    console.log("OK — Bash blocked: agent has no Bash tool.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: Bash allowed, destructive command — warns, no deny --------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-warn-"));
  try {
    mkAgent(repo, "test-agent", "Read, Bash");
    const { decision, stderr } = runHook(repo, {
      agent_type: "test-agent", tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/scratch" },
    });
    assert.equal(decision, null, "destructive command: no deny — agent has Bash");
    assert.match(stderr, /WARNING: agent "test-agent" running potentially destructive Bash/);
    console.log("OK — Bash allowed, destructive: warns, no deny.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: Bash allowed, safe command — silent ----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-ok-"));
  try {
    mkAgent(repo, "test-agent", "Read, Bash");
    const { decision, stderr } = runHook(repo, {
      agent_type: "test-agent", tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    assert.equal(decision, null, "safe bash: no deny");
    assert.equal(stderr.trim(), "", `safe bash: no warning, got: ${stderr}`);
    console.log("OK — Bash allowed, safe command: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: non-rpiv agent — allow everything ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-ext-"));
  try {
    const { decision, stderr } = runHook(repo, { agent_type: "external-agent", tool_name: "Write" });
    assert.equal(decision, null, "external agent: no deny");
    assert.equal(stderr.trim(), "", "external agent: silent");
    console.log("OK — non-rpiv agent: allows everything.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 9: empty stdin — silent exit --------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-empty-"));
  try {
    const { stdout, stderr } = spawnSync("node", [HOOK], {
      cwd: repo, input: "", encoding: "utf-8", stdio: "pipe",
    });
    assert.equal(stdout.trim(), "", "empty stdin: no stdout");
    assert.equal(stderr.trim(), "", "empty stdin: no stderr");
    console.log("OK — empty stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 10: tools field empty — treated as no tools -----------------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-notools-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\n---\n`); // no tools field
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.ok(decision, "no tools: must deny Write");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    console.log("OK — no tools field: Write denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
