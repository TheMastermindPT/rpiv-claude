// validate-on-write.test.mjs — golden-fixture test for validate-on-write.mjs.
// Spawns the hook with PostToolUse stdin fixtures and a stub validator
// (RPIV_VALIDATOR) and asserts scope-gating plus warning passthrough.
//
//   node .claude/hooks/validate-on-write.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "validate-on-write.mjs");

const mkValidator = (repo, body) => {
  const p = join(repo, "stub-validator.mjs");
  writeFileSync(p, body);
  return p;
};

const runHook = (repo, stdin, validator) => {
  // Pin the project root to this test's temp repo so the containment check is
  // deterministic regardless of any ambient CLAUDE_PROJECT_DIR.
  const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
  if (validator) env.RPIV_VALIDATOR = validator;
  const { stdout, stderr, status } = spawnSync("node", [HOOK], {
    cwd: repo,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf-8", stdio: "pipe", env,
  });
  return { stdout, stderr, status };
};

const artifactPath = (repo) => join(repo, ".rpiv", "artifacts", "reviews", "t.md");

// --- Test 1: non-artifact Write — silent exit --------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-scope-"));
  try {
    const explode = mkValidator(repo, `process.stderr.write("must not run\\n"); process.exit(1);\n`);
    const { stderr, status } = runHook(repo, {
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "notes.md") },
    }, explode);
    assert.equal(status, 0, "non-artifact: exit 0");
    assert.equal(stderr.trim(), "", "non-artifact: validator must not run");
    console.log("OK — non-artifact path: silent, validator not invoked.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: artifact Write, validation passes — silent ----------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-pass-"));
  try {
    mkdirSync(dirname(artifactPath(repo)), { recursive: true });
    writeFileSync(artifactPath(repo), "---\nstatus: ready\n---\n");
    const ok = mkValidator(repo, `process.exit(0);\n`);
    const { stderr, status } = runHook(repo, {
      tool_name: "Write",
      tool_input: { file_path: artifactPath(repo) },
    }, ok);
    assert.equal(status, 0, "pass: exit 0");
    assert.equal(stderr.trim(), "", "pass: no warnings");
    console.log("OK — artifact validated clean: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2b: artifact Edit (not Write) is validated too ---------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-edit-"));
  try {
    mkdirSync(dirname(artifactPath(repo)), { recursive: true });
    writeFileSync(artifactPath(repo), "no frontmatter\n");
    const bad = mkValidator(repo, `process.stderr.write("lint: bad\\n"); process.exit(1);\n`);
    // An Edit tool call carries tool_input.file_path just like Write; the hook must
    // validate it (the finalization status flip is an Edit, not a Write).
    const { stderr, status } = runHook(repo, {
      tool_name: "Edit",
      tool_input: { file_path: artifactPath(repo), old_string: "x", new_string: "y" },
    }, bad);
    assert.equal(status, 0, "edit: exit 0");
    assert.match(stderr, /\[rpiv-hook\] Artifact validation warnings/, "edit: hook validated the artifact");
    console.log("OK — artifact Edit is validated (matcher covers Edit, not just Write).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: artifact Write, validation fails — warns to stderr, exit 0 ------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-warn-"));
  try {
    mkdirSync(dirname(artifactPath(repo)), { recursive: true });
    writeFileSync(artifactPath(repo), "no frontmatter\n");
    const bad = mkValidator(repo, `process.stderr.write("lint: missing frontmatter\\n"); process.exit(1);\n`);
    const { stderr, status } = runHook(repo, {
      tool_name: "Write",
      tool_input: { file_path: artifactPath(repo) },
    }, bad);
    assert.equal(status, 0, "warn: still exit 0 (advisory)");
    assert.match(stderr, /\[rpiv-hook\] Artifact validation warnings/, "warn: hook banner");
    assert.match(stderr, /lint: missing frontmatter/, "warn: validator stderr passed through");
    console.log("OK — artifact validation warnings surface on stderr, non-blocking.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: artifact path but not .md — silent ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-ext-"));
  try {
    const explode = mkValidator(repo, `process.stderr.write("must not run\\n"); process.exit(1);\n`);
    const { stderr, status } = runHook(repo, {
      tool_name: "Write",
      tool_input: { file_path: join(repo, ".rpiv", "artifacts", "data.json") },
    }, explode);
    assert.equal(status, 0, "non-md: exit 0");
    assert.equal(stderr.trim(), "", "non-md: validator must not run");
    console.log("OK — non-.md artifact: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: stdin without tool_input.file_path — silent ---------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-nopath-"));
  try {
    const { stderr, status } = runHook(repo, { tool_name: "Write", tool_input: {} });
    assert.equal(status, 0, "no path: exit 0");
    assert.equal(stderr.trim(), "", "no path: silent");
    console.log("OK — missing tool_input.file_path: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: artifact path OUTSIDE the project — rejected (no substring bypass) ---

{
  const repo = mkdtempSync(join(tmpdir(), "vow-outside-"));
  const foreign = mkdtempSync(join(tmpdir(), "vow-foreign-"));
  try {
    const explode = mkValidator(repo, `process.stderr.write("must not run\\n"); process.exit(1);\n`);
    // A path that CONTAINS ".rpiv/artifacts/" but lives outside the project root.
    const outside = join(foreign, ".rpiv", "artifacts", "reviews", "evil.md");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "---\nstatus: ready\n---\n");
    const env = { ...process.env, RPIV_VALIDATOR: explode, CLAUDE_PROJECT_DIR: repo };
    const { stderr, status } = spawnSync("node", [HOOK], {
      cwd: repo, input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: outside } }),
      encoding: "utf-8", stdio: "pipe", env,
    });
    assert.equal(status, 0, "outside project: exit 0");
    assert.equal(stderr.trim(), "", "outside project: validator must not run");
    console.log("OK — path outside project .rpiv/artifacts: rejected (containment check).");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
}

// --- Test 6: empty stdin — silent exit ----------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "vow-empty-"));
  try {
    const { stdout, stderr, status } = runHook(repo, "");
    assert.equal(status, 0, "empty stdin: exit 0");
    assert.equal(stdout.trim(), "", "empty stdin: no stdout");
    assert.equal(stderr.trim(), "", "empty stdin: no stderr");
    console.log("OK — empty stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
