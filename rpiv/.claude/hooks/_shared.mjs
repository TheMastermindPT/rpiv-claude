// _shared.mjs — shared helpers for rpiv .claude/hooks/* scripts.
//
// Centralizes the agent-definition lookup that four hooks (auto-approve-readonly,
// enforce-readonly-agent, subagent-output-check, validate-agent-model) each inlined,
// and adds the agent_type validation those copies lacked: agent_type arrives on hook
// stdin and was interpolated straight into a filesystem path, so a value containing
// path separators or ".." could probe outside the agents directory. isSafeAgentType()
// rejects those before any fs touch, so every hook shares one hardened "is this a real
// rpiv agent?" gate instead of four subtly-different copies.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

/** The rpiv agents directory: RPIV_AGENTS_DIR override, else ../../agents from .claude/hooks/. */
export function agentsDir() {
  return process.env.RPIV_AGENTS_DIR || join(HOOKS_DIR, "..", "..", "agents");
}

/** True only for a bare agent name — non-empty, no path separators, no "..", no leading dot.
    agent_type is attacker-influenceable hook input; this gate keeps it from escaping the
    agents directory when interpolated into a file path. */
export function isSafeAgentType(agentType) {
  return typeof agentType === "string"
    && agentType.length > 0
    && !/[\\/]/.test(agentType)
    && !agentType.includes("..")
    && !agentType.startsWith(".");
}

/** Absolute path to an rpiv agent's .md, or null when agent_type is unsafe or the file
    does not exist. Never probes the filesystem with an unsafe agent_type. */
export function agentFilePath(agentType) {
  if (!isSafeAgentType(agentType)) return null;
  const file = join(agentsDir(), `${agentType}.md`);
  return existsSync(file) ? file : null;
}

/** Parse `--- ... ---` frontmatter into a flat { key: value } map. */
export function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text };
  const fm = {};
  for (const line of text.slice(4, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) fm[key] = line.slice(colon + 1).trim();
  }
  return { fm, body: text.slice(end + 4) };
}

/** Frontmatter of an rpiv agent definition, or null when agent_type is unsafe or unknown.
    The single verified "is this a real rpiv agent?" gate for hooks that read the definition. */
export function readAgentFrontmatter(agentType) {
  const file = agentFilePath(agentType);
  if (!file) return null;
  return splitFrontmatter(readFileSync(file, "utf-8")).fm;
}

/** Collapse a value to a single safe line for emission into model context: replace control
    characters (code point < 0x20, or DEL 0x7f — includes newlines/tabs) with spaces, collapse
    whitespace runs, trim, and cap length. SessionStart hook stdout becomes model context, so
    any external-influenced string (git branch names, agent-extracted file paths) must not
    smuggle in newlines or an overlong payload that could read as an instruction, not data. */
export function sanitizeForContext(value, maxLen = 200) {
  const cleaned = Array.from(String(value ?? ""), (ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}
