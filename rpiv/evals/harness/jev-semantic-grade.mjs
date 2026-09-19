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

import { JEV_MODEL, readKey } from "../../scripts/jev-gate.mjs";

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
		const id = section.match(/^([A-Za-z]\w*\d+\w*)/)?.[1];
		if (!id) continue;
		findings.push({ id, text: section.trim().slice(0, 3000) });
	}
	return findings;
}

/** Does the finding cite a location inside the recall window? Best (nearest)
 * candidate wins; null when nothing is in range. */
export function matchCandidate(finding, recallItem) {
	let best = null;
	for (const target of recallItem.files ?? []) {
		for (const m of finding.text.matchAll(CITATION)) {
			const citedPath = m[1].replaceAll("\\", "/");
			const targetPath = target.path.replaceAll("\\", "/");
			const sameFile =
				citedPath === targetPath || targetPath.endsWith(`/${citedPath}`);
			if (!sameFile) continue;
			const line = Number(m[2]);
			const radius = target.radius ?? 0;
			const distance = target.line == null ? 0 : Math.abs(line - target.line);
			if (target.line == null || distance <= radius) {
				if (!best || distance < best.distance) {
					best = { id: finding.id, text: finding.text, distance };
				}
			}
		}
	}
	return best;
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
		try {
			const res = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
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
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const p = (await res.json()).answers.describes_defect.noul;
			const verdict =
				p >= PASS_BAR ? "pass" : p <= FAIL_BAR ? "fail" : "uncertain";
			results.push({ id: item.id, candidate: candidate.id, p, verdict });
		} catch (err) {
			results.push({
				id: item.id,
				candidate: candidate.id,
				p: null,
				verdict: "broken",
				note: String(err?.message ?? err),
			});
		}
	}
	const summary = {
		pass: results.filter((r) => r.verdict === "pass").length,
		uncertain: results.filter((r) => r.verdict === "uncertain").length,
		fail: results.filter((r) => r.verdict === "fail").length,
		noCandidate: results.filter((r) => r.verdict === "no-candidate").length,
		broken: results.filter((r) => r.verdict === "broken").length,
	};
	return { results, summary };
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
					unavailable: "no TYPESAFE_API_KEY in env or .env",
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
