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
// Store tolerance: files may be a top-level array or { records: [...] }.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_ROWS = 20;

export function readLintRows(logPath) {
	try {
		return readFileSync(logPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((e) => e.agent === "claim-verifier" && typeof e.p === "number");
	} catch {
		return [];
	}
}

/** Records from store files: top-level array or { records: [...] }, keeping
 * only rows with an id and a verify/status outcome. */
export function readStoreRecords(paths) {
	const records = [];
	for (const path of paths) {
		let raw;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const list = Array.isArray(parsed)
			? parsed
			: Array.isArray(parsed?.records)
				? parsed.records
				: [];
		for (const record of list) {
			if (typeof record?.id !== "string") continue;
			if (record.verify == null && record.status == null) continue;
			records.push(record);
		}
	}
	return records;
}

/** Expand store paths: directories contribute their *.json files. */
export function expandStorePaths(paths) {
	const files = [];
	for (const path of paths) {
		let stats;
		try {
			stats = statSync(path);
		} catch {
			continue;
		}
		if (stats.isFile()) {
			files.push(path);
			continue;
		}
		for (const entry of readdirSync(path)) {
			if (entry.endsWith(".json")) files.push(resolve(path, entry));
		}
	}
	return files;
}

/** A store record died when it was falsified or withdrawn. */
export function died(record) {
	return record.verify === "Falsified" || record.status === "withdrawn";
}

/**
 * Join lint rows to store outcomes by finding id. Returns tiers
 * { flag, review, ok } each { n, died, survived, unknown } plus total.
 */
export function joinOutcomes(lintRows, records) {
	const byId = new Map(records.map((r) => [r.id, r]));
	const tiers = {
		flag: { n: 0, died: 0, survived: 0, unknown: 0 },
		review: { n: 0, died: 0, survived: 0, unknown: 0 },
		ok: { n: 0, died: 0, survived: 0, unknown: 0 },
	};
	for (const row of lintRows) {
		const tier = tiers[row.verdict];
		if (!tier) continue;
		tier.n++;
		const record = byId.get(row.id);
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
	if (c.totalResolved < MIN_ROWS) {
		lines.push(
			`INSUFFICIENT DATA — need >= ${MIN_ROWS} resolved rows, have ${c.totalResolved}.`,
		);
	} else if (
		c.flaggedRate != null &&
		c.okRate != null &&
		c.flaggedRate > c.okRate
	) {
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
	const lintRows = readLintRows(resolve(args.logs));
	const records = readStoreRecords(
		expandStorePaths(args.stores.map((s) => resolve(s))),
	);
	const tiers = joinOutcomes(lintRows, records);
	process.stdout.write(`${renderReport(tiers)}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
