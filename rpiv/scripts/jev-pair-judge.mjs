// scripts/jev-pair-judge.mjs — orchestrator-invoked pair judgments: the
// "claimed-relation vs stated-content" family. The SKILL assembles the state
// (that's where the power is — the state matters more than the question);
// this script judges it and bands the answer.
//
// Checks:
//   scope      — does the finding build on the diff hunk as stated?
//                (deep-review reconcile: pre-existing issues re-badged as new)
//   resolution — does the proposed fix address the finding as stated?
//                (design/revise: fixes that answer a different problem)
//   oracle     — does the test assert the pinned oracle's exact contract?
//                (implement/validate: TDD-theater detection)
//
// Input: --check <name> --input pairs.json  where pairs.json is
//   { "pairs": [{ "id", "a", "b" }] }   a = claim, b = context
// Scope convenience (assembles pairs from a review's findings + patches):
//   --check scope --findings f.json --patches <patch-file> [--patches ...]
//   findings.json = [{ "id", "file", "line", "verbatim", "note" }]
//
// Bands: p >= 0.7 ok (silent), 0.3-0.7 uncertain (review), <= 0.3 miss
// (loud, per-check missLabel). Advisory: warns, never blocks, never overrides.
// A Jev outage is loud, never a silent pass.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { JEV_ENDPOINT, JEV_MODEL, readKey } from "./jev-gate.mjs";

export const OK_BAR = 0.7;
export const MISS_BAR = 0.3;

export const CHECKS = {
	scope: {
		aLabels: ["finding"],
		bLabels: ["patch hunk"],
		instructions:
			"Does the finding describe a problem the patch hunk introduces or directly affects?",
		trueCriteria:
			"the finding names a problem in the hunk's added or modified lines, or a direct consequence of them",
		falseCriteria:
			"the finding describes a problem in unchanged code the hunk merely touches — a pre-existing issue re-badged as new",
		missLabel: "out-of-scope",
	},
	resolution: {
		aLabels: ["resolution"],
		bLabels: ["finding as stated"],
		instructions: "Does the proposed resolution address the finding as stated?",
		trueCriteria:
			"the resolution names the finding's specific mechanism and changes its cause",
		falseCriteria:
			"the resolution addresses a different problem, or restates the finding without changing its cause",
		missLabel: "does-not-address",
	},
	oracle: {
		aLabels: ["test"],
		bLabels: ["pinned oracle"],
		instructions:
			"Does the test assert the pinned oracle's exact input -> expected-output contract?",
		trueCriteria:
			"the test exercises the oracle's exact inputs and asserts the exact expected outputs",
		falseCriteria:
			"the test checks a weaker property (presence, shape, adjacent value) than the oracle pins — test theater",
		missLabel: "theater",
	},
};

/** Parse a unified diff into per-file hunks with new-file start lines. */
export function parsePatchHunks(patchText) {
	const hunks = [];
	let currentFile = null;
	for (const line of patchText.split(/\r?\n/)) {
		const fileM = line.match(/^\+\+\+\s+b\/(.+)$/);
		if (fileM) {
			currentFile = fileM[1];
			continue;
		}
		const hunkM = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
		if (hunkM && currentFile) {
			hunks.push({ file: currentFile, start: Number(hunkM[1]), text: "" });
			continue;
		}
		const last = hunks[hunks.length - 1];
		if (last && currentFile === last.file) last.text += `${line}\n`;
	}
	return hunks;
}

/** The hunk covering (file, line), matched by path suffix. Null when absent. */
export function hunkFor(finding, hunks) {
	for (const hunk of hunks) {
		const sameFile =
			finding.file === hunk.file ||
			hunk.file.endsWith(`/${finding.file}`) ||
			finding.file.endsWith(`/${hunk.file}`);
		if (!sameFile) continue;
		const hunkLines = hunk.text.split(/\r?\n/).filter(Boolean).length;
		if (finding.line >= hunk.start && finding.line <= hunk.start + hunkLines) {
			return hunk;
		}
	}
	return null;
}

/** Assemble scope pairs from a review's findings and patch text(s). */
export function assembleScopePairs(findings, patchesText) {
	const hunks = patchesText.flatMap((t) => parsePatchHunks(t));
	const pairs = [];
	for (const f of findings) {
		const hunk = hunkFor(f, hunks);
		pairs.push({
			id: f.id,
			a: `${f.id} — \`${f.verbatim ?? ""}\` — ${f.note ?? ""}`,
			b: hunk
				? `file ${hunk.file}, hunk at line ${hunk.start}:\n${hunk.text.slice(0, 6000)}`
				: null,
		});
	}
	return pairs;
}

