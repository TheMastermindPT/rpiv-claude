// validate-skills.test.mjs — verifies Gap C: subagent_type -> agents/*.md resolution.
// Builds a throwaway plugin root and asserts dangling detection, quote/backtick/prefix handling,
// and CLI exit codes. Prints "OK".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { danglingReferences, referencedAgents } from "./validate-skills.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "validate-skills.mjs");

// referencedAgents: handles double-quote, backtick, bare, and a plugin: prefix.
const parsed = referencedAgents(
	'subagent_type: "scope-tracer"\nsubagent_type: `codebase-locator`\nsubagent_type: peer-comparator\nsubagent_type: rpiv:codebase-analyzer',
);
assert.deepEqual(
	parsed,
	["scope-tracer", "codebase-locator", "peer-comparator", "codebase-analyzer"],
	`parses all quoting styles and strips the plugin prefix: ${parsed}`,
);

function makePluginRoot() {
	const root = mkdtempSync(join(tmpdir(), "vskills-"));
	mkdirSync(join(root, "agents"), { recursive: true });
	mkdirSync(join(root, "skills", "demo"), { recursive: true });
	writeFileSync(join(root, "agents", "scope-tracer.md"), "# scope-tracer\n");
	return root;
}

let root = makePluginRoot();
try {
	// all references resolve -> no dangling
	writeFileSync(join(root, "skills", "demo", "SKILL.md"), 'Dispatch subagent_type: "scope-tracer" now.\n');
	assert.deepEqual(danglingReferences(root), [], "resolvable reference is not dangling");
	execFileSync("node", [SCRIPT, "--root", root], { encoding: "utf-8" }); // CLI exit 0

	// a reference with no matching agent file -> dangling + CLI exit 1
	writeFileSync(join(root, "skills", "demo", "SKILL.md"), 'Dispatch subagent_type: "ghost-agent" now.\n');
	const dangling = danglingReferences(root);
	assert.equal(dangling.length, 1, `one dangling reference: ${JSON.stringify(dangling)}`);
	assert.equal(dangling[0].agent, "ghost-agent", "names the missing agent");
	assert.throws(
		() => execFileSync("node", [SCRIPT, "--root", root], { stdio: "pipe" }),
		/dangling agent reference/,
		"CLI exits nonzero on a dangling reference",
	);

	console.log("OK (validate-skills) — parsing, resolution, dangling detection, CLI gate.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
