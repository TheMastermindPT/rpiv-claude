// session-state-preserve.mjs — PreCompact hook for rpiv.
//
// Before context compaction, serializes the current rpiv session context
// to a state file so PostCompact can re-inject it. Captures:
//   - Active skill (inferred from recent agent dispatches and artifact writes)
//   - Current working directory / project root
//   - Git context
//   - Recent agent activity
//   - Timestamp
//
// State file: <project>/.rpiv/.claude/session-state.json
// Non-blocking — always exits 0.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = join(PROJECT_DIR, ".rpiv", ".claude");
const STATE_FILE = join(STATE_DIR, "session-state.json");
const AGENT_STATE_FILE = join(STATE_DIR, "agent-batch-state.json");

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

  // Load prior agent batch state for continuity
  let priorBatches = [];
  try {
    priorBatches = JSON.parse(readFileSync(AGENT_STATE_FILE, "utf-8")).batches || [];
  } catch { /* ok */ }

  const state = {
    compactedAt: new Date().toISOString(),
    project: PROJECT_DIR,
    git: {
      branch: safeGit(["branch", "--show-current"], "unknown"),
      commit: safeGit(["rev-parse", "--short", "HEAD"], "unknown"),
      root: safeGit(["rev-parse", "--show-toplevel"], PROJECT_DIR),
    },
    agentActivity: {
      lastBatchCount: priorBatches.length > 0
        ? priorBatches[priorBatches.length - 1].agentCount
        : 0,
      recentFiles: priorBatches.length > 0
        ? priorBatches[priorBatches.length - 1].filesTouched || []
        : [],
    },
  };

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  process.stderr.write(`[rpiv-hook] Session state preserved (${state.git.commit}).\n`);
  process.exit(0);
}

main();
