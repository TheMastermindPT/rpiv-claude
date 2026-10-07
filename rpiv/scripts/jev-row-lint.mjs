// scripts/jev-row-lint.mjs — semantic lint over structured rpiv subagent rows.
//
// Several rpiv agents emit machine-shaped rows that the regex hook
// (subagent-output-check.mjs) can only check for *presence*. This lint checks
// what regex cannot: does the row's content support what the row claims?
//
// One config entry per agent in ROW_LINTS: a row pattern, field mapping,
// optional tag contracts (or a reference file to resolve definitions from at
// runtime — definitions are read, never copied), and the question to ask.
// Each extracted row is one bounded Jev call; bands:
//   p >= 0.7  -> ok      (silent)
//   0.3-0.7   -> REVIEW  (soft warning)
//   p <= 0.3  -> FLAG    (strong warning: likely mis-labeled row)
//
// ADVISORY ONLY: emits warnings, never blocks, never overrides agent output.
// A broken gate (no key, API error, unreadable reference) emits a distinct
// UNAVAILABLE line — never a silent pass (degrade-distinguishes-broken).
//
// Input (stdin): a JSON envelope { agent_type, result } (Claude Code
// SubagentStop event or opencode plugin), or raw agent text. Agent types
// without a ROW_LINTS entry exit silently.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	askJev,
	JEV_ENDPOINT,
	JEV_MODEL,
	NO_KEY_REASON,
	readKey,
} from "./jev-client.mjs";
import { findingId, requireProbability } from "./jev-contracts.mjs";
import { appendLog } from "./jev-gate.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));

export const OK_BAR = 0.7;
export const FLAG_BAR = 0.3;
export const LINT_LOG_PATH = "reports/jev-lint-shadow.log";

// Shared shape for the two independent artifact reviewers: the six-column
// findings table. Severity contracts are read at runtime from the owning
// agent file (shared-vocab-union: one owner, never copied here).
// mechanical: false — findings quote multiple locations (defect site AND
// convention site) under one codebase-loc, so a single-window quote check
// cannot label them soundly (verified in the 2026-09-19 cascade spike).
const SIX_COLUMN_TABLE = {
	label: "severity",
	mechanical: false,
	pattern:
		/^\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*(blocker|concern|suggestion)\s*\|\s*([\w-]+)\s*\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|$/gm,
	fields: { id: 1, tag: 3, text: 5, extra: 2 },
	extraLabel: "loc",
	question: {
		instructions: "Does the severity match the finding's described impact?",
		trueCriteria:
			"the finding describes an impact of exactly the severity's contract",
		falseCriteria:
			"the finding's impact is stronger or weaker than the severity claims",
	},
};

const SEVERITY_REFERENCE = {
	path: "agents/artifact-code-reviewer.md",
	label: "severity contract",
	format: "key-bullets",
};

