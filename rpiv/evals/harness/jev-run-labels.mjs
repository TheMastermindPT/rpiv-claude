// evals/harness/jev-run-labels.mjs — the Jev junction for eval runs.
//
// After a run grades, the runner lints the captured agent output (via
// scripts/jev-eval-labels.mjs, which only acts when the agent has a ROW_LINTS
// entry) and then persists per-row MECHANICAL labels here: a row whose cited
// `path:line` does not resolve in the worktree, or whose backtick quote does
// not match the cited line (the grader's own tolerance: +-3 lines,
// whitespace-normalized), is labeled correct=false. Rows whose quotes match
// are correct=true. Rows without checkable citations get no label.
//
// These are the only eval-harness signals that map soundly to the lint's
// question (row-internal consistency). Recall/absence expectations measure a
// different question and are deliberately NOT used as labels.
//
// Inert-but-loud: a missing key or Jev outage must never fail an eval run.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { appendLabel, readLog } from "../../scripts/jev-lint-calibrate.mjs";
import { ROW_LINTS } from "../../scripts/jev-row-lint.mjs";

const CITATION_PATTERN =
	/([\w./\\-]+\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx|md|json|html|css)):(\d{1,5})/g;
const QUOTE_PATTERN = /`([^`\n]+)`/g;
const WINDOW = 3;

const normalize = (s) => s.replace(/\s+/g, " ").trim();

/** Extract (path, line, index) citation tokens from row text. */
export function extractCitations(text) {
	return [...text.matchAll(CITATION_PATTERN)].map((m) => ({
		path: m[1],
		line: Number(m[2]),
		index: m.index,
	}));
}

/** Extract backtick quote spans with their start index. */
export function extractQuotes(text) {
	return [...text.matchAll(QUOTE_PATTERN)].map((m) => ({
		quote: m[1],
		index: m.index,
	}));
}

/**
 * Check every citation in a row against the worktree: does the file resolve
 * and does the nearest backtick quote match the cited line (+-WINDOW,
 * whitespace-normalized)? Returns per-citation verdicts; "no-quote" means the
 * citation could not be mechanically checked.
 */
export function checkCitation(text, repoRoot) {
	const quotes = extractQuotes(text);
	const citations = extractCitations(text);
	const results = [];
	for (const c of citations) {
		const file = resolve(repoRoot, c.path);
		if (!existsSync(file)) {
			results.push({ ...c, verdict: "unresolvable" });
			continue;
		}
		const nearest = quotes.reduce((best, q) => {
			const d = Math.abs(q.index - c.index);
			return best && best.d <= d ? best : { d, q };
		}, null);
		if (!nearest) {
			results.push({ ...c, verdict: "no-quote" });
			continue;
		}
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		const lo = Math.max(1, c.line - WINDOW);
		const hi = Math.min(lines.length, c.line + WINDOW);
		const hit = lines
			.slice(lo - 1, hi)
			.some((l) => normalize(l).includes(normalize(nearest.q.quote)));
		results.push({ ...c, verdict: hit ? "match" : "mismatch" });
	}
	return results;
}

/**
 * The per-row label decision: correct=false when any citation is unresolvable
 * or mismatched; correct=true when at least one citation matches and none
 * fail; null (no label) when nothing is mechanically checkable.
 */
export function labelDecision(verdicts) {
	const checkable = verdicts.filter((v) => v.verdict !== "no-quote");
	if (checkable.length === 0) return null;
	const bad = checkable.some(
		(v) => v.verdict === "mismatch" || v.verdict === "unresolvable",
	);
	const good = checkable.some((v) => v.verdict === "match");
	if (bad) return false;
	if (good) return true;
	return null;
}

/**
 * Sync tail of the junction: read the lint-log entries the factory just wrote
 * for one agent output, mechanically label each, and append the labels with
 * the matching ts. Only agents whose ROW_LINTS entry declares
 * `mechanical: true` are labeled — their rows carry the verbatim
 * `file:line — \`quote\`` citation contract; every other agent's rows may
 * cite artifacts or paraphrases that a grep can never judge soundly.
 * Returns the count of labels written.
 */
export function labelFromLog(logPath, labelsPath, source, repoRoot) {
	const entries = readLog(logPath).filter((e) => e.source === source);
	let written = 0;
	for (const entry of entries) {
		if (!entry.row) continue;
		if (ROW_LINTS[entry.agent]?.mechanical !== true) continue;
		const decision = labelDecision(checkCitation(entry.row, repoRoot));
		if (decision == null) continue;
		appendLabel(labelsPath, {
			ts: entry.ts,
			id: entry.id,
			correct: decision,
		});
		written++;
	}
	return written;
}
