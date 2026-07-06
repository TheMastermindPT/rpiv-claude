// validate-on-write.mjs — PostToolUse hook for rpiv artifact validation.
//
// Fires after every Write tool call. If the written file is under
// .rpiv/artifacts/, runs validate-artifact.mjs on it. Otherwise exits
// silently. Always exits 0 — validation failures are warnings, not blocks
// (the skill is still authoring; the ready-gate catches them at finalization).
//
// Uses CLAUDE_TOOL_OUTPUT_FILE env var (set by Claude Code for Write/Edit).

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const filePath = process.env.CLAUDE_TOOL_OUTPUT_FILE;
if (!filePath) process.exit(0);

// Only validate rpiv artifact files
const normalized = filePath.replaceAll("\\", "/");
if (!normalized.includes(".rpiv/artifacts/")) process.exit(0);
if (!normalized.endsWith(".md")) process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));
const validator = join(__dirname, "..", "..", "skills", "_shared", "validate-artifact.mjs");

try {
  execFileSync("node", [validator, filePath], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  // OK — no output
} catch (err) {
  // Validation failed — print warnings to stderr so Claude sees them
  const stderr = err.stderr || err.message || "validation failed";
  process.stderr.write(`[rpiv-hook] Artifact validation warnings for ${normalized}:\n${stderr}\n`);
}

process.exit(0);