export const ROW_LINTS = {
	"claim-verifier": {
		label: "tag",
		mechanical: true,
		pattern:
			/FINDING\s+(\S+)\s+\|\s+(Verified|Weakened|Falsified)\s*\|\s*(.+)$/gm,
		fields: { id: 1, tag: 2, text: 3 },
		contracts: {
			Verified:
				"quote matches at the cited file:line and the claim is reproducible against the actual code",
			Weakened:
				"claim is partially true but narrower than stated, or relies on a consumer-side assumption the consumer does not make",
			Falsified:
				"quote does not match, or the claimed behavior is contradicted by code the lens did not read",
		},
		question: {
			instructions: "Does the justification support the tag?",
			trueCriteria:
				"the justification cites concrete evidence (a file:line) that matches the tag contract",
			falseCriteria:
				"the justification is vague, contradicts the tag contract, or restates the claim instead of grounding it",
		},
	},
	"slice-verifier": {
		label: "verdict",
		// Rows cite artifact locations and paraphrased code, not verbatim
		// line quotes — the mechanical labeler must never judge them.
		mechanical: false,
		pattern:
			/^-\s*(Decisions|Cross-slice|Research):\s*([A-Z]+)\s*(?::\s*(.*))?$/gm,
		fields: { id: 1, tag: 2, text: 3 },
		contracts: {
			OK: "the category completed its audit without findings",
			VIOLATION:
				"names a concrete unsatisfied commitment or conflict with citations on both sides",
			WARNING: "names a soft constraint that is unsatisfied, with a citation",
			INCOMPLETE: "a required inspection could not be completed",
			UNAVAILABLE: "a required capability was not available",
			BROKEN: "execution of the review broke",
		},
		question: {
			instructions:
				"Does the emitted verdict match what the row's detail describes?",
			trueCriteria:
				"the detail names concrete evidence consistent with the verdict's contract",
			falseCriteria:
				"the verdict contradicts the detail (e.g. OK describing a gap, VIOLATION without a concrete commitment), or the verdict requires a detail and none is given",
		},
	},
	"diff-analyst": {
		label: "surface",
		mechanical: true,
		pattern:
			/^[ \t]*\|?[ \t]*`?([^|`\r\n]+?:\d+)`?[ \t]*\|[ \t]*(.+?)[ \t]*\|[ \t]*(?:surface[-\s]*)?(\d{1,2})[ \t]*\|[ \t]*(.+?)[ \t]*\|?[ \t]*$/gm,
		candidatePattern: /^.*:\d+`?\s*\|.*$/gm,
		fields: { id: 1, tag: 3, text: 4, extra: 2 },
		reference: {
			path: "skills/deep-review/references/quality-surfaces.md",
			label: "surface definition",
		},
		question: {
			instructions:
				"Does the note describe a defect of the kind the surface definition names?",
			trueCriteria:
				"the note names the surface definition's trigger evidence (the concrete things that surface checks for)",
			falseCriteria:
				"the note describes a different kind of defect than the surface definition, or only restates the surface name without its trigger evidence",
		},
	},
	"interaction-sweeper": {
		label: "kind",
		mechanical: true,
		// The blind compound-contract question does NOT discriminate (spiked
		// 2026-09-19: known-bad blocks scored like good ones). The admission
		// test needs the constituents' STATED defects, which live in the
		// dispatch prompt, not the output. Without them the row is skipped
		// loudly, never judged blind.
		needsConstituents: true,
		constituentPattern: /\*\*Constituents:\*\*\s*(.+)$/m,
		pattern:
			/^###\s+(IX-\d+)\s+—\s+([^\n]*)\n([\s\S]*?)(?=^###\s+IX-|\n##\s|(?![\s\S]))/gm,
		fields: { id: 1, tag: 2, text: 3 },
		tagPattern: /^\s*-\s*\*\*Kind:\*\*\s*(.+)$/m,
		contract:
			"the admission test: the emergent defect must require the constituents' stated defects to exist; a relation that stands without them is a new atomic finding, not a compound",
		question: {
			instructions:
				"Does the compound's Why-it-compounds sentence build on the constituents' stated defects?",
			trueCriteria:
				"the interaction described depends on the specific defects as stated in the constituent rows",
			falseCriteria:
				"the Why sentence describes properties of the constituent files unrelated to their stated defects — a relation that would stand even if every stated defect were fixed",
		},
	},
	"artifact-code-reviewer": {
		...SIX_COLUMN_TABLE,
		reference: SEVERITY_REFERENCE,
	},
	"artifact-coverage-reviewer": {
		...SIX_COLUMN_TABLE,
		reference: SEVERITY_REFERENCE,
	},
};

/** Extract rows for one agent config. */
export function parseRows(text, config) {
	const rows = [];
	for (const m of text.matchAll(config.pattern)) {
		const captured = (m[config.fields.text] ?? "").trim();
		let tag = m[config.fields.tag];
		if (config.tagPattern) {
			tag = captured.match(config.tagPattern)?.[1] ?? tag;
		}
		rows.push({
			id: m[config.fields.id].trim(),
			tag,
			text: captured,
			extra: config.fields.extra != null ? m[config.fields.extra] : undefined,
		});
	}
	return rows;
}

