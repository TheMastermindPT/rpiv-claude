// cache-sync-check.mjs — PostToolUse hook: warn when a plugin-source edit diverges from the
// installed plugin cache.
//
// Registered in the rpiv REPO's project settings (not hooks.json — this guard only matters
// when editing the plugin source itself). Headless/eval sessions and every other project load
// the plugin from ~/.claude/plugins/cache/<marketplace>/<name>/<version>/, so an edit here that
// is not synced to the cache silently tests the OLD skill (the failure class behind the
// iteration-4 handoff's "sync the cache before runs" warning).
//
// Fires after Edit / Write / MultiEdit. If the touched file is plugin source (skills/, agents/,
// hooks/, .claude/hooks/ under a repo carrying .claude-plugin/plugin.json) and its cache
// counterpart is missing or differs, prints a warning to stderr. Always exits 0 — advisory only.
//
// RPIV_CACHE_ROOT overrides cache discovery (tests point it at a fake versioned root).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

let filePath = "";
try {
  const raw = readFileSync(0, "utf-8").trim();
  if (!raw) process.exit(0);
  filePath = JSON.parse(raw).tool_input?.file_path || "";
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const manifestPath = join(PROJECT_DIR, ".claude-plugin", "plugin.json");
if (!existsSync(manifestPath)) process.exit(0);

let name = "", version = "";
try {
  ({ name, version } = JSON.parse(readFileSync(manifestPath, "utf-8")));
} catch {
  process.exit(0);
}
if (!name || !version) process.exit(0);

const rel = relative(resolve(PROJECT_DIR), resolve(filePath)).replaceAll("\\", "/");
if (rel.startsWith("..")) process.exit(0);
const PLUGIN_SOURCE = /^(skills|agents|hooks|\.claude\/hooks)\//;
if (!PLUGIN_SOURCE.test(rel)) process.exit(0);

// Locate the installed cache: ~/.claude/plugins/cache/<any marketplace>/<name>/<version>/
function findCacheRoot() {
  if (process.env.RPIV_CACHE_ROOT) return process.env.RPIV_CACHE_ROOT;
  const cacheBase = join(homedir(), ".claude", "plugins", "cache");
  if (!existsSync(cacheBase)) return null;
  for (const marketplace of readdirSync(cacheBase)) {
    const candidate = join(cacheBase, marketplace, name, version);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
const cacheRoot = findCacheRoot();
if (!cacheRoot) process.exit(0); // plugin not installed from cache on this machine — nothing to drift

const cachePath = join(cacheRoot, ...rel.split("/"));
let inSync = false;
try {
  inSync = existsSync(cachePath) && readFileSync(resolve(filePath)).equals(readFileSync(cachePath));
} catch {
  process.exit(0);
}

if (!inSync) {
  process.stderr.write(
    `[rpiv-hook] Plugin cache OUT OF SYNC for ${rel} — headless/eval sessions and other projects load the cache, not this repo. Sync before any run: copy the file to ${cachePath.replaceAll(sep, "/")}\n`,
  );
}
process.exit(0);
