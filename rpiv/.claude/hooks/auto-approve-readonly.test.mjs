// auto-approve-readonly.test.mjs — golden-fixture test for auto-approve-readonly.mjs.
// Spawns the hook with PermissionRequest stdin fixtures against a throwaway agents
// dir (RPIV_AGENTS_DIR) and asserts the allow decision shape and silent exits.
//
//   node .claude/hooks/auto-approve-readonly.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "auto-approve-readonly.mjs");

const runHook = (repo, stdin) => {
  const { stdout, stderr, status } = spawnSync("node", [HOOK], {
    cwd: repo,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, RPIV_AGENTS_DIR: join(repo, "agents") },
  });
  const decision = stdout.trim() ? JSON.parse(stdout.trim()) : null;
  return { decision, stderr, status };
};

const mkAgent = (repo, name) => {
  mkdirSync(join(repo, "agents"), { recursive: true });
  writeFileSync(join(repo, "agents", `${name}.md`), `---\ntools: Read, Grep, Glob\n---\n`);
};

const assertAllow = (decision, label) => {
  assert.ok(decision, `${label}: must return a decision`);
  assert.equal(decision.hookSpecificOutput.hookEventName, "PermissionRequest", `${label}: event name`);
  assert.equal(decision.hookSpecificOutput.decision.behavior, "allow", `${label}: behavior allow`);
};

// --- Test 1: main session (no agent_type) — no decision ----------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-main-"));
  try {
    const { decision, stderr } = runHook(repo, { tool_name: "Read" });
    assert.equal(decision, null, "main session: no decision");
    assert.equal(stderr.trim(), "", "main session: no stderr");
    console.log("OK — main session: no decision, normal flow.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: rpiv agent + built-in read-only tool — allow --------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-read-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Read" });
    assertAllow(decision, "builtin read");
    console.log("OK — rpiv agent + Read: allow (decision.behavior).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: rpiv agent + plugin-scoped ctx_search — allow -------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-ctx-plugin-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, {
      agent_type: "test-agent",
      tool_name: "mcp__plugin_context-mode_context-mode__ctx_search",
    });
    assertAllow(decision, "plugin-scoped ctx_search");
    console.log("OK — plugin-scoped ctx_search: allow.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: rpiv agent + direct-server ctx_execute_file — allow -------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-ctx-direct-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, {
      agent_type: "test-agent",
      tool_name: "mcp__context-mode__ctx_execute_file",
    });
    assertAllow(decision, "direct ctx_execute_file");
    console.log("OK — direct-server ctx_execute_file: allow.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: rpiv agent + mutation tool — no decision ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-write-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.equal(decision, null, "Write: no decision — normal flow");
    console.log("OK — rpiv agent + Write: no decision.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: non-mcp tool that merely ends in a readonly name — no decision --

{
  const repo = mkdtempSync(join(tmpdir(), "aar-imposter-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "NotRead" });
    assert.equal(decision, null, "imposter tool: no decision");
    console.log("OK — non-readonly tool name: no decision.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: unknown agent (no definition file) — no decision ----------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-ext-"));
  try {
    const { decision } = runHook(repo, { agent_type: "external-agent", tool_name: "Read" });
    assert.equal(decision, null, "unknown agent: no decision");
    console.log("OK — non-rpiv agent: no decision.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: empty stdin — silent exit ---------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-empty-"));
  try {
    const { decision, stderr, status } = runHook(repo, "");
    assert.equal(decision, null, "empty stdin: no stdout");
    assert.equal(stderr.trim(), "", "empty stdin: no stderr");
    assert.equal(status, 0, "empty stdin: exit 0");
    console.log("OK — empty stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 9: invalid JSON stdin — silent exit --------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "aar-badjson-"));
  try {
    const { decision, status } = runHook(repo, "{not json");
    assert.equal(decision, null, "invalid stdin: no stdout");
    assert.equal(status, 0, "invalid stdin: exit 0");
    console.log("OK — invalid stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 11: spoofed MCP server — a foreign ctx_search must NOT auto-approve ---

{
  const repo = mkdtempSync(join(tmpdir(), "aar-spoof-"));
  try {
    mkAgent(repo, "test-agent");
    const { decision } = runHook(repo, {
      agent_type: "test-agent",
      tool_name: "mcp__evilserver__ctx_search",
    });
    assert.equal(decision, null, "spoofed mcp server ctx_search: no auto-approval");
    console.log("OK — spoofed MCP server ctx_search: not auto-approved (exact-match only).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 10: traversal agent_type — no auto-approval even if target .md exists ---

{
  const repo = mkdtempSync(join(tmpdir(), "aar-traversal-"));
  try {
    mkAgent(repo, "test-agent");
    // A real .md one level above the agents dir that a traversal would resolve to.
    writeFileSync(join(repo, "sibling.md"), `---\ntools: Read\n---\n`);
    const { decision } = runHook(repo, {
      agent_type: "../sibling",
      tool_name: "Read",
    });
    assert.equal(decision, null, "traversal agent_type: no auto-approval");
    console.log("OK — traversal agent_type: declines to auto-approve (fail-safe).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
