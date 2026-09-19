// structural.test.mjs — node:assert test for structural.mjs. Builds a throwaway git repo, asserts
// the read-only degrade paths deterministically + (env-gated) one real rg match. Prints OK.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "structural.mjs");
const sh = process.platform === "win32";
const git = (repo, args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
const rgPresent = (() => { const r = spawnSync("rg", ["--version"], { stdio: "ignore", shell: sh }); return !r.error && r.status === 0; })();
const runHelper = (repo, args) => execFileSync("node", [HELPER, ...args], { cwd: repo, encoding: "utf-8" });

const repo = mkdtempSync(join(tmpdir(), "structural-"));
try {
	writeFileSync(join(repo, "sample.ts"), "export const NEEDLE_TOKEN = 1;\nconst other = 2;\n");
	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);

	// Degrade: unknown tool -> status line, exit 0.
	const bogus = runHelper(repo, ["--tool", "nope", "."]);
	assert.ok(bogus.includes("---structural-status---"), `unknown tool must emit status, got:\n${bogus}`);
	assert.ok(/unavailable:/.test(bogus), `unknown tool must be unavailable, got:\n${bogus}`);

	// Degrade: ast-grep with no query -> unavailable (no crash, exit 0).
	const noQuery = runHelper(repo, ["--tool", "ast-grep", "."]);
	assert.ok(/unavailable: ast-grep needs/.test(noQuery), `ast-grep w/o query must be unavailable, got:\n${noQuery}`);

	// Positive (env-gated on rg): a real match emits a ---rg--- block keyed file:line (1-based).
	if (rgPresent) {
		const hit = runHelper(repo, ["--tool", "rg", "--pattern", "NEEDLE_TOKEN", "."]);
		assert.ok(hit.includes("---rg---"), `rg must emit its block, got:\n${hit}`);
		assert.ok(/sample\.ts:1\t/.test(hit), `rg must key the hit at sample.ts:1 (1-based), got:\n${hit}`);
		assert.ok(/matches: 1/.test(hit), `rg must report 1 match, got:\n${hit}`);
	} else {
		console.log("  (rg absent — skipped the positive rg assertion)");
	}
	console.log("OK (structural) — read-only degrade paths + rg block verified.");
} finally {
	rmSync(repo, { recursive: true, force: true });
}
