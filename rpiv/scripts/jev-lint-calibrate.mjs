// scripts/jev-lint-calibrate.mjs — calibration report for the jev-row-lint bands.
//
// Joins the lint shadow log (every Jev judgment) with human labels, then
// prints: verdict-tier confusion counts, per-bucket accuracy (the real
// calibration curve), and suggested per-instance bands derived from it.
//
// Labels live in reports/jev-lint-labels.jsonl, one JSON per line:
//   { "ts": "<log entry ts>", "id": "<optional row id>", "correct": true|false }
// `correct: true` means the lint's treatment of that row was right — a FLAG
// that was justified, or a silence that was safe. The optional `id` disambiguates
// rows judged in the same millisecond.
//
// Usage:
//   node scripts/jev-lint-calibrate.mjs                  # full report
//   node scripts/jev-lint-calibrate.mjs --agent claim-verifier
//   node scripts/jev-lint-calibrate.mjs --label <ts> agree [--id <id>]
//   node scripts/jev-lint-calibrate.mjs --label <ts> disagree [--id <id>]

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readLogEntries } from "./jev-gate.mjs";
import { readCommittedRows } from "./jev-source-store.mjs";

export const LINT_LOG_PATH = "reports/jev-lint-shadow.log";
export const LABELS_PATH = "reports/jev-lint-labels.jsonl";

// Suggestion guards: only consider buckets with at least MIN_PER_BUCKET
// labeled rows, and only suggest a band when at least MIN_TOTAL labeled rows
// back it.
export const MIN_PER_BUCKET = 3;
export const MIN_TOTAL = 20;
export const OK_ACCURACY = 0.95;
export const FLAG_WRONG_RATE = 0.6;

export function readLines(path) {
	try {
		return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return [];
	}
}

/** Lint-log rows, the rotated `<log>.1` first (S32, D42), plus committed
 * source batches; a row present more than once is kept once. */
export function readLog(path = LINT_LOG_PATH, onDiagnostic = reportLogError) {
	const diagnosticRows = [];
	for (const { file, number, text } of readLogEntries(path)) {
		if (!text.trim()) continue;
		try {
			diagnosticRows.push(JSON.parse(text));
		} catch {
			onDiagnostic(
				`malformed diagnostic JSON at line ${number} in ${file}; reporting valid and committed rows only`,
			);
		}
	}
	const rows = [...diagnosticRows, ...readCommittedRows(path)];
	return [...new Map(rows.map((row) => [JSON.stringify(row), row])).values()];
}

function reportLogError(message) {
	process.stderr.write(`[jev-calibrate] BROKEN INPUT: ${message}\n`);
}

/** Labels keyed by ts; malformed lines and entries without ts are skipped. */
export function readLabels(path = LABELS_PATH) {
	const byTs = new Map();
	for (const line of readLines(path)) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry.ts !== "string" || typeof entry.correct !== "boolean") {
			continue;
		}
		const list = byTs.get(entry.ts) ?? [];
		list.push(entry);
		byTs.set(entry.ts, list);
	}
	return byTs;
}

