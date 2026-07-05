// validate-skills.mjs — Gap C: every agent a skill dispatches must actually exist.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-skills.mjs" [--root <plugin-root>]
//
// Scans every `.md` under <plugin-root>/skills for `subagent_type:` references and checks each
// resolves to a <plugin-root>/agents/<name>.md file. A dangling reference (agent renamed or
// removed) silently breaks the dispatching skill on any harness, so this fails (exit 1). An
// optional `<plugin>:` prefix (e.g. `rpiv:scope-tracer`) is stripped before resolving.
//
// This is a logical-consistency check, not a port/deployment check — it holds regardless of the
// harness the skills run on.
//
// WHEN TO RUN: a standalone plugin-maintenance check, deliberately NOT wired into any skill's
// runtime flow — the scope is the plugin tree itself, not a single artifact, so a per-artifact
// finalization gate would be the wrong home. Run it manually (or in CI) after adding, renaming, or
// removing an agent or a `subagent_type:` reference.
//
// An illustrative `subagent_type:` written in prose (a doc example, not a real dispatch) is
// excluded by putting `validate-skills:ignore` anywhere on the same line, so examples never trip it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Recursively collect every `.md` file under `dir`. */
function walkMarkdown(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
		else if (entry.endsWith(".md")) out.push(full);
	}
	return out;
}

/** All agent names available under <root>/agents (basename without .md). */
export function availableAgents(root) {
	const dir = join(root, "agents");
	if (!existsSync(dir)) return new Set();
	return new Set(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
}

/** Extract dispatched agent names from one skill file. Strips quotes/backticks + `plugin:` prefix;
 *  skips any match on a line carrying `validate-skills:ignore` (illustrative prose opt-out). */
export function referencedAgents(text) {
	const refs = [];
	const re = /subagent_type:\s*["`']?([A-Za-z][\w:-]*)/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const lineStart = text.lastIndexOf("\n", m.index) + 1;
		const lineEnd = text.indexOf("\n", m.index) === -1 ? text.length : text.indexOf("\n", m.index);
		if (text.slice(lineStart, lineEnd).includes("validate-skills:ignore")) continue;
		const raw = m[1];
		refs.push(raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw);
	}
	return refs;
}

/** Returns [{ file, agent }] for every subagent_type that does not resolve to an agents/*.md. */
export function danglingReferences(root) {
	const agents = availableAgents(root);
	const dangling = [];
	for (const file of walkMarkdown(join(root, "skills"))) {
		const text = readFileSync(file, "utf-8");
		for (const agent of referencedAgents(text)) {
			if (!agents.has(agent)) dangling.push({ file, agent });
		}
	}
	return dangling;
}

// ---- CLI ---------------------------------------------------------------------------------------
const isMain = (() => {
	try {
		return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
	} catch {
		return false;
	}
})();
if (isMain) {
	const args = process.argv.slice(2);
	const rootIdx = args.indexOf("--root");
	// Default: this file lives at <plugin-root>/skills/_shared/, so the plugin root is two up.
	const root = rootIdx !== -1 ? resolve(args[rootIdx + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const dangling = danglingReferences(root);
	if (dangling.length > 0) {
		for (const { file, agent } of dangling) {
			process.stderr.write(`ERROR ${file}: subagent_type "${agent}" has no agents/${agent}.md\n`);
		}
		process.stderr.write(`\nvalidate-skills: ${dangling.length} dangling agent reference(s)\n`);
		process.exit(1);
	}
	process.stdout.write("validate-skills: OK — every subagent_type resolves to an agent\n");
	process.exit(0);
}
