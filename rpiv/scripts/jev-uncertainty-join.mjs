// scripts/jev-uncertainty-join.mjs — the uncertainty-routing question: does
// Jev's unclear band predict where verification attention pays off?
//
// Joins lint-log rows (claim-verifier verdicts) against review-store outcomes
// (records whose verify=Falsified or status=withdrawn — findings that died).
// If flag/review rows die at a measurably higher rate than ok rows, the band
// predicts — and the orchestrator can route verification effort by it.
//
// MACHINERY NOW, ANSWER LATER: this needs accumulated live data (a week of
// reviews). Until the guards pass it reports "insufficient data" honestly.
//
// Usage:
//   node scripts/jev-uncertainty-join.mjs --logs <lint-log> --stores <dir-or-file>...
//
// Canonical stores use { findings: [...] }; legacy arrays/records are accepted.
// Review-local IDs never disambiguate two different stores by themselves.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_ROWS = 20;

const diagnostic = (message) =>
	process.stderr.write(`[jev-join] BROKEN: ${message}\n`);

export function readLintRows(logPath, onDiagnostic = diagnostic) {
	let text;
	try {
		text = readFileSync(logPath, "utf8");
	} catch (error) {
		onDiagnostic(`cannot read lint log ${logPath}: ${error.code}`);
		return [];
	}
	const rows = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.agent === "claim-verifier" && Number.isFinite(entry.p))
				rows.push(entry);
		} catch {
			onDiagnostic(`malformed lint JSON at line ${index + 1} in ${logPath}`);
		}
	}
	return rows;
}

/** Records from store files: top-level array or { records: [...] }, keeping
 * only rows with an id and a verify/status outcome. */
export function readStoreRecords(paths, onDiagnostic = diagnostic) {
	const records = [];
	for (const path of paths) {
		records.push(...recordsFromStore(path, onDiagnostic));
	}
	return records;
}

function recordsFromStore(path, onDiagnostic) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const list = Array.isArray(parsed)
			? parsed
			: (parsed?.findings ?? parsed?.records);
		if (!Array.isArray(list)) throw new Error("unsupported store shape");
		const reviewId = parsed.review?.id ?? resolve(path).replaceAll("\\", "/");
		return list
			.filter(hasOutcome)
			.map((record) => ({ ...record, reviewId: record.reviewId ?? reviewId }));
	} catch (error) {
		onDiagnostic(`cannot load store ${path}: ${error.message}`);
		return [];
	}
}

function hasOutcome(record) {
	if (typeof record?.id !== "string") return false;
	return record.verify != null || record.status != null;
}

/** Expand store paths: directories contribute their *.json files. */
export function expandStorePaths(paths, onDiagnostic = diagnostic) {
	return paths.flatMap((path) => storeFilesAt(path, onDiagnostic));
}

function storeFilesAt(path, onDiagnostic) {
	try {
		if (statSync(path).isFile()) return [path];
		return readdirSync(path)
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => resolve(path, entry));
	} catch (error) {
		onDiagnostic(`cannot inspect stores at ${path}: ${error.code}`);
		return [];
	}
}

/** A store record died when it was falsified or withdrawn. */
export function died(record) {
	return record.verify === "Falsified" || record.status === "withdrawn";
}

/**
 * Join by review identity and finding id. Legacy identity-free rows join only
 * when their ID names exactly one record; ambiguity remains unknown. Returns tiers
 * { flag, review, ok } each { n, died, survived, unknown } plus total.
 */
export function joinOutcomes(lintRows, records) {
	const byId = new Map();
	for (const record of records) {
		const matches = byId.get(record.id) ?? [];
		matches.push(record);
		byId.set(record.id, matches);
	}
	const tiers = {
		flag: { n: 0, died: 0, survived: 0, unknown: 0 },
		review: { n: 0, died: 0, survived: 0, unknown: 0 },
		ok: { n: 0, died: 0, survived: 0, unknown: 0 },
	};
	for (const row of lintRows) {
		const tier = tiers[row.verdict];
		if (!tier) continue;
		tier.n++;
		const matches = (byId.get(row.id) ?? []).filter(
			(r) => (r.reviewId ?? null) === (row.reviewId ?? null),
		);
		const record = matches.length === 1 ? matches[0] : null;
		if (!record) tier.unknown++;
		else if (died(record)) tier.died++;
		else tier.survived++;
	}
	return tiers;
}

/** The prediction test: do flag+review rows die at a higher rate than ok rows? */
export function contingency(tiers) {
	const flagged =
		tiers.flag.died +
		tiers.review.died +
		tiers.flag.survived +
		tiers.review.survived;
	const flaggedDied = tiers.flag.died + tiers.review.died;
	const ok = tiers.ok.died + tiers.ok.survived;
	const okDied = tiers.ok.died;
	return {
		totalResolved: flagged + ok,
		flaggedRate: flagged > 0 ? flaggedDied / flagged : null,
		okRate: ok > 0 ? okDied / ok : null,
	};
}

export function renderReport(tiers) {
	const c = contingency(tiers);
	const lines = ["# jev uncertainty-join"];
	lines.push(
		`resolved rows (outcome known): ${c.totalResolved} — flag+review died rate: ${c.flaggedRate == null ? "—" : `${(c.flaggedRate * 100).toFixed(0)}%`}, ok died rate: ${c.okRate == null ? "—" : `${(c.okRate * 100).toFixed(0)}%`}`,
	);
	if (!hasComparison(c)) {
		lines.push(
			`INSUFFICIENT DATA — need >= ${MIN_ROWS} resolved rows and observations in both comparison tiers, have ${c.totalResolved}.`,
		);
	} else if (c.flaggedRate > c.okRate) {
		lines.push(
			"PREDICTIVE: the unclear band rows die more often than silent rows.",
		);
	} else {
		lines.push(
			"NOT PREDICTIVE on current data: unclear-band rows die no more often.",
		);
	}
	lines.push("");
	lines.push("| tier | n | died | survived | unknown |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const [tier, t] of Object.entries(tiers)) {
		lines.push(
			`| ${tier} | ${t.n} | ${t.died} | ${t.survived} | ${t.unknown} |`,
		);
	}
	return lines.join("\n");
}

function hasComparison(c) {
	if (c.totalResolved < MIN_ROWS) return false;
	return c.flaggedRate != null && c.okRate != null;
}

function parseArgs(argv) {
	const args = { stores: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--logs") args.logs = argv[++i];
		else if (argv[i] === "--stores") args.stores.push(argv[++i]);
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.logs) {
		process.stderr.write(
			"usage: node scripts/jev-uncertainty-join.mjs --logs <lint-log> --stores <dir-or-file>...\n",
		);
		process.exit(2);
	}
	const errors = [];
	const reportError = (message) => errors.push(message);
	const lintRows = readLintRows(resolve(args.logs), reportError);
	const records = readStoreRecords(
		expandStorePaths(
			args.stores.map((s) => resolve(s)),
			reportError,
		),
		reportError,
	);
	if (errors.length) {
		for (const error of errors) diagnostic(error);
		process.exitCode = 2;
		return;
	}
	const tiers = joinOutcomes(lintRows, records);
	process.stdout.write(`${renderReport(tiers)}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
