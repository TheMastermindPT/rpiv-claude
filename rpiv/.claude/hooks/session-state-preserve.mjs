// session-state-preserve.mjs — PreCompact hook for rpiv.
//
// Before context compaction, serializes the current rpiv session context
// to a state file so PostCompact can re-inject it. Captures:
//   - Current working directory / project root
//   - Git context
//   - Timestamp
//
// State file: <project>/.rpiv/.claude/session-state.json
// Non-blocking — always exits 0.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(PROJECT_DIR, ".rpiv", ".claude");
const STATE_FILE = join(STATE_DIR, "session-state.json");

function safeGit(args, fb = "") {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      cwd: PROJECT_DIR,
    }).trim();
  } catch {
    return fb;
  }
}

function main() {
  mkdirSync(STATE_DIR, { recursive: true });

  const state = {
    compactedAt: new Date().toISOString(),
    project: PROJECT_DIR,
    git: {
      branch: safeGit(["branch", "--show-current"], "unknown"),
      commit: safeGit(["rev-parse", "--short", "HEAD"], "unknown"),
      root: safeGit(["rev-parse", "--show-toplevel"], PROJECT_DIR),
    },
  };

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  process.stderr.write(`[rpiv-hook] Session state preserved (${state.git.commit}).\n`);
  process.exit(0);
}

main();
