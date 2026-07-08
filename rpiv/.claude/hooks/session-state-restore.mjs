// session-state-restore.mjs — SessionStart(matcher: compact) hook for rpiv.
//
// After context compaction, reads the preserved session state and prints
// a concise summary to stdout so Claude can pick up where it left off.
// Registered on SessionStart with the "compact" matcher because SessionStart
// stdout is added to Claude's context; PostCompact stdout is not (the hooks
// reference classifies PostCompact as side-effects-only).
// Always exits 0 — missing state is not an error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sanitizeForContext } from "./_shared.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_FILE = join(PROJECT_DIR, ".rpiv", ".claude", "session-state.json");

function main() {
  if (!existsSync(STATE_FILE)) {
    process.stderr.write("[rpiv-hook] No preserved session state found.\n");
    process.exit(0);
    return;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    process.stderr.write("[rpiv-hook] Corrupt session state file.\n");
    process.exit(0);
    return;
  }

  const age = Date.now() - new Date(state.compactedAt).getTime();
  const ageStr = age < 60000 ? "just now"
    : age < 3600000 ? `${Math.round(age / 60000)}m ago`
    : `${Math.round(age / 3600000)}h ago`;

  // Values below come from git output and agent-extracted paths persisted to the state
  // file; they land in Claude's context via SessionStart stdout, so sanitize each one so a
  // hostile branch name or crafted state file cannot inject newlines/instructions.
  process.stdout.write(`\
[rpiv] Session restored (compacted ${ageStr})
  Branch:  ${sanitizeForContext(state.git?.branch || "unknown")}
  Commit:  ${sanitizeForContext(state.git?.commit || "unknown")}
  Project: ${sanitizeForContext(state.project || PROJECT_DIR)}
`);

  if (state.agentActivity?.recentFiles?.length > 0) {
    process.stdout.write(`  Recent files (${state.agentActivity.recentFiles.length}):\n`);
    for (const f of state.agentActivity.recentFiles.slice(0, 8)) {
      process.stdout.write(`    - ${sanitizeForContext(f)}\n`);
    }
  }

  process.stdout.write("\n");
  process.exit(0);
}

main();