/** Parse a dispatch prompt's finding set into id -> row text. */
export function parseConstituentFindings(promptText) {
	const map = new Map();
	for (const m of promptText.matchAll(
		/^(\S+)\s+\|\s+([A-Za-z0-9]+)\s+\|\s+`?([\w./\\-]+:\d+)`?\s+\|\s+`([^`]+)`\s+\|\s+[^|\r\n]+\s+\|\s+(.+)$/gm,
	)) {
		const id = findingId(m[1]);
		if (id) map.set(id, `${id} | ${m[2]} | ${m[3]} | \`${m[4]}\` | ${m[5]}`);
	}
	return map;
}

/** Constituent ids from a block body — ignores `(via co-change ...)` suffixes. */
export function extractConstituentIds(text, pattern) {
	const m = text.match(pattern);
	if (!m) return [];
	return m[1].split(",").map(findingId).filter(Boolean);
}

/**
 * Resolve the contract for a row: its tag contract, a fixed per-config
 * contract, or the definition for its tag from the config's reference file.
 * Returns null when nothing can provide one (loud, never a guessed contract).
 */
export function resolveContract(config, tag, referenceRoot = PLUGIN_ROOT) {
	if (config.contracts) {
		return config.contracts[tag] ?? null;
	}
	if (config.contract) return config.contract;
	if (!config.reference) return null;
	const table = readReferenceTable(
		config.reference.path,
		referenceRoot,
		config.reference.format,
	);
	return table?.get(tag) ?? null;
}

/**
 * Parse a reference file into a key -> definition Map. Two formats:
 *   "numbered" (default) — `1. **Name** (trigger) — text`
 *     (quality-surfaces.md)
 *   "key-bullets" — `- \`key\`: text` severity-style bullets
 *     (agent files' Severity sections)
 * Returns null when the file is unreadable/unparseable.
 */
