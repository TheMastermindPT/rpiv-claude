// cache-sync-check.test.mjs — golden tests for the plugin-cache drift warning hook.
// Builds a throwaway plugin repo + fake cache root, feeds PostToolUse JSON on stdin, and
// asserts the warning fires exactly when a plugin-source file diverges from its cache copy.
// Prints "OK".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "cache-sync-check.mjs");

function runHook(filePath, projectDir, cacheRoot) {
  const res = spawnSync("node", [SCRIPT], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, RPIV_CACHE_ROOT: cacheRoot ?? "" },
  });
  assert.equal(res.status, 0, `hook always exits 0: ${res.stderr}`);
  return res.stderr;
}

const tmp = mkdtempSync(join(tmpdir(), "cache-sync-"));
try {
  const repo = join(tmp, "repo");
  const cache = join(tmp, "cache", "rpiv-local", "rpiv", "9.9.9");
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rpiv", version: "9.9.9" }));
  mkdirSync(join(repo, "skills", "demo"), { recursive: true });
  mkdirSync(join(cache, "skills", "demo"), { recursive: true });
  writeFileSync(join(repo, "skills", "demo", "SKILL.md"), "same content\n");
  writeFileSync(join(cache, "skills", "demo", "SKILL.md"), "same content\n");

  // in sync -> silent
  assert.equal(runHook(join(repo, "skills", "demo", "SKILL.md"), repo, cache), "", "in-sync file is silent");

  // cache diverges -> warning names the file and the cache path
  writeFileSync(join(cache, "skills", "demo", "SKILL.md"), "OLD content\n");
  const warn = runHook(join(repo, "skills", "demo", "SKILL.md"), repo, cache);
  assert.match(warn, /OUT OF SYNC for skills\/demo\/SKILL\.md/, `warning fires on drift: ${warn}`);

  // missing in cache entirely -> warning (a new file was added but never synced)
  writeFileSync(join(repo, "skills", "demo", "new-ref.md"), "brand new\n");
  assert.match(runHook(join(repo, "skills", "demo", "new-ref.md"), repo, cache), /OUT OF SYNC/, "cache-missing file warns");

  // non-plugin-source path -> silent even when it has no cache counterpart
  writeFileSync(join(repo, "README.md"), "readme\n");
  assert.equal(runHook(join(repo, "README.md"), repo, cache), "", "non-plugin-source path is silent");

  // repo without a plugin manifest -> silent (hook is a no-op outside plugin repos)
  const plain = join(tmp, "plain");
  mkdirSync(join(plain, "skills"), { recursive: true });
  writeFileSync(join(plain, "skills", "x.md"), "x\n");
  assert.equal(runHook(join(plain, "skills", "x.md"), plain, cache), "", "non-plugin repo is silent");

  console.log("OK (cache-sync-check) — drift warning, cache-missing, scope + manifest gating.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
