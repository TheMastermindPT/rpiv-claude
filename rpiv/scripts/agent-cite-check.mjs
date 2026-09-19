// scripts/agent-cite-check.mjs — citation-quality proxy check on agent output.
//
// The collapse detector (option 2). Deep-review's narrativisation collapse
// and the documented entity-mapper failure share a measurable signature:
// citation quality drops — bare basenames instead of repo-relative paths,
// unresolvable locations, missing verbatim quotes. These proxies are
// deterministic and were validated against the eval iteration history
// (2026-09-19 spike: iteration-1 EM runs at 42-91% basename / 8-11%
// resolvable flagged; iteration-2 runs at 0-2% / 97-98% passed).
//
// One Jev judgment per OUTPUT was also spiked and failed to discriminate —
// aggregate compliance questions suffer context rot on long outputs. The
// mechanical layer is the detector; Jev stays at the per-row level (row-lint).
//
// Per-agent contract thresholds — only agents whose contract demands
// repo-relative, verbatim citations are checked:
//   entity-mapper:      repo-relative paths required (agent file: "cite
//                       repo-relative paths, never bare basenames")
//   interaction-sweeper: >=2 distinct-file cites per compound, verbatim quotes
//   claim-verifier / diff-analyst: repo-relative citation contract
// slice-verifier cites artifact locations by basename legitimately — skipped.
//
// Input (stdin): { agent_type, result } envelope or raw text. Emits warnings
// to stdout; advisory only, never blocks, never grades.
//
// Usage:
//   node scripts/agent-cite-check.mjs --root <repo-root>

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CITATION_PATTERN =
	/([\w./\\-]+\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx|md|json|html|css)):(\d{1,5})/g;

export const CONTRACTS = {
	"entity-mapper": { maxBasename: 0.1, minResolvable: 0.9 },
	"interaction-sweeper": {
		maxBasename: 0.15,
		minQuoteRate: 1,
		minResolvable: 0.9,
	},
	"claim-verifier": { maxBasename: 0.15 },
	"diff-analyst": { maxBasename: 0.1, minResolvable: 0.9 },
};

/** Structural citation metrics for one agent output. */
export function citeMetrics(text, repoRoot) {
	const cites = [...text.matchAll(CITATION_PATTERN)].map((m) => ({
		path: m[1],
		line: Number(m[2]),
	}));
	const quotes = [...text.matchAll(/`([^`\n]+)`/g)].length;
	const basename = cites.filter(
		(c) => !c.path.includes("/") && !c.path.includes("\\"),
	);
	const resolvable = cites.filter((c) => existsSync(resolve(repoRoot, c.path)));
	return {
		cites: cites.length,
		quotes,
		basenameRate: cites.length ? basename.length / cites.length : null,
		resolvableRate: cites.length ? resolvable.length / cites.length : null,
		quoteRate: cites.length ? quotes / cites.length : null,
	};
}

/** Contract violations for one agent's metrics. Empty when clean/unchecked. */
export function violations(agentName, metrics) {
	const contract = CONTRACTS[agentName];
	if (!contract || metrics.cites === 0) return [];
	const out = [];
	if (
		contract.maxBasename != null &&
		metrics.basenameRate > contract.maxBasename
	) {
		out.push(
			`bare-basename cites ${(metrics.basenameRate * 100).toFixed(0)}% (max ${(contract.maxBasename * 100).toFixed(0)}%)`,
		);
	}
	if (
		contract.minResolvable != null &&
		metrics.resolvableRate < contract.minResolvable
	) {
		out.push(
			`citation resolvability ${(metrics.resolvableRate * 100).toFixed(0)}% (min ${(contract.minResolvable * 100).toFixed(0)}%)`,
		);
	}
	if (
		contract.minQuoteRate != null &&
		metrics.quoteRate < contract.minQuoteRate
	) {
		out.push(
			`verbatim-quote rate ${metrics.quoteRate.toFixed(2)} per citation (min ${contract.minQuoteRate})`,
		);
	}
	return out;
}

function extractFromStdin(raw) {
	try {
		const event = JSON.parse(raw);
		if (
			event &&
			typeof event === "object" &&
			typeof event.agent_type === "string"
		) {
			return {
				agentType: event.agent_type,
				text: typeof event.result === "string" ? event.result : "",
			};
		}
	} catch {
		// raw text fallthrough
	}
	return { agentType: "", text: raw };
}

function parseArgs(argv) {
	const args = { root: process.cwd() };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") args.root = argv[++i];
	}
	return args;
}

function readStdin() {
	try {
		const raw = readFileSync(0, "utf8").trim();
		return raw || null;
	} catch {
		return null;
	}
}

async function main() {
	const raw = readStdin();
	if (!raw) return;
	const { agentType, text } = extractFromStdin(raw);
	if (!text.trim()) return;
	const { root } = parseArgs(process.argv.slice(2));
	const agentName = Object.keys(CONTRACTS).find((name) =>
		agentType.includes(name),
	);
	if (!agentName) return;
	const metrics = citeMetrics(text, root);
	const problems = violations(agentName, metrics);
	for (const problem of problems) {
		process.stdout.write(
			`[cite-check] ${agentName}: ${problem} (${metrics.cites} cites)\n`,
		);
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
