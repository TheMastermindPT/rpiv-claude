// enforce-readonly-agent.mjs — PreToolUse hook for rpiv subagent guardrails.
//
// Fires before file-writing tools (Edit, Write, MultiEdit, NotebookEdit) and shell
// tools (Bash, PowerShell). When running inside an rpiv subagent (detected via
// agent_type in hook input), enforces:
//
//   1. File writes — denied unless the agent's frontmatter lists the tool.
//      Returns a deny decision so Claude Code blocks the call.
//
//   2. Shell — if the shell tool is NOT in the agent's tools, denies the call.
//      If it IS, the agent's Bash allowlist (when it has one) applies to the
//      command, and destructive patterns (rm -rf, git push, etc.) warn.
//
// In the main session (no agent_type), exits 0 silently — the user is in
// control, not a subagent.
//
// Reads PreToolUse JSON from stdin. Returns deny decisions as JSON on stdout.

import { readFileSync } from "node:fs";

import { bashAllowlistViolation, readAgentFrontmatter } from "./_shared.mjs";

// ---- helpers -------------------------------------------------------------------

function parseTools(toolsStr) {
  if (!toolsStr) return [];
  return toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
}

const DESTRUCTIVE_BASH = [
  /\brm\s+-rf?\b/,        /\brm\s+.*--recursive\b/,
  /\bgit\s+push\b/,       /\bgit\s+commit\b/,
  /\bgit\s+(reset|rebase|clean|restore|checkout|fetch|pull)\b/,
  /\bnpm\s+(install|uninstall|publish)\b/,
  /\bnpx\b/,              /\byarn\s+(add|remove)\b/,
  /\bpip\s+install\b/,    /\bpip3\s+install\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/, /\bwget\b.*\|\s*(ba)?sh\b/,
  /\bchmod\b/,            /\bchown\b/,
  /\bdd\s+if=/,           /\bmkfs\./,
  /\bdocker\s+(rm|stop|kill|system\s+prune)\b/,
  /\>(\s*\/dev\/)/,
];

// Agents whose own definitions restrict Bash to specific command shapes: the
// allowlists and their check live in _shared.mjs (BASH_ALLOWLIST), shared with
// auto-approve-readonly so what is approved is exactly what is allowed.

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

// Every tool that writes a file, and every tool that runs a shell command. A tool
// missing here is not governed at all, so a read-only agent could write with it.
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Check file-write permissions. Returns true if the call was handled (denied or
    allowed); returns false if the tool does not write files. */
function handleFileWrite(toolName, allowedTools, agentType) {
  if (!FILE_WRITE_TOOLS.has(toolName)) return false;

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

/** Check shell permissions (Bash or PowerShell). The agent's Bash allowlist governs a
    PowerShell command too: the contract is about which commands the agent may run, not
    which shell runs them. */
function handleShell(toolName, allowedTools, agentType, command) {
  if (!SHELL_TOOLS.has(toolName)) return;

  if (!allowedTools.includes(toolName)) {
    deny(
      `${toolName} blocked: agent "${agentType}" does not allow ${toolName} ` +
      `(allowed tools: ${allowedTools.join(", ") || "none"}).`
    );
    return;
  }

  const allowlistLabel = bashAllowlistViolation(agentType, command);
  if (allowlistLabel !== null) {
    deny(
      `${toolName} command blocked: agent "${agentType}"'s contract allows ${allowlistLabel}. ` +
      `Command: ${command.slice(0, 120)}`
    );
    return;
  }

  if (looksDestructive(command)) {
    process.stderr.write(
      `[rpiv-hook] WARNING: agent "${agentType}" running potentially destructive ${toolName}: ${command.slice(0, 120)}\n`
    );
  }
}

// ---- main ----------------------------------------------------------------------

function main() {
  const input = readStdin();
  if (!input) return;

  const agentType = input.agent_type;
  if (!agentType) return; // main session — allow everything

  // Not a recognized rpiv agent (unknown name or an unsafe/traversal agent_type):
  // this hook only governs known rpiv subagents, so defer to the normal permission
  // flow rather than deny. agent_type is validated inside readAgentFrontmatter before
  // any filesystem access.
  const fm = readAgentFrontmatter(agentType);
  if (!fm) return;

  const allowedTools = parseTools(fm.tools);
  const toolName = input.tool_name;
  if (!toolName) return;

  if (handleFileWrite(toolName, allowedTools, agentType)) return;
  handleShell(toolName, allowedTools, agentType, input.tool_input?.command || "");
}

main();
process.exit(0);
