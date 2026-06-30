// coverage.test.mjs — golden-fixture test for coverage.mjs (Istanbul summary parsing).
// Builds a throwaway repo with a crafted coverage-summary.json and asserts the per-file
// stmt/branch/fn signal the T lens consumes. No dependencies; prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COV = join(dirname(fileURLToPath(import.meta.url)), "coverage.mjs");
const git = (repo, args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });

const repo = mkdtempSync(join(tmpdir(), "cov-"));
try {
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(repo, "coverage"), { recursive: true });
	git(repo, ["init", "-q"]);
	// Compute root exactly as coverage.mjs will, so the absolute keys relativize correctly.
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf-8" }).trim();
	const cell = (pct) => ({ statements: { pct }, branches: { pct }, functions: { pct }, lines: { pct } });
	const summary = {
		total: cell(50),
		[`${root}/src/covered.ts`]: cell(100),
		[`${root}/src/uncovered.ts`]: cell(0),
	};
	writeFileSync(join(repo, "coverage/coverage-summary.json"), JSON.stringify(summary));

	const out = execFileSync("node", [COV, "."], { cwd: repo, encoding: "utf-8" });
	const rowFor = (name) => out.split("\n").find((l) => l.includes(`src/${name}`));
	assert.ok(out.includes("coverage_overall: stmt=50% branch=50% fn=50%"), `overall line missing\n${out}`);
	assert.ok(/branch=100%/.test(rowFor("covered.ts")), `covered.ts must be branch=100%, got: ${rowFor("covered.ts")}\n${out}`);
	assert.ok(/branch=0%/.test(rowFor("uncovered.ts")), `uncovered.ts must be branch=0%, got: ${rowFor("uncovered.ts")}\n${out}`);
	console.log("OK (coverage) — summary.json parsed: per-file stmt/branch/fn + overall.");
} finally {
	rmSync(repo, { recursive: true, force: true });
}
