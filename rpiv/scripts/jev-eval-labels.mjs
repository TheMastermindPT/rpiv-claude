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

/** Sources already present in the lint log (entries carrying a `source`). */
export function processedSources(log) {
	return new Set(
		log.filter((e) => typeof e.source === "string").map((e) => e.source),
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
	existingLog = null,
	promptRoot = process.cwd(),
}) {
	const files = findOutputs(root);
	const skip = processedSources(existingLog ?? readExistingLog(logPath));

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
		const source = file;
		if (skip.has(source)) {
			summary.skipped++;
			continue;
		}
		const config = ROW_LINTS[agent];
		const promptText = config.needsConstituents
			? resolveCasePrompt(file, promptRoot)
			: null;
		if (config.needsConstituents && !promptText) {
			summary.skipped++;
			process.stdout.write(
				`[jev-eval-labels] UNAVAILABLE for ${source}: constituent prompt not found\n`,
			);
			continue;
		}
		const text = readFileSync(file, "utf8");
		const { results, unavailable } = await lintAgentOutput(config, text, {
			key,
			envFile,
			env,
			fetchImpl,
			cwd: process.cwd(),
			constituents: promptText ? parseConstituentFindings(promptText) : null,
		});
		if (unavailable) {
			summary.skipped++;
			process.stdout.write(
				`[jev-eval-labels] UNAVAILABLE for ${source}: ${unavailable}\n`,
			);
			continue;
		}
		for (const r of results) {
			appendLog(logPath, {
				ts: new Date().toISOString(),
				agent,
				source,
				mode: config.needsConstituents ? "constituent-aware" : "standard",
				id: r.id,
				tag: r.tag,
				p: r.p,
				verdict: r.verdict,
				broken: r.broken,
				row: r.rowText,
			});
		}
		summary.linted++;
		summary.rows += results.length;
		for (const r of results) {
			if (r.verdict === "flag" || r.verdict === "review" || r.broken) {
				const tier = r.broken ? "BROKEN" : r.verdict.toUpperCase();
				process.stdout.write(
					`[jev-eval-labels] ${tier}: ${agent} ${r.id} tag=${r.tag} p=${r.p?.toFixed(2)} (${source})\n`,
				);
			}
		}
	}
	return summary;
}

function readExistingLog(logPath) {
	try {
		return readFileSync(logPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
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
