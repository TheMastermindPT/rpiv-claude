// validate-agent-model.mjs — SubagentStart hook for rpiv agents.
//
// Reads the subagent's frontmatter from its .md definition and checks that the
// `model` field is present and aligns with the agent's `effort` level.
// Advisory only — never blocks (always exits 0). Warnings go to stderr so
// they appear in the Claude Code output without interfering with hook JSON.
//
// Expected model ↔ effort alignment:
//   effort: low     → haiku (or sonnet — sonnet is always acceptable)
//   effort: medium  → sonnet (or haiku if the agent is simple enough)
//   effort: high    → sonnet minimum (opus is acceptable, haiku is a warning)
//   effort: xhigh   → sonnet minimum (opus is acceptable, haiku is a warning)
//
// Missing model: always warns (falls back to parent model, unpredictable).

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- helpers -------------------------------------------------------------------

/** Parse YAML-like frontmatter between --- markers. Returns { fm: Record, body: string }. */
function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text };
  const fmBlock = text.slice(4, end);
  const fm = {};
  for (const line of fmBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) fm[key] = val;
  }
  return { fm, body: text.slice(end + 4) };
}

/** Resolve numeric tier from a model name string. */
const MODEL_TIER = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

function tierOf(model) {
  if (!model || model === "inherit") return null;
  if (model.startsWith("claude-haiku")) return 1;
  if (model.startsWith("claude-sonnet")) return 2;
  if (model.startsWith("claude-opus")) return 3;
  if (model.startsWith("claude-fable")) return 4;
  return MODEL_TIER[model] ?? null;
}

/** Read hook JSON from stdin. Returns {} on failure (advisory — never throw). */
function readStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Read an rpiv agent's frontmatter, or null if the agent doesn't exist. */
function readAgentFm(agentType, agentsDir) {
  const agentFile = join(agentsDir, `${agentType}.md`);
  if (!existsSync(agentFile)) return null;
  return splitFrontmatter(readFileSync(agentFile, "utf-8")).fm;
}

// ---- policy checks (side-effect: write warnings/notes to stderr) ----------------

/** Check model ↔ effort alignment and over-provisioning. */
function checkAlignment(agentType, model, effort) {
  const actualTier = tierOf(model);
  if (actualTier === null) return;

  switch (effort) {
    case "low":
    case "medium": {
      // Low/medium effort: haiku or sonnet expected. Opus is over-provisioned.
      if (actualTier >= 3) {
        process.stderr.write(
          `[rpiv-hook] NOTE: agent "${agentType}" has effort "${effort}" but model "${model}" ` +
          `(tier ${actualTier}). Consider downgrading to sonnet or haiku.\n`
        );
      }
      break;
    }
    case "high":
    case "xhigh": {
      // High/xhigh effort: sonnet minimum. Haiku is under-provisioned.
      if (actualTier < 2) {
        process.stderr.write(
          `[rpiv-hook] WARNING: agent "${agentType}" has model "${model}" (tier ${actualTier}) ` +
          `but effort is "${effort}" which expects sonnet or opus (tier >= 2).\n`
        );
      }
      break;
    }
    default:
      break; // Unknown effort level — skip
  }
}

// ---- main ----------------------------------------------------------------------

function main() {
  const input = readStdin();
  const agentType = input.agent_type;
  if (!agentType) return;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const agentsDir = process.env.RPIV_AGENTS_DIR || join(__dirname, "..", "..", "agents");
  const fm = readAgentFm(agentType, agentsDir);
  if (!fm) return;

  const model = fm.model || null;
  const effort = fm.effort || null;

  if (!model) {
    process.stderr.write(
      `[rpiv-hook] WARNING: agent "${agentType}" has no 'model' field ` +
      `(effort: ${effort || "unknown"}). Defaults to parent session model.\n`
    );
    return;
  }

  if (!effort) {
    process.stderr.write(
      `[rpiv-hook] NOTE: agent "${agentType}" has model "${model}" but no 'effort' field ` +
      `for alignment validation.\n`
    );
    return;
  }

  checkAlignment(agentType, model, effort);
}

main();
process.exit(0);
