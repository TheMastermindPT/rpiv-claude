// cross-agent-consistency.mjs — PostToolBatch hook for rpiv.
//
// Fires after a batch of parallel tool calls resolves. Detects when multiple
// rpiv agents completed in the same batch and checks for conflicting claims
// (same file referenced, opposing verdicts). Uses a lightweight state file
// to track recent agent results across batches.
//
// State file: <project>/.rpiv/.claude/agent-batch-state.json
// Advisory only — warns on stderr, never blocks.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- state management ----------------------------------------------------------

const STATE_DIR = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".rpiv", ".claude");

function loadState() {
  const f = join(STATE_DIR, "agent-batch-state.json");
  try { return JSON.parse(readFileSync(f, "utf-8")); } catch { return { batches: [] }; }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "agent-batch-state.json"), JSON.stringify(state));
  } catch { /* non-critical */ }
}

// ---- analysis ------------------------------------------------------------------

/** Extract file paths mentioned in agent output text. */
function extractFiles(text) {
  const paths = [];
  const re = /\b((?:app|lib|components|src|tests|supabase)\/[\w\/.-]+\.(?:tsx?|jsx?|sql|md|css))\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!paths.includes(m[1])) paths.push(m[1]);
  }
  return paths;
}

/** Extract severity/verdict keywords from agent output. */
function extractVerdict(text) {
  const lower = text.toLowerCase();
  if (/\b(blocker|critical|severe|falsified|degraded)\b/i.test(lower)) return "bad";
  if (/\b(clean|healthy|verified|passed|mirrored|ok|good)\b/i.test(lower)) return "good";
  return "neutral";
}

/** Detect conflicts and overlaps in file→agents map. Emits directly to stderr. */
function detectAndReportIssues(fileAgents) {
  for (const [file, agents] of fileAgents) {
    if (agents.length < 2) continue;
    const verdicts = new Set(agents.map((a) => a.verdict));

    if (verdicts.has("good") && verdicts.has("bad")) {
      const names = [...new Set(agents.map((a) => a.agent))].join(", ");
      process.stderr.write(
        `[rpiv-hook] WARNING: cross-agent conflict: "${file}" — ` +
        `agents [${names}] disagree (good vs bad)\n`
      );
      continue;
    }

    if (verdicts.size === 1 && agents.length >= 3) {
      const names = [...new Set(agents.map((a) => a.agent))].join(", ");
      process.stderr.write(
        `[rpiv-hook] NOTE: ${agents.length} agents [${names}] all ` +
        `report on "${file}" — potential overlap.\n`
      );
    }
  }
}

// ---- main ----------------------------------------------------------------------

function main() {
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return;
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const calls = input.tool_calls || input.calls || [];
  if (!Array.isArray(calls) || calls.length < 2) return;

  // Collect rpiv agent results with non-empty output
  const agentResults = [];
  for (const c of calls) {
    if (c.tool_name !== "Agent" && !c.agent_type) continue;
    const agent = c.agent_type || (c.tool_input && c.tool_input.subagent_type) || "unknown";
    const result = c.result || c.tool_output || "";
    if (result.length > 0) agentResults.push({ agent, result });
  }
  if (agentResults.length < 2) return;

  // Build file → [{agent, verdict}] map
  const fileAgents = new Map();
  for (const ar of agentResults) {
    const files = extractFiles(ar.result);
    const verdict = extractVerdict(ar.result);
    for (const f of files) {
      if (!fileAgents.has(f)) fileAgents.set(f, []);
      fileAgents.get(f).push({ agent: ar.agent, verdict });
    }
  }

  detectAndReportIssues(fileAgents);

  // Persist batch for trend analysis (last 10 only)
  const state = loadState();
  state.batches.push({
    ts: new Date().toISOString(),
    agentCount: agentResults.length,
    filesTouched: [...fileAgents.keys()],
    conflictCount: 0, // conflicts already emitted above; count deferred
  });
  if (state.batches.length > 10) state.batches = state.batches.slice(-10);
  saveState(state);
}

main();
process.exit(0);
