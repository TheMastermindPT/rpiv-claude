// subagent-output-check.test.mjs — golden-fixture test for subagent-output-check.mjs.
// Pipes synthetic SubagentStop JSON to stdin via spawnSync and asserts output-length
// warnings, error-language detection, and structured-format checks.
//
//   node .claude/hooks/subagent-output-check.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "subagent-output-check.mjs");

const runHook = (repo, stdin) =>
  spawnSync("node", [HOOK], {
    cwd: repo, input: JSON.stringify(stdin), encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, RPIV_AGENTS_DIR: join(repo, "agents") },
  });

const mkAgent = (repo, name, effort) => {
  mkdirSync(join(repo, "agents"), { recursive: true });
  writeFileSync(join(repo, "agents", `${name}.md`), `---\neffort: ${effort}\n---\n`);
};

// --- Test 1: no agent_type — silent -----------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-noagent-"));
  try {
    const { stderr } = runHook(repo, { result: "anything" });
    assert.equal(stderr.trim(), "", "no agent_type: silent");
    console.log("OK — no agent_type: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: short output, high effort agent — warns ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-short-"));
  try {
    mkAgent(repo, "claim-verifier", "high");
    const { stderr } = runHook(repo, { agent_type: "claim-verifier", result: "ok" });
    assert.match(stderr, /WARNING: agent "claim-verifier".*suspiciously short output/);
    console.log("OK — short output, high effort: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: normal output — silent -----------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-normal-"));
  try {
    mkAgent(repo, "claim-verifier", "high");
    const { stderr } = runHook(repo, {
      agent_type: "claim-verifier",
      result: "FINDING Q1 | Verified | the code matches the claim at src/app.ts:42",
    });
    assert.equal(stderr.trim(), "", `normal output should be silent, got: ${stderr}`);
    console.log("OK — normal output: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: output contains error/fallback language — warns -----------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-errlang-"));
  try {
    mkAgent(repo, "diff-auditor", "xhigh");
    const { stderr } = runHook(repo, {
      agent_type: "diff-auditor",
      result: "I'm sorry, I cannot complete this analysis due to an error.",
    });
    assert.match(stderr, /WARNING: agent "diff-auditor" output contains.*error\/fallback/);
    console.log("OK — error language: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: "I am unable to" fallback language — warns ---------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-unable-"));
  try {
    mkAgent(repo, "codebase-analyzer", "high");
    const { stderr } = runHook(repo, {
      agent_type: "codebase-analyzer",
      result: "I am unable to analyze this file because it is too large.",
    });
    assert.match(stderr, /WARNING: agent "codebase-analyzer" output contains.*error\/fallback/);
    console.log("OK — 'I am unable to': warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: missing structured format — warns ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-nofmt-"));
  try {
    mkAgent(repo, "claim-verifier", "xhigh");
    const { stderr } = runHook(repo, {
      agent_type: "claim-verifier",
      result: "Everything looks fine to me, all findings pass verification.",
    });
    assert.match(stderr, /WARNING: agent "claim-verifier" output missing expected format: FINDING rows/);
    console.log("OK — missing structured format: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: structured format present — silent -----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-fmt-ok-"));
  try {
    mkAgent(repo, "diff-auditor", "high");
    const { stderr } = runHook(repo, {
      agent_type: "diff-auditor",
      result: "src/app.ts:42 | if (x > 0) { | Q1 | edge case missed",
    });
    assert.equal(stderr.trim(), "", `pipe-delimited format present, got: ${stderr}`);
    console.log("OK — structured format present: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: low effort, short output — exempt from length check ------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-low-ok-"));
  try {
    mkAgent(repo, "codebase-locator", "low");
    const { stderr } = runHook(repo, {
      agent_type: "codebase-locator",
      result: "x",
    });
    assert.equal(stderr.trim(), "", `low effort: exempt from length check, got: ${stderr}`);
    console.log("OK — low effort, short output: silent (exempt).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 9: empty result, high effort — warns ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-noresult-"));
  try {
    mkAgent(repo, "claim-verifier", "high");
    const { stderr } = runHook(repo, { agent_type: "claim-verifier", result: "" });
    assert.match(stderr, /WARNING: agent "claim-verifier".*suspiciously short output/);
    console.log("OK — empty result, high effort: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 11: error word deep in output body — silent (head-only scan) -------
{
  const repo = mkdtempSync(join(tmpdir(), "soc-errdeep-"));
  try {
    mkAgent(repo, "codebase-analyzer", "high");
    const padding = "### Analysis\n" + "- src/app.ts:42 traces the retry loop through the queue consumer\n".repeat(5);
    const { stderr } = runHook(repo, {
      agent_type: "codebase-analyzer",
      result: padding + "Validation errors return 401; the error handling at src/handlers/webhook.js:28 rethrows with cause.",
    });
    assert.equal(stderr.trim(), "", `error vocabulary deep in body must be silent, got: ${stderr}`);
    console.log("OK — error word deep in body: silent (head-only scan).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 12: output OPENS with failure vocabulary — warns --------------------
{
  const repo = mkdtempSync(join(tmpdir(), "soc-errhead-"));
  try {
    mkAgent(repo, "codebase-analyzer", "high");
    const { stderr } = runHook(repo, {
      agent_type: "codebase-analyzer",
      result: "Error: timeout while reading the target directory. Partial results follow.\n" + "x".repeat(40),
    });
    assert.match(stderr, /output contains.*error\/fallback/);
    console.log("OK — failure vocabulary at head: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 13: slice-verifier three-row schema present — silent ----------------
{
  const repo = mkdtempSync(join(tmpdir(), "soc-sv-ok-"));
  try {
    mkAgent(repo, "slice-verifier", "xhigh");
    const { stderr } = runHook(repo, {
      agent_type: "slice-verifier",
      result: "working notes: commitment C1 satisfied at slice 2 §1\n- Decisions: OK\n- Cross-slice: OK\n- Research: OK",
    });
    assert.equal(stderr.trim(), "", `three-row schema present: silent, got: ${stderr}`);
    console.log("OK — slice-verifier schema present: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 14: slice-verifier missing rows — warns -----------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "soc-sv-miss-"));
  try {
    mkAgent(repo, "slice-verifier", "xhigh");
    const { stderr } = runHook(repo, {
      agent_type: "slice-verifier",
      result: "The slice looks consistent with prior slices and all commitments are satisfied.",
    });
    assert.match(stderr, /missing expected format: Decisions \/ Cross-slice \/ Research rows/);
    console.log("OK — slice-verifier missing rows: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 15: diff-analyst pipe rows present — silent --------------------------
{
  const repo = mkdtempSync(join(tmpdir(), "soc-da-ok-"));
  try {
    mkAgent(repo, "diff-analyst", "high");
    const { stderr } = runHook(repo, {
      agent_type: "diff-analyst",
      result: "### src/app.ts\n| src/app.ts:42 | `if (x > 0) {` | 5 | predicate without consumer update |",
    });
    assert.equal(stderr.trim(), "", `diff-analyst rows present: silent, got: ${stderr}`);
    console.log("OK — diff-analyst rows present: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 10: non-rpiv agent — silent ---------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "soc-ext-"));
  try {
    const { stderr } = runHook(repo, {
      agent_type: "external-agent",
      result: "nothing of interest",
    });
    assert.equal(stderr.trim(), "", "external agent: silent");
    console.log("OK — non-rpiv agent: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
