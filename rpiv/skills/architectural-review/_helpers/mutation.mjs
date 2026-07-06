// mutation.mjs — parse an EXISTING StrykerJS mutation report into a per-file signal
// for the T (test-theater) lens. Read-only: it NEVER runs mutation testing (generating
// a mutation report is a Step-2 checkpoint). Supports the standard StrykerJS JSON
// reporter format. execFileSync-only; always exit 0.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/mutation.mjs" "<target>"
//
// Output:
//   mutation_report:  <which file was parsed | none>
//   mutation_overall: killed=N survived=N score=R%
//   mutation_scope:   target_has=N report_covers=M missing=K  (<"full" | "partial" | "none">)
//   ---mutation---  path \t killed=N \t survived=N \t noCoverage=N \t timeout=N \t score=R%
//                   (source files under target, worst score first)
//
// The `mutation_scope` line tells the T lens whether every target file was covered by
// the mutation run. "full" = the report was likely a full-run — every target file either
// has mutation data or is genuinely clean (no executable code, filtered by StrykerJS).
// "partial" = some target files have no mutation data AND the report was likely scoped —
// missing files are "unknown" to the T lens, not "clean." "none" = no report exists.
//
// The T lens crosses this with coverage and test-density: high coverage + low mutation
// score is definitive test theater — the code is executed but its behavior is not verified.
// When mutation_scope is "partial," the T lens treats missing mutation data as an unknown
// signal rather than evidence of clean code.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return fb;
	}
};
const toPosix = (p) => p.replaceAll("\\", "/");
const root = toPosix(safe(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
const target = toPosix((process.argv[2] ?? ".").replace(/^['"]|['"]$/g, "")) || ".";
const relOf = (k) => {
	const p = toPosix(k);
	return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
};
const underTarget = (rp) => target === "." || rp === target || rp.startsWith(`${target}/`);

// Source file extensions that can contain executable code (same set as metrics.mjs).
// StrykerJS only mutates files with executable code — pure type/interface/const-enum
// files are skipped even in a full run, so they will NOT appear in the mutation report.
const SRC_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs",
]);

const isSrc = (p) => SRC_EXT.has(p.slice(p.lastIndexOf(".") + 1).toLowerCase());
const isTest = (p) => /\.(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)__tests__\//.test(p);

// Walk the target directory to collect source files (exclude tests, declarations, generated).
/** Returns true if a file is an eligible mutation target (source code, not test/declaration). */
const isEligible = (p, rp) => isSrc(p) && !isTest(rp) && !rp.endsWith(".d.ts");

const collectSrc = (dir) => {
	const src = [];
	const abs = join(root, dir);
	if (!existsSync(abs)) return src;
	try {
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			const p = join(abs, entry.name);
			const rp = toPosix(relative(root, p));
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				src.push(...collectSrc(rp));
			} else if (entry.isFile() && isEligible(p, rp)) {
				src.push(rp);
			}
		}
	} catch {
		/* permission error — return what we have */
	}
	return src;
};

// Find a StrykerJS mutation report (ordered by preference: scoped → full → fallback).
const reportPaths = [
	join(root, "reports", "mutation", "mutation.json"),
	join(root, "reports", "mutation.json"),
	join(root, "stryker-output", "mutation.json"),
];

let reportPath = "";
let reportName = "none";
for (const p of reportPaths) {
	if (existsSync(p)) {
		reportPath = p;
		reportName = toPosix(p.slice(root.length + 1));
		break;
	}
}

// --- Scope detection: compare target source files against report coverage ---------
const targetSrcFiles = target === "." ? [] : collectSrc(target);
const reportFileSet = new Set();

if (!reportPath) {
	process.stdout.write("mutation_report: none\n");
	process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (none)\n`);
	process.exit(0);
}

// Parse the StrykerJS JSON report.
// Format (StrykerJS v8+): { files: { "path": { mutants: [{ status, location }], source } } }
//   status ∈ { Killed, Survived, NoCoverage, Timeout, RuntimeError, CompileError }
// Older format (v6-v7): { files: { "path": { mutants: [{ status, location }] } } }
// Fallback: try { files } first, then { results?.files } for wrapped formats.
let report;
try {
	report = JSON.parse(readFileSync(reportPath, "utf-8"));
} catch {
	process.stdout.write(`mutation_report: parse-error\n`);
	process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (parse-error)\n`);
	process.exit(0);
}

