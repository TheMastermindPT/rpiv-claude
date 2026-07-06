// mutation.test.mjs — golden-fixture test for mutation.mjs. Builds a throwaway repo
// with source files and a StrykerJS JSON report, then asserts mutation_scope, per-file
// rows, and edge cases (no report, partial coverage, test exclusions).
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/mutation.test.mjs"
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MUTATION = join(dirname(fileURLToPath(import.meta.url)), "mutation.mjs");
const git = (repo, args) =>
	execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });

/** Extract the lines of a `---label---` block from mutation.mjs output. */
const extractBlock = (text, label) => {
	const lines = text.split("\n");
	const start = lines.indexOf(`---${label}---`);
	if (start < 0) return [];
	const rows = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		if (lines[i].startsWith("---")) break;
		if (lines[i].trim()) rows.push(lines[i]);
	}
	return rows;
};

// --- helpers ----------------------------------------------------------------

const makeStrykerReport = (files) => {
	const fileData = {};
	for (const f of files) {
		fileData[f] = {
			mutants: [
				{ id: `${f}-m1`, fileName: f, status: "Killed" },
				{ id: `${f}-m2`, fileName: f, status: "Killed" },
				{ id: `${f}-m3`, fileName: f, status: "Survived" },
			],
		};
	}
	return JSON.stringify({ files: fileData }, null, 2);
};

// --- Test 1: no report exists -----------------------------------------------

const repo1 = mkdtempSync(join(tmpdir(), "mut-norep-"));
try {
	mkdirSync(join(repo1, "src"), { recursive: true });
	writeFileSync(join(repo1, "src", "app.ts"), "export function run() { return 1 + 1; }\n");
	writeFileSync(join(repo1, "src", "app.test.ts"), "import { run } from './app'; run();\n");
	git(repo1, ["init", "-q"]);
	git(repo1, ["add", "-A"]);

	const out = execFileSync("node", [MUTATION, "."], { cwd: repo1, encoding: "utf-8" });
	assert.ok(out.includes("mutation_report: none"), "no-report: mutation_report must be none");
	assert.ok(out.includes("mutation_scope:"), "no-report: mutation_scope emitted");
	assert.ok(out.includes("(none)"), "no-report: scope is none");
	// No mutation_overall or ---mutation--- block when there is no report (early exit)
	assert.ok(!out.includes("mutation_overall:"), "no-report: no mutation_overall (early exit)");
	const rows = extractBlock(out, "mutation");
	assert.equal(rows.length, 0, "no-report: no mutation rows");
	console.log("OK — no report: scope=none, early exit, no rows.");
} finally {
	rmSync(repo1, { recursive: true, force: true });
}

// --- Test 2: full-run report covers all sources -----------------------------

const repo2 = mkdtempSync(join(tmpdir(), "mut-partial-covered-"));
try {
	mkdirSync(join(repo2, "src"), { recursive: true });
	mkdirSync(join(repo2, "reports", "mutation"), { recursive: true });
	writeFileSync(join(repo2, "src", "calc.ts"), "export function add(a: number, b: number) { return a + b; }\n");
	writeFileSync(join(repo2, "src", "util.ts"), "export function ident(x: number) { return x; }\n");
	// Report covers only calc.ts — util.ts is missing from report -> missing=1, partial
	const report = makeStrykerReport(["src/calc.ts"]);
	writeFileSync(join(repo2, "reports", "mutation", "mutation.json"), report);
	git(repo2, ["init", "-q"]);
	git(repo2, ["add", "-A"]);

	const out = execFileSync("node", [MUTATION, "src"], { cwd: repo2, encoding: "utf-8" });
	assert.ok(out.includes("mutation_overall: killed=2 survived=1 score=67%"), `partial-covered: overall must be 2k/1s/67%, got: ${out}`);
	assert.ok(out.includes("(partial)"), `partial-covered: scope must be partial, got: ${out}`);
	assert.ok(out.includes("missing=1"), "partial-covered: one source file missing from report");
	const rows = extractBlock(out, "mutation");
	assert.equal(rows.length, 1, "partial-covered: only calc.ts in mutation rows");
	assert.ok(/src\/calc\.ts\tkilled=2\tsurvived=1/.test(out), "calc should have 2 killed 1 survived");
	console.log("OK — partial coverage: one file scored, scope=partial, missing=1.");
} finally {
	rmSync(repo2, { recursive: true, force: true });
}

// --- Test 3: partial report — some sources missing --------------------------