export function readReferenceTable(path, cwd, format = "numbered") {
	try {
		const text = readFileSync(resolve(cwd, path), "utf8");
		const entries =
			format === "key-bullets"
				? [...text.matchAll(/^-\s+`([^`]+)`:\s*(.+)$/gm)].map((m) => [
						m[1],
						m[2].trim(),
					])
				: numberedDefinitions(text);
		const table = new Map(entries);
		return table.size > 0 ? table : null;
	} catch {
		return null;
	}
}

/** The display form of a row — the exact text Jev judged. */
function numberedDefinitions(text) {
	return [
		...text.matchAll(
			/^\s*(\d{1,2})\.\s+\*\*([^*]+)\*\*\s*(\([^)]*\))?\s*—\s*(.+)$/gm,
		),
	].map((m) => [
		m[1],
		`${m[2].trim()}${m[3] ? ` ${m[3].trim()}` : ""} — ${m[4].trim()}`,
	]);
}

function formatRow(row, config) {
	const extraLabel = config.extraLabel ?? "quote";
	return `${row.id} | ${config.label}=${row.tag} | ${row.extra ? `${extraLabel}: ${row.extra} | ` : ""}${row.text}`;
}

/** The state Jev judges: enriched compound shape for constituent-aware
 * configs, plain row shape otherwise. */
function buildRequestState({ config, row, contract, code, constituents }) {
	const state = config.needsConstituents
		? {
				compound_block: formatRow(row, config),
				constituent_findings: constituents ?? "",
				contract: contract ?? "",
			}
		: { row: formatRow(row, config), contract: contract ?? "" };
	if (code) state.code = code;
	return state;
}

/** One bounded Jev call for a row. Throws on HTTP error or malformed response. */
async function callConsistent({
	row,
	config,
	contract,
	key,
	fetchImpl,
	endpoint,
	model,
	timeoutMs,
	code,
	constituents,
}) {
	const state = buildRequestState({
		config,
		row,
		contract,
		code,
		constituents,
	});
	const reply = await askJev({
		key,
		state,
		questions: {
			consistent: {
				type: "noul",
				instructions: config.question.instructions,
				criteria: {
					true: config.question.trueCriteria,
					false: config.question.falseCriteria,
				},
			},
		},
		fetchImpl,
		endpoint,
		model,
		timeoutMs,
	});
	if (reply.status !== "ok") throw new Error(reply.reason);
	return requireProbability(reply.body?.answers?.consistent?.noul);
}

/**
 * Judge one row: does its content support its tag/claim?
 * Returns { id, tag, p, verdict } or { broken: reason }.
 */
export async function lintRow({
	row,
	config,
	contract,
	key,
	fetchImpl = fetch,
	endpoint = JEV_ENDPOINT,
	model = JEV_MODEL,
	timeoutMs = 6000,
	code,
	constituents,
}) {
	try {
		const p = await callConsistent({
			row,
			config,
			contract,
			key,
			fetchImpl,
			endpoint,
			model,
			timeoutMs,
			code,
			constituents,
		});
		const okBar = config.okBar ?? OK_BAR;
		const flagBar = config.flagBar ?? FLAG_BAR;
		const verdict = p >= okBar ? "ok" : p <= flagBar ? "flag" : "review";
		return {
			id: row.id,
			tag: row.tag,
			p,
			verdict,
			rowText: formatRow(row, config),
		};
	} catch (err) {
		return {
			id: row.id,
			tag: row.tag,
			broken: String(err?.message ?? err),
			rowText: formatRow(row, config),
		};
	}
}

/** Bounded-parallel fan-out (one Jev call per row). */
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await fn(items[i]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/**
 * Per-row context: contract resolution and (for constituent-aware configs)
 * the stated-defect rows named by each compound. Rows that cannot be fully
 * resolved get a broken reason — never judged partially.
 */
function resolveRowContexts(config, rows, cwd, constituentMap) {
	return new Map(
		rows.map((row) => [row, rowContext({ config, row, cwd, constituentMap })]),
	);
}

function rowContext({ config, row, cwd, constituentMap }) {
	const contract = resolveContract(config, row.tag, cwd);
	if (contract == null)
		return {
			broken: `no ${config.reference?.label ?? "contract"} for ${config.label}=${row.tag}`,
		};
	if (!config.needsConstituents) return { contract };
	const ids = extractConstituentIds(row.text, config.constituentPattern);
	const missing = ids.filter((id) => !constituentMap.has(id));
	if (missing.length)
		return { broken: `constituent findings not found: ${missing.join(", ")}` };
	return {
		contract,
		constituents: ids.map((id) => constituentMap.get(id)).join("\n"),
	};
}

/**
 * Lint one agent's output. Returns { results, unavailable } where unavailable
 * is null when the gate worked and a distinct reason when it could not run at
 * all (missing key) or could not resolve a row's contract.
 */
export async function lintAgentOutput(config, text, deps = {}) {
	const rows = parseRows(text, config);
	const rejected = rejectedRows(text, config);
	if (rows.length === 0) return { results: rejected, unavailable: null };
	const key = deps.key ?? readKey({ envFile: deps.envFile, env: deps.env });
	if (!key) {
		return {
			results: [],
			unavailable: NO_KEY_REASON,
		};
	}

	const needsConstituents = config.needsConstituents === true;
	const constituentMap = needsConstituents ? (deps.constituents ?? null) : null;
	if (needsConstituents && !constituentMap) {
		return {
			results: rows.map((row) => ({
				id: row.id,
				tag: row.tag,
				broken: "constituent findings unavailable (no dispatch prompt)",
				rowText: formatRow(row, config),
			})),
			unavailable: null,
		};
	}

	const contexts = resolveRowContexts(
		config,
		rows,
		deps.referenceRoot ?? PLUGIN_ROOT,
		constituentMap,
	);
	const results = await mapLimit(rows, 5, (row) =>
		!contexts.get(row).broken
			? lintRow({
					row,
					config,
					...contexts.get(row),
					key,
					fetchImpl: deps.fetchImpl ?? fetch,
				})
			: {
					id: row.id,
					tag: row.tag,
					broken: contexts.get(row).broken,
					rowText: formatRow(row, config),
				},
	);
	return { results: [...results, ...rejected], unavailable: null };
}

function rejectedRows(text, config) {
	if (!config.candidatePattern) return [];
	const predicateTables = [
		...text.matchAll(
			/^[ \t]*\|[ \t]*predicate file:line[ \t]*\|[ \t]*accepted[ \t]*\|[ \t]*rejected[ \t]*\|[ \t]*\r?\n(?:[ \t]*\|[^\r\n]*(?:\r?\n|$))*/gim,
		),
	];
	const accepted = new Set(
		[...text.matchAll(config.pattern)].map((m) => m[0].trim()),
	);
	return [...text.matchAll(config.candidatePattern)]
		.filter(
			(m) =>
				!predicateTables.some(
					(table) =>
						m.index >= table.index && m.index < table.index + table[0].length,
				),
		)
		.filter((m) => !accepted.has(m[0].trim()))
		.map((m) => ({
			id: `unparsed-${m.index}`,
			broken: "cannot parse candidate finding row",
			rowText: m[0],
		}));
}

function isSubagentEvent(event) {
	return (
		event && typeof event === "object" && typeof event.agent_type === "string"
	);
}

function extractFromStdin(raw) {
	try {
		const event = JSON.parse(raw);
		if (isSubagentEvent(event)) {
			return {
				agentType: event.agent_type,
				text: typeof event.result === "string" ? event.result : "",
				prompt:
					typeof event.prompt === "string" && event.prompt
						? event.prompt
						: null,
			};
		}
	} catch {
		// raw text fallthrough
	}
	return { agentType: "", text: raw, prompt: null };
}

function emitWarning(agentName, r) {
	if (r.broken) {
		process.stdout.write(
			`[jev-lint] UNAVAILABLE for ${agentName} ${r.id}: ${r.broken}\n`,
		);
	} else if (r.verdict === "flag") {
		process.stdout.write(
			`[jev-lint] FLAG: ${agentName} ${r.id} | tag=${r.tag} | row content inconsistent with the tag (p=${r.p.toFixed(2)})\n`,
		);
	} else if (r.verdict === "review") {
		process.stdout.write(
			`[jev-lint] REVIEW: ${agentName} ${r.id} | tag=${r.tag} | row content unclear (p=${r.p.toFixed(2)})\n`,
		);
	}
}

async function main() {
	const raw = readStdin();
	if (!raw) return;
	const { agentType, text, prompt } = extractFromStdin(raw);
	const entry = Object.entries(ROW_LINTS).find(([name]) =>
		agentType.includes(name),
	);
	if (!entry) return;
	const [agentName, config] = entry;
	if (!text.trim()) return;

	const constituents =
		config.needsConstituents && prompt
			? parseConstituentFindings(prompt)
			: null;
	if (config.needsConstituents && !constituents) {
		process.stdout.write(
			`[jev-lint] UNAVAILABLE: constituent findings not supplied (no dispatch prompt) — rows not linted\n`,
		);
		return;
	}

	const { results, unavailable } = await lintAgentOutput(config, text, {
		constituents,
	});
	if (unavailable) {
		process.stdout.write(
			`[jev-lint] UNAVAILABLE: ${unavailable} — rows not linted\n`,
		);
		return;
	}
	logResults(agentName, config, results);
	for (const r of results) emitWarning(agentName, r);
}

function logResults(agentName, config, results) {
	try {
		for (const r of results) {
			appendLog(LINT_LOG_PATH, {
				ts: new Date().toISOString(),
				agent: agentName,
				mode: config.needsConstituents ? "constituent-aware" : "standard",
				id: r.id,
				tag: r.tag,
				p: r.p,
				verdict: r.verdict,
				broken: r.broken,
				row: r.rowText,
			});
		}
	} catch (err) {
		process.stdout.write(`[jev-lint] LOG UNAVAILABLE: ${err.message}\n`);
	}
}

function readStdin() {
	try {
		const raw = readFileSync(0, "utf8").trim();
		return raw || null;
	} catch {
		return null;
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
