// mutation.mjs — parse an EXISTING StrykerJS mutation report into a per-file signal
// for the T (test-theater) lens. Read-only: it NEVER runs mutation testing (generating
// a mutation report is a Step-2 checkpoint). Supports the standard StrykerJS JSON
// reporter format. execFileSync-only; always exit 0.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/mutation.mjs" "<target>"
//
// Output:
//   mutation_report:  <which file was parsed | none | html-only — ... | stale-json — ...
//                      (json predates a sibling html: an html-only reporter config left an
//                       old json in place — refused, never parsed as current data)>
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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSource, isTest } from "./source-set.mjs";
import { resolveTargets, safeGit, toPosix } from "./target-context.mjs";

// Target, enumeration, and report keys are all emitted relative to the invocation
// cwd — the base the skill's T-lens agent and `store --root .` use. Identical to the
// git toplevel on a normal repo (cwd === toplevel); correct when nested under it.
// Project root = nearest package.json at/above the FIRST target, bounded by the git toplevel.
const { targets, projectRoots, projectRoot, relOf, underAny } = resolveTargets(process.argv.slice(2));
const wholeRepo = targets.some((t) => t.target === ".");

// Multi-project visibility (M2 — never silently anchor). Anchored HERE, not at any
// single mutation_report emission site: there are four (none/parse-error/empty/head),
// and a head-only anchor would drop the note on every early-exit branch.
if (projectRoots.length > 1) {
	process.stdout.write(`note: targets span ${projectRoots.length} project roots — reports read from the first\n`);
}

// Enumerate tracked source files under the target (exclude tests, declarations).
// StrykerJS only mutates files with executable code — pure type/interface/const-enum
// files are skipped even in a full run, so they will NOT appear in the mutation report.
/** Returns true if a file is an eligible mutation target (source code, not test/declaration). */
const isEligible = (p, rp) => isSource(p) && !isTest(rp) && !rp.endsWith(".d.ts");

// Tracked files only, via git — same idiom as metrics.mjs. Bounds the enumeration
// to the repository: an arbitrary argv target can never walk outside the root,
// and node_modules/.git never appear because they are not tracked.
const collectSrc = (dirs) => {
	// Enumerate from the process cwd so paths come back cwd-relative (matching relOf
	// and the report keys); ls-files still lists tracked files only, so an arbitrary
	// argv target can never escape the repo and node_modules/.git never appear.
	// git unions multiple pathspecs natively.
	const raw = safeGit(["ls-files", "-z", "--", ...dirs]);
	if (!raw) return [];
	return raw
		.split("\0")
		.filter(Boolean)
		.map(toPosix)
		.filter((rp) => isEligible(rp, rp));
};

// Find a StrykerJS mutation report (ordered by preference: scoped → full → fallback).
const reportPaths = [
	join(projectRoot, "reports", "mutation", "mutation.json"),
	join(projectRoot, "reports", "mutation.json"),
	join(projectRoot, "stryker-output", "mutation.json"),
];

let reportPath = "";
let reportName = "none";
for (const p of reportPaths) {
	if (existsSync(p)) {
		reportPath = p;
		reportName = toPosix(p.slice(projectRoot.length + 1));
		break;
	}
}

// --- Scope detection: compare target source files against report coverage ---------
const targetSrcFiles = wholeRepo ? [] : collectSrc(targets.map((t) => t.target));
const reportFileSet = new Set();

if (!reportPath) {
	// Broken != absent (M2 / dogfooding B): an HTML-only report means mutation RAN but
	// is not machine-ingestable — distinct from no report, with the add-json remedy.
	let htmlOnly = "";
	try {
		const html = readdirSync(join(projectRoot, "reports", "mutation")).find((f) => f.endsWith(".html"));
		if (html) htmlOnly = `reports/mutation/${html}`;
	} catch {
		/* reports/mutation dir absent — plain none */
	}
	if (htmlOnly) {
		process.stdout.write(`mutation_report: html-only — ${htmlOnly} (add "json" to stryker reporters for machine ingest)\n`);
		process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (html-only)\n`);
		process.exit(0);
	}
	process.stdout.write("mutation_report: none\n");
	process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (none)\n`);
	process.exit(0);
}

// Freshness cross-check (dogfooding #2): an HTML-only reporter config leaves the last
// json in place, so a fresh 20-minute run can silently "produce" a weeks-old json.
// A sibling .html markedly newer than the json means the json is from an EARLIER run —
// a distinct broken state (degrade-distinguishes-broken), never parsed as current data.
// 60s of slack covers same-run reporter ordering (html and json written seconds apart).
{
	let htmlPath = "";
	let htmlMtime = 0;
	try {
		const dir = join(projectRoot, "reports", "mutation");
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".html")) continue;
			const m = statSync(join(dir, f)).mtimeMs;
			if (m > htmlMtime) {
				htmlMtime = m;
				htmlPath = `reports/mutation/${f}`;
			}
		}
	} catch {
		/* no reports/mutation dir — nothing to cross-check */
	}
	const lag = htmlMtime - statSync(reportPath).mtimeMs;
	if (htmlPath && lag > 60_000) {
		const age = lag >= 86_400_000 ? `${(lag / 86_400_000).toFixed(1)}d` : `${(lag / 3_600_000).toFixed(1)}h`;
		process.stdout.write(
			`mutation_report: stale-json — ${reportName} is ${age} older than ${htmlPath} (json is from an earlier run; add "json" to stryker reporters and re-run, or extract ${htmlPath}'s embedded report — it is a JS assignment, not plain JSON)\n`,
		);
		process.stdout.write(`mutation_scope: target_has=${targetSrcFiles.length} report_covers=0 missing=${targetSrcFiles.length} (stale-json)\n`);
		process.exit(0);
	}
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
	if (!underAny(f)) outsideTarget += 1;
}
// A report with 3+ files outside the target is almost certainly a full run.
// A report with 1-2 outside files could be a scoped run that picked up dependencies.
// Use a threshold: >= 3 outside files or outside files in >= 2 sibling directories.
const outsideDirs = new Set();
for (const f of reportFileSet) {
	if (!underAny(f)) {
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
if (wholeRepo) {
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
	if (!underAny(rp) && !underAny(relOf(rp))) continue;

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