const files = report.files ?? report.results?.files ?? {};
if (!files || Object.keys(files).length === 0) {
	process.stdout.write(`mutation_report: ${reportName} (empty)\n`);
	process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (empty)\n`);
	process.exit(0);
}

// Build the set of file paths covered by the report (normalized to repo-relative).
for (const filePath of Object.keys(files)) {
	const rp = toPosix(filePath);
	const rel = relOf(rp) || rp;
	reportFileSet.add(rel);
}

// Determine scope: does this report appear to be a full-project run or a scoped run?
// Heuristic: count how many report files fall OUTSIDE the target. If the report
// contains files well outside the target's subtree, it was a broader run (likely full).
// If ALL report files are within the target, the report was scoped to just this area.
let outsideTarget = 0;
for (const f of reportFileSet) {
	if (!underTarget(f)) outsideTarget += 1;
}
// A report with 3+ files outside the target is almost certainly a full run.
// A report with 1-2 outside files could be a scoped run that picked up dependencies.
// Use a threshold: >= 3 outside files or outside files in >= 2 sibling directories.
const outsideDirs = new Set();
for (const f of reportFileSet) {
	if (!underTarget(f)) {
		const slash = f.indexOf("/");
		const d = slash >= 0 ? f.slice(0, f.lastIndexOf("/")) : ".";
		outsideDirs.add(d);
	}
}
const hasOutsideFiles = outsideTarget >= 3 || outsideDirs.size >= 2;

// Count how many target source files have mutation data.
let covered = 0;
for (const sf of targetSrcFiles) {
	if (reportFileSet.has(sf)) covered += 1;
}
const missing = targetSrcFiles.length - covered;

// Scope classification:
// - "full": report covers files outside the target (different top-level dirs) →
//          likely a full-project mutation run. Missing files are genuinely clean
//          (no executable code — StrykerJS filtered them).
// - "partial": report only covers files within/near the target → likely a scoped run.
//          Missing files might have executable code but weren't mutated.
// - "detected": target is "." (whole repo) — can't distinguish; treat as "full" but note.
let scope;
if (target === ".") {
	scope = "detected";  // whole-repo target — report IS the target
} else if (hasOutsideFiles) {
	scope = "full";      // report covers unrelated directories → full run
} else {
	scope = reportFileSet.size > 0 ? "partial" : "none";
}

let overallKilled = 0;
let overallSurvived = 0;

const rows = [];
for (const [filePath, data] of Object.entries(files)) {
	const rp = toPosix(filePath);
	if (!underTarget(rp) && !underTarget(relOf(rp))) continue;

	const mutants = data.mutants ?? [];
	if (mutants.length === 0) continue;

	let killed = 0;
	let survived = 0;
	let noCoverage = 0;
	let timeout = 0;

	for (const m of mutants) {
		const s = String(m.status ?? "").toLowerCase();
		if (s === "killed") killed += 1;
		else if (s === "survived") survived += 1;
		else if (s === "nocoverage") noCoverage += 1;
		else if (s === "timeout") timeout += 1;
		// RuntimeError / CompileError / Ignored — not counted against score
	}

	const total = killed + survived + noCoverage + timeout;
	if (total === 0) continue;

	// Score: killed / (killed + survived) — excludes NoCoverage and Timeout
	// (NoCoverage = no test covers the mutant → not a theater signal;
	//  Timeout = timeout, not informative for verification quality)
	const denom = killed + survived;
	const score = denom > 0 ? Math.round((killed / denom) * 100) : 0;

	const rel = relOf(rp) || rp;
	rows.push({ f: rel, killed, survived, noCoverage, timeout, score });

	overallKilled += killed;
	overallSurvived += survived;
}

// Sort worst-score-first (lowest mutation score = most theater).
rows.sort((a, b) => a.score - b.score || b.survived - a.survived);

const overallDenom = overallKilled + overallSurvived;
const overallScore = overallDenom > 0 ? Math.round((overallKilled / overallDenom) * 100) : 0;

const head = [
	`mutation_report: ${reportName}`,
	`mutation_overall: killed=${overallKilled} survived=${overallSurvived} score=${overallScore}%`,
	`mutation_scope: target_has=${targetSrcFiles.length} report_covers=${covered} missing=${missing} (${scope})`,
];
const body = rows.map((r) =>
	`${r.f}\tkilled=${r.killed}\tsurvived=${r.survived}\tnoCoverage=${r.noCoverage}\ttimeout=${r.timeout}\tscore=${r.score}%`,
).join("\n");

process.stdout.write(`${head.join("\n")}\n---mutation---\n${body}\n`);
process.exit(0);
