// session-state-restore.mjs — PostCompact hook for rpiv.
//
// After context compaction, reads the preserved session state and prints
// a concise summary to stdout so Claude can pick up where it left off.
// Always exits 0 — missing state is not an error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

  process.stdout.write(`\
[rpiv] Session restored (compacted ${ageStr})
  Branch:  ${state.git?.branch || "unknown"}
  Commit:  ${state.git?.commit || "unknown"}
  Project: ${state.project || PROJECT_DIR}
`);

  if (state.agentActivity?.recentFiles?.length > 0) {
    process.stdout.write(`  Recent files (${state.agentActivity.recentFiles.length}):\n`);
    for (const f of state.agentActivity.recentFiles.slice(0, 8)) {
      process.stdout.write(`    - ${f}\n`);
    }
  }

  process.stdout.write("\n");
  process.exit(0);
}

main();
