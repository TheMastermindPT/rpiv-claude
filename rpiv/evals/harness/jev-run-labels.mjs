// evals/harness/jev-run-labels.mjs — the Jev junction for eval runs.
//
// After a run grades, the runner lints the captured agent output (via
// scripts/jev-eval-labels.mjs, which only acts when the agent has a ROW_LINTS
// entry) and then persists per-row MECHANICAL labels here: a row whose cited
// `path:line` does not resolve in the worktree, or whose backtick quote does
// not match the cited line (the grader's own tolerance: +-3 lines,
// whitespace-normalized), is mechanically invalid. Persisted `correct` means
// agreement with the lint verdict, not citation validity. Uncheckable rows
// and broken judgments get no label.
//
// These are the only eval-harness signals that map soundly to the lint's
// question (row-internal consistency). Recall/absence expectations measure a
// different question and are deliberately NOT used as labels.
//
// Inert-but-loud: a missing key or Jev outage must never fail an eval run.

import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { appendLabel, readLog } from "../../scripts/jev-lint-calibrate.mjs";
import { ROW_LINTS } from "../../scripts/jev-row-lint.mjs";
import { readCompletedBatch } from "../../scripts/jev-source-store.mjs";

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
	const quotes = extractQuotes(text).filter((q) => {
		const citations = extractCitations(q.quote);
		return !citations.some((c) => `${c.path}:${c.line}` === q.quote);
	});
	const citations = extractCitations(text);
	const results = [];
	for (const c of citations) {
		const file = containedCitationPath(repoRoot, c.path);
		if (!file) {
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

function containedCitationPath(repoRoot, path) {
	try {
		const root = realpathSync(repoRoot);
		const file = realpathSync(resolve(root, path.replaceAll("\\", "/")));
		const rel = relative(root, file);
		return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
			? null
			: file;
	} catch {
		return null;
	}
}

/**
 * The per-row label decision: correct=false when any citation is unresolvable
 * or mismatched; correct=true when at least one citation matches and none
 * fail; null (no label) when nothing is mechanically checkable.
 */
export function labelDecision(verdicts) {
	const bad = verdicts.some(
		(v) => v.verdict === "mismatch" || v.verdict === "unresolvable",
	);
	if (bad) return false;
	return verdicts.some((v) => v.verdict === "match") ? true : null;
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
	const entries = entriesForSource(logPath, source);
	let written = 0;
	for (const entry of entries) {
		if (!entry.row) continue;
		if (entry.broken || !["ok", "flag", "review"].includes(entry.verdict))
			continue;
		if (ROW_LINTS[entry.agent]?.mechanical !== true) continue;
		const decision = labelDecision(checkCitation(entry.row, repoRoot));
		if (decision == null) continue;
		appendLabel(labelsPath, {
			ts: entry.ts,
			id: entry.id,
			correct: entry.verdict === "ok" ? decision : !decision,
		});
		written++;
	}
	return written;
}

function entriesForSource(logPath, source) {
	const batch = readCompletedBatch(logPath, source);
	return batch
		? batch.results
		: readLog(logPath).filter((entry) => entry.source === source);
}
