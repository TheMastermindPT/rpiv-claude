// subagent-output-check.mjs — SubagentStop hook for rpiv.
//
// Fires when an rpiv subagent finishes. Checks that the agent produced
// meaningful output — non-empty for agents that should return results,
// and free of error/fallback language. Advisory only (warns, never blocks).
//
// Reads SubagentStop JSON from stdin.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- helpers -------------------------------------------------------------------

function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {} };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {} };
  const fmBlock = text.slice(4, end);
  const fm = {};
  for (const line of fmBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) fm[key] = val;
  }
  return { fm };
}

// Agents that always produce structured output.
const STRUCTURED_AGENTS = {
  "claim-verifier": { pattern: /FINDING\s+\S+\s+\|\s+(Verified|Weakened|Falsified)/, label: "FINDING rows" },
  "diff-auditor":   { pattern: /\S+:\d+\s+\|/, label: "pipe-delimited rows (file:line | ...)" },
  "peer-comparator": { pattern: /(Mirrored|Missing|Diverged|Intentionally-absent)/, label: "peer invariant tags" },
  "test-case-locator": { pattern: /(test|spec|coverage)/i, label: "test case references" },
  "artifacts-locator": { pattern: /\.rpiv\//, label: "artifact paths" },
};

const ERROR_PATTERNS = [
  /\bI('m| am) sorry\b/i,
  /\bI (cannot|can't|am unable to)\b/i,
  /\bno (results|findings|matches) (were |)found\b/i,
  /\bunable to (complete|process|analyze|find)\b/i,
  /\b(error|exception|failed|timeout)\b/i,
];

/** Read hook JSON from stdin. Returns null on empty/invalid. */
function readStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Check if result text contains error/fallback language. Warns on stderr. */
function checkErrorLanguage(agentType, result) {
  for (const pat of ERROR_PATTERNS) {
    if (pat.test(result)) {
      const match = result.match(pat)?.[0] || pat.source;
      process.stderr.write(
        `[rpiv-hook] WARNING: agent "${agentType}" output contains ` +
        `possible error/fallback: "${match}"\n`
      );
      return;
    }
  }
}

/** Check that the result is long enough for the agent's effort level.
    Low-effort agents are exempt from the length check. */
function checkLength(agentType, effort, result) {
  if (effort === "low") return;
  if (result.trim().length >= 20) return;
  process.stderr.write(
    `[rpiv-hook] WARNING: agent "${agentType}" (effort: ${effort}) ` +
    `returned suspiciously short output (${result.length} chars).\n`
  );
}

/** Check that known structured agents produce their expected format. */
function checkFormat(agentType, result) {
  const spec = STRUCTURED_AGENTS[agentType];
  if (!spec || spec.pattern.test(result)) return;
  process.stderr.write(
    `[rpiv-hook] WARNING: agent "${agentType}" output missing expected ` +
    `format: ${spec.label}\n`
  );
}

// ---- main ----------------------------------------------------------------------

function main() {
  const input = readStdin();
  if (!input) return;

  const agentType = input.agent_type;
  if (!agentType) return;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const agentsDir = process.env.RPIV_AGENTS_DIR || join(__dirname, "..", "..", "agents");
  const agentFile = join(agentsDir, `${agentType}.md`);
  if (!existsSync(agentFile)) return;

  const { fm } = splitFrontmatter(readFileSync(agentFile, "utf-8"));
  const effort = fm.effort || "medium";
  const result = input.result || "";

  checkLength(agentType, effort, result);
  checkErrorLanguage(agentType, result);
  checkFormat(agentType, result);
}

main();
process.exit(0);
