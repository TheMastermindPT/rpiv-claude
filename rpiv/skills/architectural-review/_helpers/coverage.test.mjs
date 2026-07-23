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

// --- Multi-target union (dogfooding A): rows for files under ANY target ------
const repo2 = mkdtempSync(join(tmpdir(), "cov-multi-"));
try {
	mkdirSync(join(repo2, "a"), { recursive: true });
	mkdirSync(join(repo2, "b"), { recursive: true });
	mkdirSync(join(repo2, "coverage"), { recursive: true });
	git(repo2, ["init", "-q"]);
	const root2 = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo2, encoding: "utf-8" }).trim();
	const cell2 = (pct) => ({ statements: { pct }, branches: { pct }, functions: { pct }, lines: { pct } });
	writeFileSync(
		join(repo2, "coverage/coverage-summary.json"),
		JSON.stringify({
			total: cell2(50),
			[`${root2}/a/x.ts`]: cell2(80),
			[`${root2}/b/y.ts`]: cell2(60),
		}),
	);

	const both = execFileSync("node", [COV, "a", "b"], { cwd: repo2, encoding: "utf-8" });
	assert.ok(both.includes("a/x.ts") && both.includes("b/y.ts"), `union run must emit rows for BOTH targets\n${both}`);
	const single = execFileSync("node", [COV, "a"], { cwd: repo2, encoding: "utf-8" });
	assert.ok(single.includes("a/x.ts") && !single.includes("b/y.ts"), `single-target run must emit only a/x.ts\n${single}`);
	assert.ok(!both.includes("note: targets span"), `same project root -> no span note\n${both}`);
	console.log("OK (coverage multi-target) — union emits rows under ANY target; single-target unchanged.");
} finally {
	rmSync(repo2, { recursive: true, force: true });
}

// --- Multi-PROJECT targets: the report anchor is announced (M2) --------------
const repo3 = mkdtempSync(join(tmpdir(), "cov-span-"));
try {
	mkdirSync(join(repo3, "pkgA"), { recursive: true });
	mkdirSync(join(repo3, "pkgB"), { recursive: true });
	writeFileSync(join(repo3, "pkgA", "package.json"), JSON.stringify({ name: "a" }));
	writeFileSync(join(repo3, "pkgB", "package.json"), JSON.stringify({ name: "b" }));
	git(repo3, ["init", "-q"]);
	const out3 = execFileSync("node", [COV, "pkgA", "pkgB"], { cwd: repo3, encoding: "utf-8" });
	assert.ok(
		out3.includes("note: targets span 2 project roots — coverage read from the first"),
		`multi-project targets must announce the coverage anchor, got:\n${out3}`,
	);
	console.log("OK (coverage span note) — multi-project anchor announced, never silent.");
} finally {
	rmSync(repo3, { recursive: true, force: true });
}