export function appendLabel(path, { ts, id, correct }) {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify({ ts, id, correct })}\n`, "utf8");
}

/** Match a label list for one ts: exact id match wins, else a label without id. */
function findLabel(labelList, id) {
	if (!labelList?.length) return null;
	return (
		labelList.findLast((l) => l.id === id) ??
		labelList.findLast((l) => l.id == null) ??
		null
	);
}

export function bucketOf(p) {
	return Math.min(9, Math.max(0, Math.floor(p * 10)));
}

/**
 * Pure report builder. Returns a data object; renderReport() formats it.
 * Each labeled row gets a single `wrong` measure: the row was actually
 * mis-labeled and needed different treatment (a flag that was justified,
 * a silence that was a miss, a review that was warranted).
 */
export function buildReport(log, labels, agentFilter) {
	const entries = agentFilter
		? log.filter((e) => e.agent === agentFilter)
		: log;
	const rows = entries.map((entry) => labeledRow(entry, labels));
	const judged = rows.filter((r) => typeof r.p === "number");
	const labeled = judged.filter((r) => r.labeled);
	const broken = rows.filter((r) => r.broken).length;

	const tiers = {};
	for (const verdict of ["flag", "review", "ok"]) {
		const v = labeled.filter((r) => r.verdict === verdict);
		tiers[verdict] = {
			total: judged.filter((r) => r.verdict === verdict).length,
			labeled: v.length,
			actuallyWrong: v.filter((r) => r.wrong).length,
		};
	}

	const buckets = [];
	for (let b = 0; b <= 9; b++) {
		const inBucket = labeled.filter((r) => bucketOf(r.p) === b);
		const wrong = inBucket.filter((r) => r.wrong).length;
		buckets.push({
			lo: b / 10,
			hi: (b + 1) / 10,
			n: inBucket.length,
			wrongRate: inBucket.length > 0 ? wrong / inBucket.length : null,
		});
	}

	const suggestions = suggestBands(buckets);
	const unlabeledWarnings = rows.filter(
		(r) => !r.labeled && (r.verdict === "flag" || r.verdict === "review"),
	);
	const unlabeledSilent = rows.filter((r) => !r.labeled && r.verdict === "ok");

	return {
		agentFilter,
		total: rows.length,
		judged: judged.length,
		labeled: labeled.length,
		broken,
		tiers,
		buckets,
		suggestions,
		unlabeledWarnings,
		unlabeledSilent,
		agents: [...new Set(rows.map((r) => r.agent))],
	};
}

/**
 * Band suggestions from the wrong-rate curve (fraction of rows per bucket
 * that were actually mis-labeled):
 *   okBar — lowest boundary such that every bucket at or above it is at most
 *           1 - OK_ACCURACY wrong (silence is safe there), with enough data.
 *   flagBar — highest boundary such that every bucket at or below it is at
 *           least FLAG_WRONG_RATE wrong (flags worth reading).
 * Both are null when the minimum-data guards cannot be met.
 */
function labeledRow(entry, labels) {
	const label = findLabel(labels.get(entry.ts), entry.id);
	const correct = label?.correct;
	const wrong =
		correct == null ? null : entry.verdict === "ok" ? !correct : correct;
	return { ...entry, labeled: Boolean(label), correct, wrong };
}

export function suggestBands(buckets) {
	const passes = (windowBuckets, predicate) => {
		const usable = windowBuckets.filter(
			(x) => x.n >= MIN_PER_BUCKET && x.wrongRate != null,
		);
		const totalN = windowBuckets.reduce((sum, x) => sum + x.n, 0);
		return (
			usable.length === windowBuckets.length &&
			totalN >= MIN_TOTAL &&
			windowBuckets.every(predicate)
		);
	};

	const okBar =
		buckets.find((_bucket, b) =>
			passes(buckets.slice(b), (x) => x.wrongRate <= 1 - OK_ACCURACY),
		)?.lo ?? null;
	const flagBar =
		buckets.findLast((_bucket, b) =>
			passes(buckets.slice(0, b + 1), (x) => x.wrongRate >= FLAG_WRONG_RATE),
		)?.hi ?? null;

	return { okBar, flagBar };
}

export function renderReport(report) {
	const lines = [];
	const scope = report.agentFilter ? ` for ${report.agentFilter}` : "";
	lines.push(`# jev-lint calibration${scope}`);
	lines.push(
		`rows=${report.total} judged=${report.judged} labeled=${report.labeled} broken=${report.broken}`,
	);
	if (!report.agentFilter) {
		lines.push(`agents: ${report.agents.join(", ")}`);
	}
	lines.push("");
	lines.push("## Verdict tiers (labeled rows)");
	lines.push("| tier | total | labeled | actually wrong |");
	lines.push("| --- | --- | --- | --- |");
	for (const [tier, t] of Object.entries(report.tiers)) {
		lines.push(`| ${tier} | ${t.total} | ${t.labeled} | ${t.actuallyWrong} |`);
	}
	lines.push("");
	lines.push("## Wrong-rate per probability bucket (labeled rows)");
	lines.push("| p range | n | wrong rate |");
	lines.push("| --- | --- | --- |");
	for (const b of report.buckets) {
		const wr = b.wrongRate == null ? "—" : `${(b.wrongRate * 100).toFixed(0)}%`;
		lines.push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${wr} |`);
	}
	lines.push("");
	const { okBar, flagBar } = report.suggestions;
	lines.push("## Suggested per-instance bands");
	lines.push(
		`okBar:   ${okBar == null ? "insufficient data" : okBar.toFixed(1)} (silence above is >= ${(OK_ACCURACY * 100).toFixed(0)}% safe)`,
	);
	lines.push(
		`flagBar: ${flagBar == null ? "insufficient data" : flagBar.toFixed(1)} (flags below are >= ${(FLAG_WRONG_RATE * 100).toFixed(0)}% justified)`,
	);
	lines.push("");
	lines.push(
		`## Unlabeled warnings (${report.unlabeledWarnings.length}) — adjudicate with --label <ts> agree|disagree`,
	);
	for (const w of report.unlabeledWarnings.slice(0, 10)) {
		lines.push(
			`- ${w.ts} ${w.verdict.toUpperCase()} ${w.id} tag=${w.tag} p=${w.p?.toFixed(2)}`,
		);
		lines.push(`  ${w.row}`);
	}
	if (report.unlabeledWarnings.length > 10) {
		lines.push(`  ... ${report.unlabeledWarnings.length - 10} more`);
	}
	lines.push("");
	lines.push(
		`## Silent spot-check sample (${report.unlabeledSilent.length} unlabeled ok rows)`,
	);
	for (const w of report.unlabeledSilent.slice(-5)) {
		lines.push(`- ${w.ts} ok ${w.id} tag=${w.tag} p=${w.p?.toFixed(2)}`);
		lines.push(`  ${w.row}`);
	}
	// Preserve report formatting while making terminal escape sequences inert.
	return lines.join("\n").replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberately neutralize terminal control bytes from agent-authored fields.
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function parseArgs(argv) {
	const out = { tsValue: null, verdict: null, id: null, agent: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--label") {
			out.tsValue = argv[++i];
			out.verdict = argv[++i];
		} else if (argv[i] === "--agent") out.agent = argv[++i];
		else if (argv[i] === "--id") out.id = argv[++i];
	}
	return out;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	const args = parseArgs(process.argv.slice(2));
	if (args.tsValue) {
		const correct = args.verdict === "agree" || args.verdict === "disagree";
		if (!correct) {
			process.stderr.write("usage: --label <ts> agree|disagree [--id <id>]\n");
			process.exit(2);
		}
		appendLabel(LABELS_PATH, {
			ts: args.tsValue,
			id: args.id,
			correct: args.verdict === "agree",
		});
		process.stdout.write(`labeled ${args.tsValue} ${args.verdict}\n`);
	} else {
		const report = buildReport(readLog(), readLabels(), args.agent);
		process.stdout.write(`${renderReport(report)}\n`);
	}
}
