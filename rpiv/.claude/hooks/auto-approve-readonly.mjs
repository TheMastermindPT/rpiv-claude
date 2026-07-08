// auto-approve-readonly.mjs — PermissionRequest hook for rpiv.
//
// Fires when a permission dialog would appear. If the request comes from
// an rpiv subagent and the tool is read-only (Read, Glob, Grep, WebSearch,
// WebFetch, or the context-mode analysis tools ctx_search/ctx_execute_file,
// matched by their EXACT registered names), returns an "allow" decision so the
// user isn't bombarded with permission dialogs during parallel agent dispatch
// (e.g., architectural-review dispatching 7 lens agents simultaneously).
//
// For mutation tools or main-session calls, exits 0 to let the normal
// permission flow handle it.
//
// Reads PermissionRequest JSON from stdin. Answers with the PermissionRequest
// decision shape — hookSpecificOutput.decision.behavior — per the hooks
// reference (permissionDecision is the PreToolUse shape, not this event's).

import { readFileSync } from "node:fs";

import { agentFilePath } from "./_shared.mjs";

// Auto-approvable read-only tools, matched by EXACT name. The context-mode analysis
// tools are listed under both their direct (mcp__context-mode__*) and plugin-scoped
// (mcp__plugin_context-mode_context-mode__*) registrations. Matching the full name —
// never a base-name suffix — is deliberate: a tool from an unrelated or typosquatted
// MCP server whose name merely ends in "__ctx_search" must NOT auto-approve.
const READONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  "mcp__context-mode__ctx_search",
  "mcp__context-mode__ctx_execute_file",
  "mcp__plugin_context-mode_context-mode__ctx_search",
  "mcp__plugin_context-mode_context-mode__ctx_execute_file",
]);

const isReadonly = (toolName) => READONLY_TOOLS.has(toolName);

function main() {
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) { process.exit(0); return; }
    input = JSON.parse(raw);
  } catch {
    process.exit(0); return;
  }

  const agentType = input.agent_type;
  const toolName = input.tool_name;

  // Only auto-approve for rpiv subagents, not the main session
  if (!agentType) { process.exit(0); return; }

  // Verify this is actually an rpiv agent (has a definition file). agentFilePath
  // validates agent_type before touching the filesystem, so a traversal-crafted
  // agent_type can never probe outside the agents directory.
  if (!agentFilePath(agentType)) { process.exit(0); return; }

  // Only auto-approve read-only tools
  if (!toolName || !isReadonly(toolName)) { process.exit(0); return; }

  // Auto-approve: PermissionRequest answers with decision.behavior
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  }) + "\n");
}

main();
