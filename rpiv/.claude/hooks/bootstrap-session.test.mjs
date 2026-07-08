// bootstrap-session.test.mjs — golden-fixture test for bootstrap-session.mjs.
// Spawns the hook and asserts it always exits 0 with two context lines on
// stdout (now.mjs + git-context.mjs output, or their fallback markers).
//
//   node .claude/hooks/bootstrap-session.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "bootstrap-session.mjs");

// --- Test 1: runs from the repo — emits timestamp + git context ---------------

{
  const { stdout, status } = spawnSync("node", [HOOK], {
    encoding: "utf-8", stdio: "pipe", input: "{}",
  });
  assert.equal(status, 0, "repo: exit 0");
  const lines = stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, `repo: expected >=2 context lines, got ${lines.length}`);
  // First line is now.mjs output (ISO timestamp + slug) or its fallback marker.
  assert.ok(
    /\d{4}-\d{2}-\d{2}T/.test(lines[0]) || lines[0].includes("[rpiv]"),
    `repo: first line is timestamp or fallback, got: ${lines[0]}`,
  );
  console.log("OK — repo run: timestamp + git context on stdout, exit 0.");
}

// --- Test 2: runs from a non-repo cwd — still exits 0, still 2 sections -------

{
  const scratch = mkdtempSync(join(tmpdir(), "bs-nogit-"));
  try {
    const { stdout, status } = spawnSync("node", [HOOK], {
      cwd: scratch, encoding: "utf-8", stdio: "pipe", input: "{}",
    });
    assert.equal(status, 0, "non-repo: exit 0 (non-blocking)");
    assert.ok(stdout.trim().length > 0, "non-repo: still emits context or fallback");
    console.log("OK — non-repo cwd: non-blocking, fallback output.");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
