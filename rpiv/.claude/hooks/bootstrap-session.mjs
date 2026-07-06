// bootstrap-session.mjs — SessionStart hook for rpiv.
//
// Runs git-context.mjs and now.mjs once at session start so skills don't
// need to inline this boilerplate. Output goes to stdout for Claude to see.
// Always exits 0 — failures are non-blocking.

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shared = join(__dirname, "..", "..", "skills", "_shared");

function run(script) {
  try {
    return execFileSync("node", [script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return `[rpiv] ${script} unavailable`;
  }
}

const now = run(join(shared, "now.mjs"));
const git = run(join(shared, "git-context.mjs"));

process.stdout.write(`${now}\n${git}\n`);
process.exit(0);
