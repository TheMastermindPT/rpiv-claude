// evals/harness/jev-semantic-grade.mjs — the semantic grading stage, backed
// by Jev (spiked 2026-09-19: candidate-vs-known-defect judgments reproduce
// human grading on DR-1 — direct match 0.98, cascade 0.78, consequence 0.66,
// adjacent-but-different 0.27).
//
// The mechanical grader proves a finding exists near the recall window; this
// stage proves the matched candidate DESCRIBES the known defect. It is
// additive and advisory: semantic verdicts never override mechanical grades,
// and a Jev outage degrades loudly to `unavailable` — the run still stands on
// its mechanical results.
//
// State per recall item = the ground-truth note + the recall item identity +
// the candidate finding text (the admission-test shape).
//
// Usage:
//   node jev-semantic-grade.mjs --case <case.json> --artifact <artifact.md>
//     --out <semantic.json> --worktree <worktree>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	askJev,
	JEV_MODEL,
	NO_KEY_REASON,
	readKey,
} from "../../scripts/jev-client.mjs";
import { findingId, requireProbability } from "../../scripts/jev-contracts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export const PASS_BAR = 0.7;
export const FAIL_BAR = 0.3;

export const CITATION =
	/([\w./\\-]+\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx|md|json|html|css)):(\d{1,5})/g;

/** Findings from a review artifact: `### <id> ...` sections with a body. */
export function extractFindings(text) {
	const findings = [];
	for (const section of text.split(/^### /gm).slice(1)) {
		const id = findingId(section);
		if (!id) continue;
		findings.push({ id, text: section.trim().slice(0, 3000) });
	}
	return findings;
}

/** Does the finding cite a location inside the recall window? Best (nearest)
 * candidate wins; null when nothing is in range. */
export function matchCandidate(finding, recallItem) {
	const citations = [...finding.text.matchAll(CITATION)];
	const distances = (recallItem.files ?? []).flatMap((target) =>
		citations.map((citation) => citationDistance(citation, target)),
	);
	const distance = Math.min(...distances);
	return Number.isFinite(distance)
		? { id: finding.id, text: finding.text, distance }
		: null;
}

function citationDistance(citation, target) {
	const citedPath = citation[1].replaceAll("\\", "/");
	const targetPath = target.path.replaceAll("\\", "/");
	if (citedPath !== targetPath && !targetPath.endsWith(`/${citedPath}`))
		return Infinity;
	if (target.line == null) return 0;
	const distance = Math.abs(Number(citation[2]) - target.line);
	return distance <= (target.radius ?? 0) ? distance : Infinity;
}

/** One semantic judgment per recall item. Returns null candidate/verdict
 * shapes the CLI writes verbatim. */
export async function semanticGrade({
	recallItems = [],
	groundTruthNote = "",
	artifactText = "",
	fetchImpl = fetch,
	key,
	timeoutMs = 15_000,
}) {
	const findings = extractFindings(artifactText);
	const results = [];
	for (const item of recallItems) {
		const candidate =
			findings
				.map((f) => matchCandidate(f, item))
				.filter(Boolean)
				.sort((a, b) => a.distance - b.distance)[0] ?? null;
		if (!candidate) {
			results.push({
				id: item.id,
				candidate: null,
				p: null,
				verdict: "no-candidate",
			});
			continue;
		}
		results.push(
			await judgeRecall({
				item,
				candidate,
				groundTruthNote,
				fetchImpl,
				key,
				timeoutMs,
			}),
		);
	}
	return { results, summary: summarizeResults(results) };
}

async function judgeRecall({
	item,
	candidate,
	groundTruthNote,
	fetchImpl,
	key,
	timeoutMs,
}) {
	try {
		const reply = await askJev({
			key,
			model: JEV_MODEL,
			state: {
				ground_truth_note: groundTruthNote,
				recall_item: `${item.id} — ${item.note ?? ""}`,
				candidate_finding: candidate.text,
			},
			questions: {
				describes_defect: {
					type: "noul",
					instructions:
						"Does the candidate finding describe the defect this recall item targets?",
					criteria: {
						true: "the finding names the specific defect the recall item describes (per the ground-truth note)",
						false:
							"the finding cites the location but describes something different from the targeted defect",
					},
				},
			},
			fetchImpl,
			timeoutMs,
		});
		if (reply.status !== "ok") throw new Error(reply.reason);
		const p = requireProbability(reply.body?.answers?.describes_defect?.noul);
		const verdict = recallVerdict(p);
		return { id: item.id, candidate: candidate.id, p, verdict };
	} catch (err) {
		return {
			id: item.id,
			candidate: candidate.id,
			p: null,
			verdict: "broken",
			note: String(err?.message ?? err),
		};
	}
}

function summarizeResults(results) {
	return {
		pass: results.filter((r) => r.verdict === "pass").length,
		uncertain: results.filter((r) => r.verdict === "uncertain").length,
		fail: results.filter((r) => r.verdict === "fail").length,
		noCandidate: results.filter((r) => r.verdict === "no-candidate").length,
		broken: results.filter((r) => r.verdict === "broken").length,
	};
}

function recallVerdict(p) {
	if (p >= PASS_BAR) return "pass";
	return p <= FAIL_BAR ? "fail" : "uncertain";
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		args[argv[i]?.replace(/^--/, "")] = argv[i + 1];
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const caseSpec = JSON.parse(readFileSync(resolve(args.case), "utf8"));
	const artifactPath = resolve(args.artifact);
	const outPath = resolve(args.out);
	if (!existsSync(artifactPath)) {
		writeFileSync(
			outPath,
			JSON.stringify(
				{ case: caseSpec.id, recall: [], unavailable: "artifact not found" },
				null,
				2,
			),
		);
		process.stdout.write("semantic: artifact not found\n");
		return;
	}
	const recallItems = caseSpec.checks?.recall ?? [];
	const artifactText = readFileSync(artifactPath, "utf8");
	const key = readKey({ envFile: resolve(REPO_ROOT, ".env") });
	if (!key) {
		writeFileSync(
			outPath,
			JSON.stringify(
				{
					case: caseSpec.id,
					recall: [],
					unavailable: NO_KEY_REASON,
				},
				null,
				2,
			),
		);
		process.stdout.write("semantic: UNAVAILABLE (no key)\n");
		return;
	}
	const { results, summary } = await semanticGrade({
		recallItems,
		groundTruthNote: caseSpec.ground_truth_note ?? "",
		artifactText,
		key,
	});
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				case: caseSpec.id,
				ground_truth_note: caseSpec.ground_truth_note ?? "",
				results,
				summary,
				unavailable: null,
			},
			null,
			2,
		),
	);
	process.stdout.write(
		`semantic: pass=${summary.pass} uncertain=${summary.uncertain} fail=${summary.fail} no-candidate=${summary.noCandidate} broken=${summary.broken}\n`,
	);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main().catch((err) => {
		process.stderr.write(`semantic: broken — ${err.message}\n`);
		process.exit(2);
	});
}
