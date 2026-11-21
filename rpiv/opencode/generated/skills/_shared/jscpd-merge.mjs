// jscpd-merge.mjs — the single owner of how rpiv combines several jscpd/cpd reports of the
// same tree into one clone list.
//
// Why two reports exist at all: on TypeScript, neither of cpd's readers is complete (5.0.11-5.4.3).
// The `javascript` reader (with --formats-exts "javascript:ts,tsx,mts,cts,jsx") finds the
// most clones; cpd's own `typescript` reader counts the same code as fewer tokens, so the
// same clone falls under --min-tokens (22 vs 48 clones on one real lib/). But in annotated
// files the javascript reader counts comment words as code, so a copy that gained a comment
// splits into halves too small to report — clones only the typescript reader finds (24-34
// per real repo). Running both and merging here is what recovers both sets.
//
// Merge rule: clones are matched ACROSS reports only — never within one. cpd itself reports
// adjacent blocks that share a boundary line as separate clones, and those stay separate.
// A clone from a later report is the SAME clone as an earlier-report clone when both join
// the same two files and their line ranges overlap on both sides (in either orientation).
// It replaces that clone when it overlaps exactly one and spans more lines (then more
// tokens); it is dropped when an earlier clone already covers it; otherwise it is added.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/jscpd-merge.mjs" <report.json>...
//
// Prints { duplicates, passes: [{ report, clones }] } as JSON on stdout. Per
// degrade-distinguishes-broken, a missing, unreadable or malformed report is never merged
// as if it were empty: the CLI prints `jscpd-merge: BROKEN <path>: <cause>` on stderr and
// exits 2 with no stdout.
//
// Importable: mergeCpdReports.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const overlaps = (a, b) =>
	a.name === b.name && a.start <= b.end && b.start <= a.end;

/** True when two clones join the same two file regions, whichever side cpd listed first. */
const sameClone = (x, y) =>
	(overlaps(x.firstFile, y.firstFile) &&
		overlaps(x.secondFile, y.secondFile)) ||
	(overlaps(x.firstFile, y.secondFile) && overlaps(x.secondFile, y.firstFile));

/** True when `a` should win over `b`: more lines, then more tokens. */
const isLarger = (a, b) =>
	a.lines > b.lines ||
	(a.lines === b.lines && (a.tokens ?? 0) > (b.tokens ?? 0));

/** Fold one later report into `kept` (clones from earlier reports only). */
function foldReport(kept, duplicates) {
	const earlier = kept.length; // only these may match — never this report's own clones
	for (const d of duplicates) {
		const hits = [];
		for (let i = 0; i < earlier; i += 1)
			if (sameClone(kept[i], d)) hits.push(i);
		if (hits.length === 0) kept.push(d);
		else if (hits.length === 1 && isLarger(d, kept[hits[0]])) kept[hits[0]] = d;
	}
}

/**
 * Union of every report's `duplicates`, one entry per clone seen by more than one report.
 * @param {Array<{duplicates: object[]}>} reports parsed jscpd JSON reports
 * @returns {{duplicates: object[]}}
 */
export function mergeCpdReports(reports) {
	const kept = [];
	for (const r of reports) foldReport(kept, r.duplicates);
	return { duplicates: kept };
}

/** Parsed report, or a BROKEN cause — never a stand-in empty report. */
function readReport(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return {
			broken:
				err.code === "ENOENT" ? "no such file" : `unreadable (${err.message})`,
		};
	}
	if (!Array.isArray(parsed?.duplicates))
		return { broken: "not a jscpd report (no duplicates array)" };
	return { report: parsed };
}

function main(paths) {
	if (paths.length === 0) {
		process.stderr.write("usage: jscpd-merge.mjs <report.json>...\n");
		return 2;
	}
	const reports = [];
	for (const path of paths) {
		const r = readReport(path);
		if (r.broken) {
			process.stderr.write(`jscpd-merge: BROKEN ${path}: ${r.broken}\n`);
			return 2;
		}
		reports.push(r.report);
	}
	const merged = mergeCpdReports(reports);
	const passes = paths.map((report, i) => ({
		report,
		clones: reports[i].duplicates.length,
	}));
	process.stdout.write(`${JSON.stringify({ ...merged, passes }, null, 2)}\n`);
	return 0;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = main(process.argv.slice(2));
}
