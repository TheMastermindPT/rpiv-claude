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

import { readFileSync } from "node:fs";

import { readAgentFrontmatter } from "./_shared.mjs";

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

// Agents whose own definitions restrict Bash to specific command shapes. When an entry
// exists, EVERY segment of the command (split on ;, &&, ||, |) must match an allowed
// prefix or the call is DENIED — this turns the definitions' prose prohibitions
// ("bash is for git show only"; "no reset/checkout/rebase/fetch/pull") into enforcement,
// and the segment rule blocks chaining an allowed prefix into anything else.
const BASH_ALLOWLIST = {
  // structural.mjs is the read-only ast-grep confirmation arch-review's verify gate
  // explicitly grants the verifier; everything else is git show.
  "claim-verifier": { allowed: [/^git show\b/, /^node\b[^;&|]*structural\.mjs\b/, /^rg\b/], label: "`git show`, `rg`, and the read-only structural.mjs helper only" },
  "precedent-locator": { allowed: [/^git (rev-parse|log|show|diff)\b/, /^grep\b/, /^rg\b/], label: "read-only git (rev-parse/log/show/diff) + grep/rg only" },
};

function violatesAllowlist(agentType, command) {
  const spec = BASH_ALLOWLIST[agentType];
  if (!spec) return null;
  const segments = command.split(/(?:\|\||&&|[;|])/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return spec.label;
  const bad = segments.find((seg) => !spec.allowed.some((re) => re.test(seg)));
  return bad === undefined ? null : spec.label;
}

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

  const allowlistLabel = violatesAllowlist(agentType, command);
  if (allowlistLabel !== null) {
    deny(
      `Bash command blocked: agent "${agentType}"'s contract allows ${allowlistLabel}. ` +
      `Command: ${command.slice(0, 120)}`
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

  // Not a recognized rpiv agent (unknown name or an unsafe/traversal agent_type):
  // this hook only governs known rpiv subagents, so defer to the normal permission
  // flow rather than deny. agent_type is validated inside readAgentFrontmatter before
  // any filesystem access.
  const fm = readAgentFrontmatter(agentType);
  if (!fm) return;

  const allowedTools = parseTools(fm.tools);
  const toolName = input.tool_name;
  if (!toolName) return;

  if (handleEditWrite(toolName, allowedTools, agentType)) return;
  handleBash(toolName, allowedTools, agentType, input.tool_input?.command || "");
}

main();
process.exit(0);
