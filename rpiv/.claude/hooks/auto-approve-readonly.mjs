// auto-approve-readonly.mjs — PermissionRequest hook for rpiv.
//
// Fires when a permission dialog would appear. If the request comes from
// an rpiv subagent and the tool is read-only (Read, Glob, Grep), returns
// an "allow" decision so the user isn't bombarded with permission dialogs
// during parallel agent dispatch (e.g., architectural-review dispatching
// 7 lens agents simultaneously).
//
// For mutation tools or main-session calls, exits 0 to let the normal
// permission flow handle it.
//
// Reads PermissionRequest JSON from stdin.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);

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

  // Verify this is actually an rpiv agent (has a definition file)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const agentFile = join(__dirname, "..", "..", "agents", `${agentType}.md`);
  if (!existsSync(agentFile)) { process.exit(0); return; }

  // Only auto-approve read-only tools
  if (!toolName || !READONLY_TOOLS.has(toolName)) { process.exit(0); return; }

  // Auto-approve: return allow decision
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      permissionDecision: "allow",
      permissionDecisionReason: `[rpiv] Auto-approved read-only ${toolName} for agent "${agentType}"`,
    },
  }) + "\n");
}

main();
