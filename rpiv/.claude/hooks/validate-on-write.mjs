// validate-on-write.mjs — PostToolUse hook for rpiv artifact validation.
//
// Fires after Write / Edit / MultiEdit (registered matcher "Edit|Write|MultiEdit").
// If the touched file is under .rpiv/artifacts/, runs validate-artifact.mjs on it.
// Otherwise exits silently. Always exits 0 — validation failures are warnings, not
// blocks (the skill is still authoring; the ready-gate catches them at finalization).
// Covering Edit is what makes the finalization `status: ready` flip — itself an Edit,
// not a Write — actually get validated.
//
// Reads the PostToolUse JSON from stdin; the touched path arrives as
// tool_input.file_path (present on Write, Edit, and MultiEdit — there is no env-var channel).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let filePath = "";
try {
  const raw = readFileSync(0, "utf-8").trim();
  if (!raw) { process.exit(0); }
  filePath = JSON.parse(raw).tool_input?.file_path || "";
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

// Only validate .md artifacts genuinely inside THIS project's .rpiv/artifacts/ tree.
// Resolve to an absolute path and test containment against a trusted root — a substring
// check like `.includes(".rpiv/artifacts/")` would also match an unrelated path such as
// /tmp/.rpiv/artifacts/x.md that lives outside the project.
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ARTIFACTS_DIR = resolve(PROJECT_DIR, ".rpiv", "artifacts");
const resolved = resolve(filePath);
if (resolved !== ARTIFACTS_DIR && !resolved.startsWith(ARTIFACTS_DIR + sep)) process.exit(0);

// Store-managed canonical JSON (architecture-reviews/<stem>.json): a manual
// Edit/Write bypasses store.mjs validate-at-insert — warn, never block. The
// store CLI itself runs via Bash and never fires this hook; only tool edits do.
const AR_JSON_DIR = join(ARTIFACTS_DIR, "architecture-reviews");
if (resolved.endsWith(".json") && resolved.startsWith(AR_JSON_DIR + sep)) {
  process.stderr.write(
    `[rpiv-hook] ${resolved} is store-managed (canonical findings record).\n` +
      `Manual edits bypass validate-at-insert — use skills/_shared/store.mjs (add/render/finalize) instead.\n`,
  );
  process.exit(0);
}

if (!resolved.endsWith(".md")) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const validator = process.env.RPIV_VALIDATOR
  || join(__dirname, "..", "..", "skills", "_shared", "validate-artifact.mjs");

try {
  execFileSync("node", [validator, resolved], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  // OK — no output
} catch (err) {
  // Validation failed — print warnings to stderr so Claude sees them
  const stderr = err.stderr || err.message || "validation failed";
  process.stderr.write(`[rpiv-hook] Artifact validation warnings for ${resolved}:\n${stderr}\n`);
}

process.exit(0);