/** Judge one pair. Returns { id, p, verdict } or { id, broken }. */
export async function judgePair({
	check,
	pair,
	key,
	fetchImpl = fetch,
	endpoint = JEV_ENDPOINT,
	timeoutMs = 15_000,
}) {
	try {
		const res = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: JEV_MODEL,
				state: {
					[check.aLabels[0]]: pair.a,
					[check.bLabels[0]]: pair.b,
				},
				questions: {
					consistent: {
						type: "noul",
						instructions: check.instructions,
						criteria: {
							true: check.trueCriteria,
							false: check.falseCriteria,
						},
					},
				},
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from Jev endpoint`);
		const p = (await res.json()).answers?.consistent?.noul;
		if (typeof p !== "number") throw new Error("malformed Jev response");
		const verdict = p >= OK_BAR ? "ok" : p <= MISS_BAR ? "miss" : "uncertain";
		return { id: pair.id, p, verdict };
	} catch (err) {
		return { id: pair.id, broken: String(err?.message ?? err) };
	}
}

/** Judge every pair (bounded parallel). Pairs with a null context are skipped
 * loudly as no-context, never judged blind. */
export async function judgePairs({ check, pairs, key, fetchImpl }) {
	const results = [];
	const judged = [];
	const noContext = [];
	for (const pair of pairs) {
		if (pair.b == null) noContext.push(pair.id);
		else judged.push(pair);
	}
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(5, judged.length) },
		async () => {
			while (next < judged.length) {
				const i = next++;
				results[i] = await judgePair({
					check,
					pair: judged[i],
					key,
					fetchImpl,
				});
			}
		},
	);
	await Promise.all(workers);
	for (const id of noContext) {
		results.push({ id, verdict: "no-context" });
	}
	return results;
}

function parseArgs(argv) {
	const args = { patches: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--check") args.check = argv[++i];
		else if (argv[i] === "--input") args.input = argv[++i];
		else if (argv[i] === "--findings") args.findings = argv[++i];
		else if (argv[i] === "--patches") args.patches.push(argv[++i]);
		else if (argv[i] === "--out") args.out = argv[++i];
	}
	return args;
}

function readStdinText() {
	try {
		return readFileSync(0, "utf8").trim() || null;
	} catch {
		return null;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const check = CHECKS[args.check];
	if (!check) {
		process.stderr.write(
			`usage: --check scope|resolution|oracle [--input pairs.json | --findings f.json --patches p.patch] [--out out.json]\n`,
		);
		process.exit(2);
	}

	let pairs;
	if (args.check === "scope" && args.findings && args.patches.length > 0) {
		const findings = JSON.parse(readFileSync(resolve(args.findings), "utf8"));
		const patchesText = args.patches.map((p) =>
			readFileSync(resolve(p), "utf8"),
		);
		pairs = assembleScopePairs(findings, patchesText);
	} else {
		const raw = args.input
			? readFileSync(resolve(args.input), "utf8")
			: readStdinText();
		const input = raw ? JSON.parse(raw) : { pairs: [] };
		pairs = Array.isArray(input) ? input : (input.pairs ?? []);
	}

	const key = readKey();
	if (!key) {
		process.stderr.write(
			"jev-pair-judge broken: no TYPESAFE_API_KEY in env or .env\n",
		);
		process.exit(2);
	}
	const results = await judgePairs({ check, pairs, key });

	if (args.out) {
		writeFileSync(
			resolve(args.out),
			JSON.stringify({ check: args.check, results }, null, 2),
		);
	}
	for (const r of results) {
		if (r.verdict === "miss") {
			process.stdout.write(
				`[jev-pair] ${check.missLabel.toUpperCase()}: ${r.id} (p=${r.p.toFixed(2)})\n`,
			);
		} else if (r.verdict === "uncertain") {
			process.stdout.write(
				`[jev-pair] UNCERTAIN: ${r.id} (p=${r.p.toFixed(2)})\n`,
			);
		} else if (r.verdict === "no-context") {
			process.stdout.write(`[jev-pair] NO CONTEXT for ${r.id} — not judged\n`);
		} else if (r.broken) {
			process.stdout.write(`[jev-pair] BROKEN: ${r.id} — ${r.broken}\n`);
		}
	}
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main();
}
