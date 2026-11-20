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

/** The agent's bare name: Claude Code names a plugin agent with its prefix
    (`rpiv:claim-verifier`), OpenCode and the agent files use the bare name (D28). A non-string
    comes back unchanged so isSafeAgentType still rejects it. */
export function bareAgentName(agentType) {
  return typeof agentType === "string" ? agentType.replace(/^rpiv:/, "") : agentType;
}

/** Absolute path to an rpiv agent's .md, or null when agent_type is unsafe or the file
    does not exist. Never probes the filesystem with an unsafe agent_type. */
export function agentFilePath(agentType) {
  const name = bareAgentName(agentType);
  if (!isSafeAgentType(name)) return null;
  const file = join(agentsDir(), `${name}.md`);
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

// ---- Bash allowlists ----------------------------------------------------------
// The one owner of which agents may run which Bash commands. enforce-readonly-agent
// denies anything else; auto-approve-readonly approves exactly what passes, so a
// parallel review dispatch does not raise a permission prompt per `git diff`.

// Read-only git and search: what a reviewer needs to read diffs, base files and history.
const READ_ONLY_GIT = [/^git (diff|show|log|rev-parse|merge-base|ls-files|ls-tree|blame|grep|cat-file)\b/, /^rg\b/];
const READ_ONLY_GIT_LABEL = "read-only git (diff/show/log/rev-parse/merge-base/ls-files/ls-tree/blame/grep/cat-file) and rg";

// Allowed for every agent with an allowlist: changing directory and trimming output
// (`cd <dir> && git …`, `… | head`). None of them writes or runs another program.
const COMMON_HELPERS = [/^cd\s+\S+$/, /^(head|tail|wc)\b/];
const HELPERS_LABEL = "plus `git -C <dir>`, `cd <dir> &&` and `head`/`tail`/`wc`";

const spec = (allowed, label) => ({ allowed: [...allowed, ...COMMON_HELPERS], label: `${label}, ${HELPERS_LABEL}` });

export const BASH_ALLOWLIST = {
  // structural.mjs is the read-only ast-grep confirmation arch-review's verify gate
  // explicitly grants the verifier: it must be the script node runs, with no node flag
  // (-e, --import, --require) before it. Everything else is git show.
  "claim-verifier": spec([/^git show\b/, /^node\s+(?:\S*[\\/])?structural\.mjs(?:\s|$)/, /^rg\b/], "`git show`, `rg`, and the read-only structural.mjs helper"),
  "precedent-locator": spec([/^git (rev-parse|log|show|diff)\b/, /^grep\b/, /^rg\b/], "read-only git (rev-parse/log/show/diff) + grep/rg"),
  "artifact-code-reviewer": spec(READ_ONLY_GIT, READ_ONLY_GIT_LABEL),
  "artifact-coverage-reviewer": spec(READ_ONLY_GIT, READ_ONLY_GIT_LABEL),
  "slice-verifier": spec(READ_ONLY_GIT, READ_ONLY_GIT_LABEL),
};

// The checks read a command the way bash will, not as raw text, because bash rewrites
// it first: quotes and backslashes disappear (`--'pre'` is `--pre`), `x=>f` is a word
// followed by a redirection, and `$` expands everywhere except inside single quotes.
//   - outside quotes (quoted spans masked): no redirection or process substitution
//     (`>`, `<`), no lone `&` (background job; `&&` is a separator), and the segments
//     split on `;`, `|`, `||`, `&&` and newlines each start with an allowed prefix
//     (a leading `git -C <dir>` is read as plain `git`; lowercase `-c` is not);
//   - outside single quotes: no `$` (variables, `$(…)`) and no backtick, so nothing can
//     expand into a forbidden word;
//   - with quotes and backslashes removed: none of the options that write or run a
//     program — git's `--output`, `--ext-diff`, `--textconv`, `--filters`, and git
//     grep's `-O`/`--open-files-in-pager`; ripgrep's `--pre` (runs a program per file)
//     and `-z`/`--search-zip` (runs decompressors).
// An unbalanced quote is left unmasked, so it fails closed.
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const SINGLE_QUOTED = /'[^']*'/g;
const maskQuoted = (command) => command.replace(QUOTED, (m) => "_".repeat(m.length));
const FORBIDDEN_OUTSIDE_QUOTES = [/>/, /</, /(?<!&)&(?!&)/];
const FORBIDDEN_OUTSIDE_SINGLE_QUOTES = [/\$/, /`/];
const FORBIDDEN_OPTIONS = [
  /--output\b/, /--ext-diff\b/, /--textconv\b/, /--filters\b/, /--open-files-in-pager\b/,
  /--pre\b/, /--search-zip\b/, /(?:^|\s)-[A-Za-z]*[zO]/,
];
// `git -C <dir> log …` runs `git log …` in <dir>: compare the command without it.
const GIT_DIR_PREFIX = /^git\s+-C\s+\S+\s+/;
const SEPARATOR = /\|\||&&|[;|\r\n]/g;

/** True when `command` holds something an allowlisted agent may never run. */
const hasForbidden = (command) =>
  FORBIDDEN_OUTSIDE_QUOTES.some((re) => re.test(maskQuoted(command))) ||
  FORBIDDEN_OUTSIDE_SINGLE_QUOTES.some((re) => re.test(command.replace(SINGLE_QUOTED, "''"))) ||
  FORBIDDEN_OPTIONS.some((re) => re.test(command.replace(/['"\\]/g, "")));

/** The command's segments, split only on separators outside quotes, as bash would run
    them (quotes and backslashes removed). */
const segmentsOf = (command) => {
  const masked = maskQuoted(command);
  const segments = [];
  let start = 0;
  for (const m of masked.matchAll(SEPARATOR)) {
    segments.push(command.slice(start, m.index));
    start = m.index + m[0].length;
  }
  segments.push(command.slice(start));
  return segments
    .map((seg) => seg.replace(/['"\\]/g, "").trim().replace(GIT_DIR_PREFIX, "git "))
    .filter(Boolean);
};

/** The contract label when `command` breaks `agentType`'s Bash allowlist, or null when it
    keeps it (or the agent has no allowlist). Every segment must start with an allowed
    prefix, so an allowed command cannot be chained into anything else. A refusal names
    its reason, so the agent can switch to the Grep tool for a pattern bash cannot carry. */
export function bashAllowlistViolation(agentType, command) {
  const spec = BASH_ALLOWLIST[bareAgentName(agentType)];
  if (!spec) return null;
  if (hasForbidden(command))
    return `${spec.label}; the command holds a redirection, \`&\`, \`$\`, a backtick or an option that writes or runs a program (use the Grep tool for patterns with these characters)`;
  const segments = segmentsOf(command);
  if (segments.length === 0) return spec.label;
  return segments.every((seg) => spec.allowed.some((re) => re.test(seg))) ? null : spec.label;
}

/** True when `agentType` has a Bash allowlist and `command` keeps it. */
export function keepsBashAllowlist(agentType, command) {
  return Boolean(BASH_ALLOWLIST[bareAgentName(agentType)]) && bashAllowlistViolation(agentType, command) === null;
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
