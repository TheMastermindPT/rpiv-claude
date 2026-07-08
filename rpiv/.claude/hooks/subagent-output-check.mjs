// subagent-output-check.mjs — SubagentStop hook for rpiv.
//
// Fires when an rpiv subagent finishes. Checks that the agent produced
// meaningful output — non-empty for agents that should return results,
// and free of error/fallback language. Advisory only (warns, never blocks).
//
// Reads SubagentStop JSON from stdin.

import { readFileSync } from "node:fs";

import { readAgentFrontmatter } from "./_shared.mjs";

// ---- helpers -------------------------------------------------------------------

// Agents that always produce structured output.
const STRUCTURED_AGENTS = {
  "claim-verifier": { pattern: /FINDING\s+\S+\s+\|\s+(Verified|Weakened|Falsified)/, label: "FINDING rows" },
  "diff-auditor":   { pattern: /\S+:\d+\s+\|/, label: "pipe-delimited rows (file:line | ...)" },
  "diff-analyst":   { pattern: /\S+:\d+\s+\|/, label: "pipe-delimited rows (file:line | ...)" },
  "slice-verifier": { pattern: /-\s*Decisions:[\s\S]*-\s*Cross-slice:[\s\S]*-\s*Research:/, label: "Decisions / Cross-slice / Research rows" },
  "peer-comparator": { pattern: /(Mirrored|Missing|Diverged|Intentionally-absent)/, label: "peer invariant tags" },
  "test-case-locator": { pattern: /(test|spec|coverage)/i, label: "test case references" },
  "artifacts-locator": { pattern: /\.rpiv\//, label: "artifact paths" },
};

// Apology/refusal shapes are meaningful anywhere in the output.
const ERROR_PATTERNS = [
  /\bI('m| am) sorry\b/i,
  /\bI (cannot|can't|am unable to)\b/i,
  /\bunable to (complete|process|analyze|find)\b/i,
];

// Generic failure vocabulary is meaningful only at the START of output: an agent that
// OPENS with "Error: ..." failed; one whose 40th row cites an error-handling path did
// not. Scanning the whole body warned on every legitimate error-path analysis (review
// agents discuss errors constantly), which made the advisory permanent noise — a dead
// guardrail.
const HEAD_FAILURE_PATTERNS = [
  /\bno (results|findings|matches) (were |)found\b/i,
  /\b(error|exception|failed|timeout)\b/i,
];
const HEAD_WINDOW = 200;

/** Read hook JSON from stdin. Returns null on empty/invalid. */
function readStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Check if result text contains error/fallback language. Warns on stderr.
    Apology shapes scan the full text; generic failure words scan only the head. */
function checkErrorLanguage(agentType, result) {
  const head = result.slice(0, HEAD_WINDOW);
  for (const { pat, text } of [
    ...ERROR_PATTERNS.map((pat) => ({ pat, text: result })),
    ...HEAD_FAILURE_PATTERNS.map((pat) => ({ pat, text: head })),
  ]) {
    if (pat.test(text)) {
      const match = text.match(pat)?.[0] || pat.source;
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

  const fm = readAgentFrontmatter(agentType);
  if (!fm) return;
  const effort = fm.effort || "medium";
  const result = input.result || "";

  checkLength(agentType, effort, result);
  checkErrorLanguage(agentType, result);
  checkFormat(agentType, result);
}

main();
process.exit(0);
