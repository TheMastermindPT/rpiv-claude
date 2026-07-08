// validate-skills.test.mjs — verifies Gap C: subagent_type -> agents/*.md resolution.
// Builds a throwaway plugin root and asserts dangling detection, quote/backtick/prefix handling,
// and CLI exit codes. Prints "OK".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { danglingReferences, referencedAgents, referenceIntegrity } from "./validate-skills.mjs";

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

// referencedAgents: an illustrative mention opted out with `validate-skills:ignore` is skipped.
const withIgnore = referencedAgents(
	"subagent_type: `real-agent`\nsubagent_type: `doc-example` <!-- validate-skills:ignore -->",
);
assert.deepEqual(withIgnore, ["real-agent"], `ignore marker drops that line's reference: ${withIgnore}`);

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

	// reference-integrity: clean skill (mentioned reference exists, placeholder paired) -> no problems
	mkdirSync(join(root, "skills", "demo", "references"), { recursive: true });
	writeFileSync(join(root, "skills", "demo", "references", "surfaces.md"), "content\n");
	writeFileSync(
		join(root, "skills", "demo", "SKILL.md"),
		'Dispatch subagent_type: "scope-tracer".\nRead `references/surfaces.md` and substitute it for the `{{SURFACES}}` line.\n  {{SURFACES}}\n',
	);
	assert.deepEqual(referenceIntegrity(root), [], "existing reference + paired placeholder are clean");

	// dangling reference-file mention -> flagged + CLI exit 1
	writeFileSync(
		join(root, "skills", "demo", "SKILL.md"),
		'Dispatch subagent_type: "scope-tracer".\nRead `references/surfaces.md` and `references/ghost.md`, substitute for `{{SURFACES}}`.\n  {{SURFACES}}\n',
	);
	let problems = referenceIntegrity(root);
	assert.equal(problems.length, 1, `one dangling reference file: ${JSON.stringify(problems)}`);
	assert.equal(problems[0].kind, "dangling-reference");
	assert.throws(
		() => execFileSync("node", [SCRIPT, "--root", root], { stdio: "pipe" }),
		/reference-integrity/,
		"CLI exits nonzero on a dangling reference file",
	);

	// orphan reference file (exists, never mentioned) -> flagged
	writeFileSync(join(root, "skills", "demo", "SKILL.md"), 'Dispatch subagent_type: "scope-tracer". No references here.\n');
	problems = referenceIntegrity(root);
	assert.equal(problems.length, 1, `one orphan: ${JSON.stringify(problems)}`);
	assert.equal(problems[0].kind, "orphan-reference");

	// unpaired placeholder (appears once — instruction or substitution site was lost) -> flagged
	writeFileSync(
		join(root, "skills", "demo", "SKILL.md"),
		'Dispatch subagent_type: "scope-tracer".\nRead `references/surfaces.md`.\n  {{SURFACES}}\n',
	);
	problems = referenceIntegrity(root);
	assert.equal(problems.length, 1, `one unpaired placeholder: ${JSON.stringify(problems)}`);
	assert.equal(problems[0].kind, "unpaired-placeholder");

	// cross-skill mention resolves against the OTHER skill's directory
	mkdirSync(join(root, "skills", "other"), { recursive: true });
	writeFileSync(
		join(root, "skills", "other", "SKILL.md"),
		"See skills/demo/references/surfaces.md for the shared block.\n",
	);
	writeFileSync(
		join(root, "skills", "demo", "SKILL.md"),
		'Dispatch subagent_type: "scope-tracer".\nRead `references/surfaces.md`, substitute for `{{SURFACES}}`.\n  {{SURFACES}}\n',
	);
	assert.deepEqual(referenceIntegrity(root), [], "cross-skill prefixed mention resolves against its owner");

	console.log("OK (validate-skills) — parsing, resolution, dangling detection, reference integrity, CLI gate.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