const repo3 = mkdtempSync(join(tmpdir(), "mut-part-"));
try {
	mkdirSync(join(repo3, "src"), { recursive: true });
	mkdirSync(join(repo3, "reports", "mutation"), { recursive: true });
	writeFileSync(join(repo3, "src", "covered.ts"), "export function f() { return 1; }\n");
	writeFileSync(join(repo3, "src", "skipped-by-stryker.ts"), "export type T = string;\n"); // .d.ts-ish
	writeFileSync(join(repo3, "src", "uncovered.ts"), "export function g() { return 2; }\n");
	const report = makeStrykerReport(["src/covered.ts"]); // only one of three
	writeFileSync(join(repo3, "reports", "mutation", "mutation.json"), report);
	git(repo3, ["init", "-q"]);
	git(repo3, ["add", "-A"]);

	const out = execFileSync("node", [MUTATION, "src"], { cwd: repo3, encoding: "utf-8" });
	assert.ok(out.includes("(partial)"), `partial: scope must be partial, got: ${out}`);
	// skipped-by-stryker.ts is a declaration-like file — excluded by isSrc already
	assert.ok(out.includes("missing=2"), `partial: two source files missing from report, got: ${out}`);
	const rows = extractBlock(out, "mutation");
	assert.equal(rows.length, 1, "partial: only covered.ts appears in mutation rows");
	assert.ok(/src\/covered\.ts\tkilled=2\tsurvived=1/.test(out), "covered.ts scored correctly");
	console.log("OK — partial report: missing=1, scope=partial, only covered file scored.");
} finally {
	rmSync(repo3, { recursive: true, force: true });
}

// --- Test 4: test and declaration files excluded -----------------------------

const repo4 = mkdtempSync(join(tmpdir(), "mut-excl-"));
try {
	mkdirSync(join(repo4, "src"), { recursive: true });
	mkdirSync(join(repo4, "reports", "mutation"), { recursive: true });
	writeFileSync(join(repo4, "src", "logic.ts"), "export function h() { return 3; }\n");
	writeFileSync(join(repo4, "src", "logic.test.ts"), "import { h } from './logic'; h();\n");
	writeFileSync(join(repo4, "src", "logic.spec.ts"), "// spec\n");
	writeFileSync(join(repo4, "src", "types.d.ts"), "export type X = number;\n");
	const report = makeStrykerReport(["src/logic.ts", "src/logic.test.ts", "src/logic.spec.ts"]);
	writeFileSync(join(repo4, "reports", "mutation", "mutation.json"), report);
	git(repo4, ["init", "-q"]);
	git(repo4, ["add", "-A"]);

	const out = execFileSync("node", [MUTATION, "src"], { cwd: repo4, encoding: "utf-8" });
	// Test files and .d.ts files are excluded from collectSrc, so they aren't counted
	// as target sources — the report covers the 1 eligible source file.
	assert.ok(out.includes("(partial)"), `excl: should be partial (report has test files but no outside-target files), got: ${out}`);
	assert.ok(out.includes("missing=0"), `excl: no eligible files missing, got: ${out}`);
	const rows = extractBlock(out, "mutation");
	// mutation.mjs reports all files from the Stryker report, including test files —
	// only collectSrc (for scope counting) excludes them. So we see 3 rows here.
	assert.equal(rows.length, 3, "excl: all 3 report files appear in mutation rows (includes test)");
	assert.ok(/src\/logic\.ts\tkilled=2\tsurvived=1/.test(out), "logic.ts scored");
	console.log("OK — exclusions: test/spec/.d.ts excluded from source count, mutation rows include report files.");
} finally {
	rmSync(repo4, { recursive: true, force: true });
}

// --- Test 5: collectSrc skips node_modules and .git -------------------------

const repo5 = mkdtempSync(join(tmpdir(), "mut-skip-"));
try {
	mkdirSync(join(repo5, "src"), { recursive: true });
	mkdirSync(join(repo5, "node_modules", "pkg"), { recursive: true });
	mkdirSync(join(repo5, ".git", "objects"), { recursive: true });
	writeFileSync(join(repo5, "src", "real.ts"), "export function r() { return 4; }\n");
	writeFileSync(join(repo5, "node_modules", "pkg", "fake.ts"), "export function f() { return 5; }\n");
	writeFileSync(join(repo5, ".git", "objects", "noise.ts"), "export function n() { return 6; }\n");
	git(repo5, ["init", "-q"]);
	git(repo5, ["add", "src/real.ts"]); // only add the real file

	const out = execFileSync("node", [MUTATION, "src"], { cwd: repo5, encoding: "utf-8" });
	assert.ok(out.includes("(none)"), "skip-dirs: no report, scope=none");
	// The target_has count in mutation_scope reflects only eligible source files
	assert.ok(/target_has=1\b/.test(out), `skip-dirs: only src/real.ts counted, got: ${out}`);
	console.log("OK — skip dirs: node_modules and .git excluded from collectSrc.");
} finally {
	rmSync(repo5, { recursive: true, force: true });
}
