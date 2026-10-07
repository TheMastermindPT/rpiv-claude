// scripts/jev-rel-audit.mjs — the relation auditor: a fact-checker between
// an agent's narrative and the record extracted by deterministic tools.
//
// For each finding, Jev judges ONE question: does the finding's description
// of relationships match the extracted record for its cited files? This is
// claim-vs-record checking, never truth-establishing.
//
// ASYMMETRY OF EVIDENCE (the load-bearing safety rule): a finding whose cited
// files have NO record data is never judged — a silent record is not proof
// of a wrong claim (the tools may have missed something). Only an actual
// contradiction between the narrative and the record can produce a flag.
//
// Record schema (relations.json):
//   { "files": { "<repo-relative path>": {
//       "inbound":  ["path", ...],          // who imports this file
//       "outbound": ["path", ...],          // what this file imports
//       "boundaries": ["description", ...], // depcruise rule violations
//       "matches":  [{ "line": n, "text": "..." }], // ast-grep structural hits
//       "cochange": ["path", ...],
//       "writers": null | n
//   } } }
//
// Assemble mode (builds relations.json from deterministic tool outputs):
//   --depcruise <depcruise.json>  (depcruise --output-type json)
//   --astgrep <astgrep.json>      (ast-grep scan --json)
//
// Audit mode:
//   node scripts/jev-rel-audit.mjs --findings findings.json --record relations.json
//     [--out audit.json]
//   findings.json = [{ "id", "file", "line", "verbatim", "note" }]
//
// Bands: >= 0.7 ok (silent), 0.3-0.7 uncertain, <= 0.3 flag (record-contradiction).
// Advisory: warns, never blocks, never overrides. No key or a broken call is
// loud, never a silent pass.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	askJev,
	JEV_ENDPOINT,
	JEV_MODEL,
	NO_KEY_REASON,
	readKey,
} from "./jev-client.mjs";
import { requireProbability } from "./jev-contracts.mjs";

export const OK_BAR = 0.7;
export const FLAG_BAR = 0.3;
export const NEAR_LINE_WINDOW = 20;

/** JSON read that tolerates UTF-8 BOMs (common in tool output written via shells). */
export function parseJsonFile(path) {
	return JSON.parse(readFileSync(resolve(path), "utf8").replace(/^\uFEFF/, ""));
}

// ---------- assembler ----------

/** The empty record shape for one file. */
export function emptyRecord() {
	return {
		inbound: [],
		outbound: [],
		boundaries: [],
		matches: [],
		cochange: [],
		writers: null,
	};
}

/** Tolerant depcruise JSON: { modules: [{ source, dependencies: [{ resolved, valid, rules? }] }] } */
export function fromDepcruise(input) {
	const files = new Map();
	const modules = Array.isArray(input) ? input : (input?.modules ?? []);
	for (const mod of modules) {
		if (!mod.source) continue;
		if (!files.has(mod.source)) files.set(mod.source, emptyRecord());
		for (const dep of mod.dependencies ?? [])
			addDependency(files.get(mod.source), dep);
	}
	addInboundEdges(files);
	return { files: Object.fromEntries(files) };
}

function addDependency(record, dep) {
	const target = dep.resolved ?? dep.circularPath ?? null;
	if (target) record.outbound.push(target);
	if (dep.valid !== false) return;
	const rules = (dep.rules ?? []).map((r) => r.name ?? String(r)).join(", ");
	record.boundaries.push(`${target ?? "?"}: ${rules || "violated"}`);
}

function addInboundEdges(files) {
	for (const [source, record] of files) {
		for (const target of record.outbound) {
			if (!files.has(target)) files.set(target, emptyRecord());
			files.get(target).inbound.push(source);
		}
	}
}

/** Tolerant ast-grep scan --json: array or { matches: [...] }; entries carry path/file, line, text. */
export function fromAstGrep(input, files = {}) {
	const list = Array.isArray(input) ? input : (input?.matches ?? []);
	for (const m of list) {
		const path = m.path ?? m.file;
		const line = matchLine(m);
		if (!path) continue;
		if (!files[path]) files[path] = emptyRecord();
		files[path].matches.push({ line, text: m.text ?? "" });
	}
	return { files };
}

