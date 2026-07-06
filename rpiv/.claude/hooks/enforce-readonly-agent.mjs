// enforce-readonly-agent.mjs — PreToolUse hook for rpiv subagent guardrails.
//
// Fires before Edit, Write, and Bash tool calls. When running inside an rpiv
// subagent (detected via agent_type in hook input), enforces:
//
//   1. Edit/Write — denied unless the agent's frontmatter lists them.
//      Returns a deny decision so Claude Code blocks the call.
//
//   2. Bash — if Bash IS in the agent's tools, checks the command for
//      destructive patterns (rm -rf, git push, etc.) and warns.
//      If Bash is NOT in tools, denies the call.
//
// In the main session (no agent_type), exits 0 silently — the user is in
// control, not a subagent.
//
// Reads PreToolUse JSON from stdin. Returns deny decisions as JSON on stdout.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---- helpers -------------------------------------------------------------------

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
  return { fm };
}

function parseTools(toolsStr) {
  if (!toolsStr) return [];
  return toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
}

const DESTRUCTIVE_BASH = [
  /\brm\s+-rf?\b/,        /\brm\s+.*--recursive\b/,
  /\bgit\s+push\b/,       /\bgit\s+commit\b/,
  /\bnpm\s+(install|uninstall|publish)\b/,
  /\bnpx\b/,              /\byarn\s+(add|remove)\b/,
  /\bpip\s+install\b/,    /\bpip3\s+install\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/, /\bwget\b.*\|\s*(ba)?sh\b/,
  /\bchmod\b/,            /\bchown\b/,
  /\bdd\s+if=/,           /\bmkfs\./,
  /\bdocker\s+(rm|stop|kill|system\s+prune)\b/,
  /\>(\s*\/dev\/)/,
];

function looksDestructive(command) {
  return DESTRUCTIVE_BASH.some((re) => re.test(command));
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[rpiv-hook] ${reason}`,
    },
  }) + "\n");
}

/** Read hook JSON from stdin. Returns null when stdin is empty/invalid. */
function readStdin() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Check Edit/Write permissions. Returns true if the call was handled (denied or
    allowed); returns false if the tool is neither Edit nor Write. */
function handleEditWrite(toolName, allowedTools, agentType) {
  if (toolName !== "Edit" && toolName !== "Write") return false;

  if (!allowedTools.includes(toolName)) {
    deny(
      `"${toolName}" blocked: agent "${agentType}" is read-only ` +
      `(allowed tools: ${allowedTools.join(", ") || "none"}). ` +
      `This agent must not modify files.`
    );
  }
  // If allowed, silent — nothing to deny
  return true;
}

/** Check Bash permissions. Returns true if Bash was the tool (handled);
    returns false if the tool is not Bash. */
function handleBash(toolName, allowedTools, agentType, command) {
  if (toolName !== "Bash") return false;

  if (!allowedTools.includes("Bash")) {
    deny(
      `Bash blocked: agent "${agentType}" does not allow Bash ` +
      `(allowed tools: ${allowedTools.join(", ") || "none"}).`
    );
    return true;
  }

  if (looksDestructive(command)) {
    process.stderr.write(
      `[rpiv-hook] WARNING: agent "${agentType}" running potentially destructive Bash: ${command.slice(0, 120)}\n`
    );
  }
  return true;
}

// ---- main ----------------------------------------------------------------------

function main() {
  const input = readStdin();
  if (!input) return;

  const agentType = input.agent_type;
  if (!agentType) return; // main session — allow everything

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const agentsDir = process.env.RPIV_AGENTS_DIR || join(__dirname, "..", "..", "agents");
  const agentFile = join(agentsDir, `${agentType}.md`);
  if (!existsSync(agentFile)) return; // not an rpiv agent — allow

  const { fm } = splitFrontmatter(readFileSync(agentFile, "utf-8"));
  const allowedTools = parseTools(fm.tools);
  const toolName = input.tool_name;
  if (!toolName) return;

  if (handleEditWrite(toolName, allowedTools, agentType)) return;
  handleBash(toolName, allowedTools, agentType, input.tool_input?.command || "");
}

main();
process.exit(0);
