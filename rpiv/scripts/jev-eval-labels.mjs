// scripts/jev-eval-labels.mjs — feed eval-harness run outputs into the row-lint.
//
// The evals harness saves real agent outputs under the run workspace (see
// evals/README.md): <root>/<case>/<variant>/outputs/agent-output.md. This
// script scans that tree, lints every output whose agent has a ROW_LINTS
// entry, and appends the judgments to the lint shadow log with a `source`
// marker (idempotent — already-processed sources are skipped).
//
// It generates NO labels. The harness's case-level expectations (recall,
// absence) measure whether a row should exist, which is a different question
// than the lint's row-internal consistency; mapping one to the other would
// poison calibration. Human adjudication (--label) or a future per-row
// mechanical-results junction supplies the ground truth.
//
// Usage:
//   node scripts/jev-eval-labels.mjs                    # scan the default root
//   node scripts/jev-eval-labels.mjs --root <dir>
//   node scripts/jev-eval-labels.mjs --agent slice-verifier

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { appendLog, readKey } from "./jev-gate.mjs";
import {
	contentDigest,
	readCompletedBatch,
	reserveSource,
	writeCompletedBatch,
} from "./jev-source-store.mjs";
import {
	LINT_LOG_PATH,
	lintAgentOutput,
	parseConstituentFindings,
	ROW_LINTS,
} from "./jev-row-lint.mjs";

export const DEFAULT_EVAL_ROOT = "C:/Users/pedro/rpiv-claude/skill-evals";

// Case directories are detected by these markers, in order (first match wins).
export const AGENT_MARKERS = [
	["slice-verifier", /slice-verifier|SV-\d/i],
	["interaction-sweeper", /(?:^|[\\/-])IS-\d/i],
	["artifact-code-reviewer", /(?:^|[\\/-])ACR-\d/i],
	["artifact-coverage-reviewer", /(?:^|[\\/-])ACV-\d/i],
	["entity-mapper", /(?:^|[\\/-])EM-\d/i],
];

export function detectAgent(path) {
	for (const [agent, pattern] of AGENT_MARKERS) {
		if (pattern.test(path)) return agent;
	}
	return null;
}

/** Recursively collect agent-output.md paths (bounded depth). */
export function findOutputs(root, maxDepth = 8) {
	const results = [];
	const walk = (dir, depth) => {
		if (depth > maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === "agent-output.md") results.push(full);
		}
	};
	walk(root, 0);
	return results;
}

/** Only complete, successful batches establish completion; diagnostic rows do not. */
export function processedSources(log) {
	return new Set(
		log
			.filter(
				(e) =>
					e.status === "complete" &&
					Array.isArray(e.results) &&
					e.results.every((r) => !r.broken),
			)
			.map((e) => e.source),
	);
}

/** Resolve the dispatch prompt for a case output (interaction-sweeper only):
 * the case id (IS-2) maps to evals/cases/interaction-sweeper/IS-2.prompt.md
 * relative to the repo root. Returns null when unresolvable. */
export function resolveCasePrompt(source, promptRoot) {
	const caseId = source.match(
		/(?:^|[\\/-])(?:eval-)?(IS-\d+)(?:[\\/-]|-)/i,
	)?.[1];
	if (!caseId) return null;
	const path = resolve(
		promptRoot,
		"evals",
		"cases",
		"interaction-sweeper",
		`${caseId}.prompt.md`,
	);
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Lint every unlinted eval output. Returns a summary object; judgments land
 * in the lint shadow log (via logPath) with a source marker.
 */
export async function processEvalRoot({
	root = DEFAULT_EVAL_ROOT,
	logPath = LINT_LOG_PATH,
	agentFilter = null,
	key,
	envFile = ".env",
	env = process.env,
	fetchImpl = fetch,
	promptRoot = process.cwd(),
}) {
	const files = findOutputs(root);

	const summary = {
		scanned: files.length,
		linted: 0,
		skipped: 0,
		rows: 0,
		unmatched: 0,
	};
	for (const file of files) {
		const agent = detectAgent(file);
		if (!agent || !ROW_LINTS[agent]) {
			summary.unmatched++;
			continue;
		}
		if (agentFilter && agent !== agentFilter) {
			summary.skipped++;
			continue;
		}
		const release = reserveSource(logPath, file);
		if (!release) {
			summary.skipped++;
			process.stdout.write(`[jev-eval-labels] BUSY: ${file}\n`);
			continue;
		}
		try {
			const result = await processSource({
				source: file,
				agent,
				logPath,
				promptRoot,
				deps: { key, envFile, env, fetchImpl },
			});
			summary[result.skipped ? "skipped" : "linted"]++;
			summary.rows += result.rows;
		} finally {
			release();
		}
	}
	return summary;
}

async function processSource({ source, agent, logPath, promptRoot, deps }) {
	const text = readFileSync(source, "utf8");
	const config = ROW_LINTS[agent];
	const prompt = config.needsConstituents
		? resolveCasePrompt(source, promptRoot)
		: null;
	const digest = contentDigest(JSON.stringify({ text, prompt, config }));
	if (alreadyComplete(logPath, source, digest))
		return { skipped: true, rows: 0 };
	const { results, unavailable } = await lintAgentOutput(config, text, {
		...deps,
		constituents: prompt ? parseConstituentFindings(prompt) : null,
	});
	if (unavailable) {
		process.stdout.write(
			`[jev-eval-labels] UNAVAILABLE for ${source}: ${unavailable}\n`,
		);
		return { skipped: true, rows: 0 };
	}
	const entries = results.map((r) => logEntry(r, { agent, source, config }));
	if (results.every((r) => !r.broken)) {
		writeCompletedBatch(logPath, source, {
			status: "complete",
			source,
			digest,
			results: entries,
		});
	}
	for (const entry of entries) appendLog(logPath, entry);
	for (const row of results) warnRow(row, agent, source);
	return { skipped: false, rows: results.length };
}

function alreadyComplete(logPath, source, digest) {
	const prior = readCompletedBatch(logPath, source);
	if (!prior || prior.digest !== digest) return false;
	return processedSources([prior]).has(source);
}

function logEntry(row, { agent, source, config }) {
	return {
		ts: new Date().toISOString(),
		agent,
		source,
		mode: config.needsConstituents ? "constituent-aware" : "standard",
		id: row.id,
		tag: row.tag,
		p: row.p,
		verdict: row.verdict,
		broken: row.broken,
		row: row.rowText,
	};
}

function warnRow(row, agent, source) {
	if (row.verdict === "ok") return;
	const tier = row.broken ? "BROKEN" : row.verdict.toUpperCase();
	process.stdout.write(
		`[jev-eval-labels] ${tier}: ${agent} ${row.id} tag=${row.tag} p=${row.p?.toFixed(2)} (${source})\n`,
	);
}

function parseArgs(argv) {
	const args = { root: DEFAULT_EVAL_ROOT, agent: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") args.root = argv[++i];
		else if (argv[i] === "--agent") args.agent = argv[++i];
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const key = readKey();
	if (!key) {
		process.stderr.write(
			"jev-eval-labels broken: no TYPESAFE_API_KEY in env or .env\n",
		);
		process.exit(2);
	}
	const summary = await processEvalRoot({
		root: args.root,
		agentFilter: args.agent,
		key,
	});
	process.stdout.write(
		`scanned=${summary.scanned} linted=${summary.linted} skipped=${summary.skipped} rows=${summary.rows} unmatched=${summary.unmatched}\n`,
	);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
