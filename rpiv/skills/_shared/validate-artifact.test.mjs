// validate-artifact.test.mjs — verifies the deterministic finalization lint. Builds artifact
// fixtures under tmpdir and asserts errors vs warnings, code-fence immunity, and CLI exit codes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stampArtifact, validateArtifact } from "./validate-artifact.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "validate-artifact.mjs");

const FM = {
	date: "2026-07-05T00:00:00+0100",
	author: "Tester",
	commit: "abc1234",
	branch: "main",
	repository: "GymApp",
	topic: "x",
	status: "ready",
	last_updated: "2026-07-05T00:00:00+0100",
	last_updated_by: "Tester",
};
function artifact(overrides = {}, body = "\n# Title\n\nClean prose.\n") {
	const fm = { ...FM, ...overrides };
	const lines = Object.entries(fm)
		.filter(([, v]) => v !== null)
		.map(([k, v]) => `${k}: ${v}`);
	return `---\n${lines.join("\n")}\n---\n${body}`;
}

const root = mkdtempSync(join(tmpdir(), "valart-"));
const write = (name, content) => {
	const p = join(root, name);
	writeFileSync(p, content);
	return p;
};
try {
	// clean, well-formed ready artifact -> no errors
	let r = validateArtifact(write("clean.md", artifact()), root);
	assert.deepEqual(r.errors, [], `clean artifact has no errors: ${r.errors}`);

	// missing frontmatter field -> error
	r = validateArtifact(write("nofield.md", artifact({ commit: null })), root);
	assert.ok(r.errors.some((e) => e.includes("commit")), `missing commit is an error: ${r.errors}`);

	// unfilled template token in PROSE -> error; the SAME token inside a code fence -> no error
	r = validateArtifact(write("token.md", artifact({}, "\nfill {plan path} here\n")), root);
	assert.ok(r.errors.some((e) => e.includes("{plan path}")), `prose token is an error: ${r.errors}`);
	r = validateArtifact(write("tokfence.md", artifact({}, "\n```ts\nconst x = {plan: 1};\n```\n")), root);
	assert.ok(!r.errors.some((e) => e.includes("template token")), `token in a code fence is ignored: ${r.errors}`);
	// a quoted JS template literal whose nested backtick breaks the inline-span stripper
	// (real case: an arch-review artifact quoting `appliedRules.add(`limitation:${region}`)`)
	// must NOT read as an unfilled artifact token — artifact placeholders are never $-prefixed
	r = validateArtifact(write("tokjs.md", artifact({}, "\nsee `appliedRules.add(`limitation:${region}:${severity}`)`) in the loop\n")), root);
	assert.ok(!r.errors.some((e) => e.includes("template token")), `quoted \${...} template literal is not an artifact token: ${r.errors}`);

	// tokens are only enforced once status: ready (a draft may still hold them) ...
	const draftPath = write("draft.md", artifact({ status: "in-progress" }, "\nfill {plan path}\n"));
	r = validateArtifact(draftPath, root);
	assert.ok(!r.errors.some((e) => e.includes("template token")), `non-ready draft is exempt from token check`);
	// ... but --finalizing applies the ready checks to an about-to-be-ready draft (flip-gate order)
	r = validateArtifact(draftPath, root, { finalizing: true });
	assert.ok(r.errors.some((e) => e.includes("{plan path}")), `--finalizing enforces tokens on a draft: ${r.errors}`);

	// TODO/TBD/FIXME in prose -> error; inside inline code -> ignored
	r = validateArtifact(write("todo.md", artifact({}, "\nTODO wire this up\n")), root);
	assert.ok(r.errors.some((e) => e.includes("TODO")), `TODO in prose is an error: ${r.errors}`);
	r = validateArtifact(write("todocode.md", artifact({}, "\nWe grep for `TODO` markers.\n")), root);
	assert.ok(!r.errors.some((e) => e.includes("placeholder")), `TODO in inline code is ignored: ${r.errors}`);

	// empty code fence -> error
	r = validateArtifact(write("emptyfence.md", artifact({}, "\n```ts\n\n```\n")), root);
	assert.ok(r.errors.some((e) => e.includes("empty code fence")), `empty fence is an error: ${r.errors}`);

	// parent present but missing -> error; parent that exists -> no error
	r = validateArtifact(write("badparent.md", artifact({ parent: "nope/missing.md" })), root);
	assert.ok(r.errors.some((e) => e.includes("parent artifact not found")), `missing parent is an error: ${r.errors}`);
	write("real-parent.md", artifact());
	r = validateArtifact(write("goodparent.md", artifact({ parent: "real-parent.md" })), root);
	assert.ok(!r.errors.some((e) => e.includes("parent")), `existing parent passes: ${r.errors}`);

	// a body file reference (context-relative / stale) is NOT flagged — that check is intentionally
	// absent (it was ~all false positives on real artifacts).
	r = validateArtifact(write("ref.md", artifact({}, "\nSee `lib/db/ghost.ts:42` for details.\n")), root);
	assert.deepEqual(r.errors, [], `a body file reference is never an error: ${r.errors}`);

	// hash-pin: stamp a ready artifact, then an untouched verify passes; a body edit is detected;
	// a metadata-only change (last_updated) does NOT trip it; a re-stamp clears it.
	const stampPath = write("stamped.md", artifact({}, "\n# Body\n\noriginal content\n"));
	const hash = stampArtifact(stampPath);
	assert.ok(readFileSync(stampPath, "utf-8").includes(`content_hash: ${hash}`), "stamp writes content_hash");
	assert.deepEqual(validateArtifact(stampPath, root).errors, [], "verify passes right after stamping");

	writeFileSync(stampPath, readFileSync(stampPath, "utf-8").replace("original content", "TAMPERED content"));
	assert.ok(
		validateArtifact(stampPath, root).errors.some((e) => e.includes("content_hash mismatch")),
		"a post-finalization body edit is detected",
	);

	// metadata-only churn (frontmatter) must not trip the body hash
	const metaPath = write("meta.md", artifact({}, "\n# Body\n\nstable body\n"));
	stampArtifact(metaPath);
	writeFileSync(metaPath, readFileSync(metaPath, "utf-8").replace(/last_updated: .*/, "last_updated: 2099-01-01"));
	assert.deepEqual(
		validateArtifact(metaPath, root).errors,
		[],
		"frontmatter-only change does not trip the body hash",
	);

	// CLI --stamp writes the hash and reports OK (stamped)
	const cliStamp = write("clistamp.md", artifact({}, "\n# Body\n\ncli body\n"));
	const out = execFileSync("node", [SCRIPT, cliStamp, "--root", root, "--stamp"], { encoding: "utf-8" });
	assert.ok(/OK \(stamped\)/.test(out), `--stamp reports stamped: ${out}`);
	assert.ok(readFileSync(cliStamp, "utf-8").includes("content_hash:"), "--stamp writes content_hash into the file");

	// CLI: clean -> exit 0; error -> exit 1
	execFileSync("node", [SCRIPT, join(root, "clean.md"), "--root", root], { encoding: "utf-8" });
	assert.throws(
		() => execFileSync("node", [SCRIPT, join(root, "todo.md"), "--root", root], { stdio: "pipe" }),
		/error\(s\)/,
		"CLI exits nonzero when an artifact has errors",
	);

	console.log("OK (validate-artifact) — frontmatter, tokens, placeholders, fences, parent, hash-pin, CLI gate.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