function matchLine(match) {
	if (Number.isInteger(match.line)) return match.line;
	const zeroBased = match.range?.start?.line;
	return Number.isInteger(zeroBased) ? zeroBased + 1 : null;
}

export function assembleRecord({ depcruise, astgrep }) {
	let files = {};
	if (depcruise) files = fromDepcruise(depcruise).files;
	if (astgrep) files = { ...files, ...fromAstGrep(astgrep, files).files };
	return { files };
}

// ---------- audit ----------

export const CITATION =
	/([\w./\\-]+\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx|md|json|html|css|astro|svelte|vue)):(\d{1,5})/g;

/** Match a cited path against record keys by suffix (either direction). */
export function matchRecordKey(citedPath, files) {
	return Object.keys(files).find(
		(p) =>
			p === citedPath ||
			p.endsWith(`/${citedPath}`) ||
			citedPath.endsWith(`/${p}`),
	);
}

/** The near-line matches, formatted. */
function nearMatches(r, line) {
	return (r.matches ?? [])
		.filter(
			(x) => x.line == null || Math.abs(x.line - line) <= NEAR_LINE_WINDOW,
		)
		.map((x) => (x.line == null ? x.text : `${x.line}: ${x.text}`));
}

/** The record slice for one file, as the compact text Jev sees. */
function formatSection(key, r, line) {
	const near = nearMatches(r, line);
	return [
		`file ${key}`,
		r.inbound?.length
			? `inbound: ${r.inbound.join(", ")}`
			: "inbound: none recorded",
		r.outbound?.length
			? `outbound: ${r.outbound.join(", ")}`
			: "outbound: none recorded",
		r.boundaries?.length
			? `boundary violations: ${r.boundaries.join("; ")}`
			: "boundary violations: none recorded",
		near.length
			? `structural matches near line ${line}: ${near.join(" | ")}`
			: "",
		r.writers != null ? `write sites: ${r.writers}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** The record slice for one finding: cited files matched by suffix, with the
 * matches near the cited lines. Null when none of the cited files has data. */
export function bundleFor(finding, record) {
	const files = record?.files ?? {};
	const parts = [];
	for (const m of finding.text.matchAll(CITATION)) {
		const citedPath = m[1].replaceAll("\\", "/");
		const line = Number(m[2]);
		const key = matchRecordKey(citedPath, files);
		if (!key) continue;
		parts.push(formatSection(key, files[key], line));
	}
	return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : null;
}

/** One bounded Jev call for the claim-vs-record question. Throws on error. */
async function callRelJudge({
	finding,
	bundle,
	key,
	fetchImpl,
	endpoint,
	timeoutMs,
}) {
	const reply = await askJev({
		key,
		model: JEV_MODEL,
		state: {
			finding: finding.text.slice(0, 4000),
			record: bundle,
		},
		questions: {
			consistent: {
				type: "noul",
				instructions:
					"Does the finding's description of relationships match the extracted record for its cited files?",
				criteria: {
					true: "the relational claims the finding makes (consumers, imports, boundaries, call sites, ownership) are consistent with what the record shows, or the finding makes no relational claims",
					false:
						"the finding describes a relationship that contradicts the record — e.g., names a consumer that does not import the file, claims a boundary violation the record does not flag, or asserts ownership the record contradicts",
				},
			},
		},
		fetchImpl,
		endpoint,
		timeoutMs,
	});
	if (reply.status !== "ok") throw new Error(reply.reason);
	return requireProbability(reply.body?.answers?.consistent?.noul);
}

/** One judgment per finding. Returns { id, p, verdict } | { id, broken } |
 * { id, verdict: "no-record" }. */
export async function judgeFinding({
	finding,
	bundle,
	key,
	fetchImpl = fetch,
	endpoint = JEV_ENDPOINT,
	timeoutMs = 15_000,
}) {
	try {
		const p = await callRelJudge({
			finding,
			bundle,
			key,
			fetchImpl,
			endpoint,
			timeoutMs,
		});
		const verdict = p >= OK_BAR ? "ok" : p <= FLAG_BAR ? "flag" : "uncertain";
		return { id: finding.id, p, verdict };
	} catch (err) {
		return { id: finding.id, broken: String(err?.message ?? err) };
	}
}

/** Audit every finding. Findings without record data get verdict no-record. */
export async function auditFindings({ findings, record, key, fetchImpl }) {
	const judged = [];
	const noRecord = [];
	for (const finding of findings) {
		const bundle = bundleFor(finding, record);
		if (bundle == null) noRecord.push(finding.id);
		else judged.push({ finding, bundle });
	}
	const results = [];
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(5, judged.length) },
		async () => {
			while (next < judged.length) {
				const i = next++;
				results[i] = await judgeFinding({
					finding: judged[i].finding,
					bundle: judged[i].bundle,
					key,
					fetchImpl,
				});
			}
		},
	);
	await Promise.all(workers);
	for (const id of noRecord) results.push({ id, verdict: "no-record" });
	return results;
}

// ---------- CLI ----------

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const key = argv[i].replace(/^--/, "");
		if (key === "depcruise" || key === "astgrep") {
			args[key] = argv[++i];
		} else if (["findings", "record", "out"].includes(key)) {
			args[key] = argv[++i];
		}
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.depcruise || args.astgrep) {
		assembleFromArgs(args);
		return;
	}

	if (!args.findings || !args.record) {
		process.stderr.write(
			"usage: --findings findings.json --record relations.json [--out audit.json]\n" +
				"       --depcruise d.json [--astgrep a.json] --out relations.json\n",
		);
		process.exit(2);
	}
	const key = readKey();
	if (!key) {
		process.stderr.write(`jev-rel-audit broken: ${NO_KEY_REASON}\n`);
		process.exit(2);
	}
	const findings = parseJsonFile(args.findings).map((f) => ({
		id: f.id,
		text: `${f.id} — ${f.file && Number.isInteger(f.line) ? `${f.file}:${f.line} — ` : ""}\`${f.verbatim ?? ""}\` — ${f.note ?? ""}`,
	}));
	const record = parseJsonFile(args.record);
	const results = await auditFindings({ findings, record, key });
	if (args.out) {
		writeFileSync(resolve(args.out), JSON.stringify({ results }, null, 2));
	}
	for (const r of results) reportAuditRow(r);
	const noRecord = results.filter((r) => r.verdict === "no-record").length;
	process.stdout.write(
		`[jev-rel] ${results.length} findings: ${results.filter((r) => r.verdict === "ok").length} ok, ${results.filter((r) => r.verdict === "flag" || r.verdict === "uncertain").length} flagged, ${noRecord} no-record\n`,
	);
}

function assembleFromArgs(args) {
	if (!args.out) {
		process.stderr.write("assemble mode requires --out relations.json\n");
		process.exit(2);
	}
	const depcruise = args.depcruise ? parseJsonFile(args.depcruise) : null;
	const astgrep = args.astgrep ? parseJsonFile(args.astgrep) : null;
	const record = assembleRecord({ depcruise, astgrep });
	writeFileSync(resolve(args.out), JSON.stringify(record, null, 2));
	process.stdout.write(
		`assembled record: ${Object.keys(record.files).length} files\n`,
	);
}

function reportAuditRow(r) {
	if (r.verdict === "flag") {
		process.stdout.write(
			`[jev-rel] RECORD-CONTRADICTION: ${r.id} (p=${r.p.toFixed(2)})\n`,
		);
	} else if (r.verdict === "uncertain") {
		process.stdout.write(
			`[jev-rel] UNCERTAIN: ${r.id} (p=${r.p.toFixed(2)})\n`,
		);
	} else if (r.broken) {
		process.stdout.write(`[jev-rel] BROKEN: ${r.id} — ${r.broken}\n`);
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
