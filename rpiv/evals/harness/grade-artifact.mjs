// grade-artifact.mjs — mechanical grader for review-skill and agent-output evals.
//
//   node grade-artifact.mjs --artifact <produced.md|out.md> --repo <worktree> --case <case.json> [--out grading.json]
//
// Every check is executable and zero-judgment: citation resolvability against the actual
// worktree, verbatim-quote greppability, frontmatter schema (via the plugin's own
// validate-artifact.mjs), recall of curated ground-truth items (file+line-window match),
// absence of re-reported fixed findings (pair+pattern within one finding unit), count
// ceilings, and agent-contract checks (>=2 cross-file cites per compound, constituents
// subset of the supplied ids, forbidden vocabulary, exact no-interaction response).
//
// The output is grading.json in the eval-viewer schema: expectations[] rows with
// { text, passed, evidence }. Semantic assertions (e.g. "the finding actually describes
// the load-cap duplication, not something else at that line") are NOT graded here — a
// grader model confirms the mechanical matches afterwards. Splitting it this way keeps
// the script trustworthy: a check either greps or it doesn't.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- CLI ----------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
const { artifact, repo } = args;
const caseSpec = JSON.parse(readFileSync(args.case, "utf-8"));
const checks = caseSpec.checks ?? {};
const expectations = [];
const expect = (text, passed, evidence) => expectations.push({ text, passed, evidence });

// ---------- artifact ----------
if (!artifact || !existsSync(artifact)) {
	expect("produced artifact exists", false, `not found: ${artifact}`);
	finish();
}
const text = readFileSync(artifact, "utf-8");
const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
const fmText = fmMatch?.[1] ?? "";
const body = fmMatch?.[2] ?? text;
expect("produced artifact exists", true, artifact);

// ---------- worktree file index ----------
// Skip anything that is not the source tree: dot-dirs (.git, .stryker-tmp — a full
// sandbox COPY of the sources that a T-lens mutation run leaves behind, .rpiv, ...),
// dependency/build/report output. Otherwise every real path resolves ambiguously.
// Exception: .github IS source tree (CI workflows are legitimate citation targets —
// a review's blast-radius rows cite them; iteration-4 DR-2 false-failed without this).
const SKIP_DIRS = new Set(["node_modules", "coverage", "reports", "playwright-report", "dist", "build", "out"]);
function walk(dir, acc, base) {
	for (const e of readdirSync(dir)) {
		if ((e.startsWith(".") && e !== ".github") || SKIP_DIRS.has(e)) continue;
		const p = join(dir, e);
		const rel = base ? `${base}/${e}` : e;
		if (statSync(p).isDirectory()) walk(p, acc, rel);
		else acc.push(rel);
	}
	return acc;
}
const tree = repo ? walk(repo, [], "") : [];
const fileCache = new Map();
function fileLines(rel) {
	if (!fileCache.has(rel)) {
		const p = join(repo, rel);
		fileCache.set(rel, existsSync(p) ? readFileSync(p, "utf-8").split("\n") : null);
	}
	return fileCache.get(rel);
}
function resolveRel(tok) {
	tok = tok.replace(/\\/g, "/").replace(/^\.\//, "");
	if (tree.includes(tok)) return tok;
	const suffix = tree.filter((p) => p.endsWith("/" + tok));
	if (suffix.length === 1) return suffix[0];
	// Ambiguous or missing both stay unresolved — an ambiguous basename is a bad
	// citation (un-greppable) — but report which, so failures are interpretable.
	resolveRel.why?.set(tok, suffix.length > 1 ? `ambiguous: ${suffix.length} matches` : "no such file");
	return null;
}
resolveRel.why = new Map();

// ---------- citation extraction from the produced document ----------
const CITE_RE = /([\w@$()./\\-]+\.(?:tsx?|mjs|cjs|jsx?|sql|css|scss|json|ya?ml|toml|md))(?::(\d+)(?:-(\d+))?)?/g;
// Exempt: artifact self-paths, URLs, glob/pattern fragments (`*-commands.ts` leaves a
// leading `-` after the regex skips `*`), template tokens, and the plugin's own helper
// scripts which artifacts cite as tool provenance ("from metrics.mjs"), not as code.
const EXEMPT_RE = /(^|\/)\.rpiv\/|^https?:|node_modules|\{|\}|^-|\*|^(metrics|semantic|mutation|coverage|fingerprint|warrant|now|review-range|validate-artifact|git-context)\.mjs$/;
function citesIn(chunk) {
	const out = [];
	for (const m of chunk.matchAll(CITE_RE)) {
		if (EXEMPT_RE.test(m[1])) continue;
		out.push({ raw: m[0], tok: m[1], line: m[2] ? Number(m[2]) : null, end: m[3] ? Number(m[3]) : null });
	}
	return out;
}

// ---------- 0. finalization state (always-on for review artifacts) ----------
// A run killed mid-flight (session limit, crash) leaves a plausible-looking skeleton:
// in-progress status + the skeleton's own step placeholders. Grading such an artifact
// as if it were a finished review produces vacuous PASSes (e.g. "absence" checks pass
// because nothing was reported at all) — so these two checks gate everything else.
if (checks.validate_artifact) {
	const status = fmText.match(/^status:\s*(\S+)/m)?.[1] ?? "(none)";
	expect("artifact reached status: ready (the run completed and finalized)", status === "ready", `status: ${status}`);
	const placeholders = body.match(/_\((?:Filled|To be written)[^)]*\)_|_To be written at Step \d+\._/g) ?? [];
	expect(
		"no unfilled step placeholders remain in the body",
		placeholders.length === 0,
		placeholders.length ? `${placeholders.length} placeholder(s), e.g. ${placeholders[0]}` : "none",
	);
}

// ---------- 1. validate-artifact.mjs (the plugin's own finalization lint) ----------
if (checks.validate_artifact) {
	const va = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/_shared/validate-artifact.mjs");
	try {
		execFileSync("node", [va, artifact, "--root", repo], { encoding: "utf-8" });
		expect("validate-artifact.mjs passes (frontmatter schema, no template tokens/TODOs, hash)", true, "exit 0");
	} catch (e) {
		expect("validate-artifact.mjs passes (frontmatter schema, no template tokens/TODOs, hash)", false, (e.stdout || e.message).trim().slice(0, 500));
	}
}

// ---------- 2. citation resolvability + line validity ----------
if (checks.citations) {
	const all = citesIn(body);
	const bad = [];
	let checked = 0;
	// Per-case exemptions: tokens that are format artifacts, not codebase citations
	// (e.g. an agent-table's plan-loc column holds bare `(file.ext)` names by contract,
	// and a dead-import finding legitimately cites the nonexistent path it reports).
	const ignore = (checks.citations.ignore ?? []).map((r) => new RegExp(r, "i"));
	for (const c of all) {
		if (ignore.some((re) => re.test(c.raw) || re.test(c.tok))) continue;
		const rel = resolveRel(c.tok);
		if (!rel) { bad.push(`${c.raw} (${resolveRel.why.get(c.tok.replace(/\\/g, "/").replace(/^\.\//, "")) ?? "no such file"})`); checked++; continue; }
		checked++;
		if (c.line != null) {
			const fl = fileLines(rel);
			if (!fl || c.line > fl.length) bad.push(`${c.raw} (line > ${fl?.length ?? 0})`);
		}
	}
	const pct = checked === 0 ? 100 : Math.round(((checked - bad.length) / checked) * 100);
	const min = checks.citations.min_resolvable_pct ?? 100;
	expect(
		`every file:line citation resolves in the worktree (>= ${min}%)`,
		pct >= min && checked > 0,
		`${checked - bad.length}/${checked} resolvable (${pct}%)${bad.length ? "; bad: " + bad.slice(0, 8).join(" | ") : ""}${checked === 0 ? "; NO cites found at all" : ""}`,
	);

	// verbatim quotes: `path:line` followed on the same line by a `code span` -> the span
	// must appear at the cited line (or within +-3 lines) after whitespace normalization.
	if (checks.citations.verbatim) {
		const misses = [];
		let quotes = 0;
		for (const line of body.split("\n")) {
			const cm = line.match(/`([\w@./\\-]+\.(?:tsx?|mjs|jsx?|sql)):(\d+)(?:-\d+)?`\s*[—:-]?\s*`([^`]{6,})`/);
			if (!cm) continue;
			quotes++;
			const rel = resolveRel(cm[1]);
			const fl = rel ? fileLines(rel) : null;
			if (!fl) { misses.push(`${cm[1]}:${cm[2]} (file missing)`); continue; }
			const norm = (s) => s.replace(/\s+/g, " ").trim();
			// Reviews legitimately truncate long lines with a trailing ellipsis — strip it.
			const want = norm(cm[3]).replace(/\s*(\.\.\.|…)$/, "");
			const ln = Number(cm[2]);
			const window = fl.slice(Math.max(0, ln - 4), ln + 3).map(norm);
			if (!window.some((w) => w.includes(want) || want.includes(w) && w.length > 5)) misses.push(`${cm[1]}:${cm[2]} != "${cm[3].slice(0, 60)}"`);
		}
		expect(
			"every verbatim quote matches the cited line (+-3 lines, whitespace-normalized)",
			misses.length === 0,
			`${quotes - misses.length}/${quotes} quotes match${misses.length ? "; miss: " + misses.slice(0, 6).join(" | ") : ""}`,
		);
	}
}

// ---------- 3. recall of curated ground-truth items ----------
for (const item of checks.recall ?? []) {
	const hits = [];
	const bodyCites = citesIn(body);
	for (const f of item.files) {
		const rel = resolveRel(f.path) ?? f.path;
		const found = bodyCites.filter((c) => (resolveRel(c.tok) ?? c.tok) === rel);
		const ok = found.some((c) => f.line == null || (c.line != null && Math.abs(c.line - f.line) <= (f.radius ?? 60)));
		if (ok) hits.push(f.path);
	}
	const min = item.min_files ?? 1;
	expect(
		`recall ${item.id}: cites >= ${min} of [${item.files.map((f) => f.path.split("/").pop() + (f.line ? ":" + f.line : "")).join(", ")}] — ${item.note ?? ""}`,
		hits.length >= min,
		`matched ${hits.length}/${item.files.length}: ${hits.join(", ") || "none"}`,
	);
}

// ---------- 4. absence: fixed findings must not be re-reported ----------
// Unit = one table row, or one bullet/paragraph block. A violation is a unit citing BOTH
// files of the pair AND matching the claim pattern (so a legit new finding touching the
// same files does not false-fail).
if (checks.absence?.length) {
	const units = [];
	for (const block of body.split(/\n\s*\n/)) {
		const rows = block.split("\n").filter((l) => /^\|/.test(l));
		if (rows.length) units.push(...rows);
		else units.push(block);
	}
	for (const item of checks.absence) {
		const re = new RegExp(item.pattern, "i");
		const viol = units.filter((u) => {
			const cited = citesIn(u).map((c) => resolveRel(c.tok) ?? c.tok);
			return item.pair.every((p) => cited.some((c) => c === p || c.endsWith("/" + p))) && re.test(u);
		});
		expect(
			`absence ${item.id}: the already-fixed finding (${item.note ?? item.pattern}) is NOT re-reported`,
			viol.length === 0,
			viol.length ? `re-reported in ${viol.length} unit(s): "${viol[0].slice(0, 160)}..."` : "not re-reported",
		);
	}
}

// ---------- 5. frontmatter numeric checks ----------
if (checks.frontmatter) {
	const fmNum = (key) => {
		const m = fmText.match(new RegExp(`(?:^|[{,\\s])${key}:\\s*(-?\\d+)`, "m"));
		return m ? Number(m[1]) : null;
	};
	for (const lens of checks.frontmatter.expect_nonzero_lenses ?? []) {
		const v = fmNum(lens);
		expect(`frontmatter slop_by_lens.${lens} > 0 (the lens with known ground truth fired)`, v != null && v > 0, `${lens}=${v}`);
	}
	for (const [key, max] of Object.entries(checks.frontmatter.max ?? {})) {
		const v = fmNum(key);
		expect(`frontmatter ${key} <= ${max}`, v != null && v <= max, `${key}=${v}`);
	}
	for (const [key, min] of Object.entries(checks.frontmatter.min ?? {})) {
		const v = fmNum(key);
		expect(`frontmatter ${key} >= ${min}`, v != null && v >= min, `${key}=${v}`);
	}
	for (const key of checks.frontmatter.present ?? []) {
		const ok = new RegExp(`^${key}:\\s*\\S`, "m").test(fmText);
		expect(`frontmatter field ${key} present and non-empty`, ok, ok ? "present" : "missing");
	}
}

// ---------- 6. agent-output contract checks ----------
if (checks.forbidden_vocab) {
	const re = new RegExp(checks.forbidden_vocab, "i");
	const hits = body.split("\n").filter((l) => re.test(l));
	expect(
		`output contains no findings/severity vocabulary (/${checks.forbidden_vocab}/i) — the agent maps, it does not judge`,
		hits.length === 0,
		hits.length ? `${hits.length} hits, e.g.: "${hits[0].trim().slice(0, 120)}"` : "clean",
	);
}
for (const sec of checks.required_sections ?? []) {
	const ok = new RegExp(sec, "m").test(body);
	expect(`output contains required section /${sec}/`, ok, ok ? "present" : "MISSING");
}
// ---------- section routing (which `## Section` a keyword lands in) ----------
// Tests an artifact's routing logic (e.g. discover puts a scope-creep aside under
// `## Suggested Follow-ups`, NOT `## Goals`). Splits the body on `## ` headings.
if (checks.section_routing?.length) {
	const sections = {};
	let cur = "(preamble)";
	sections[cur] = [];
	for (const line of body.split("\n")) {
		const h = line.match(/^##\s+(.*)$/);
		if (h) { cur = h[1].trim(); sections[cur] = sections[cur] ?? []; }
		else sections[cur].push(line);
	}
	const sectionText = (reStr) => {
		const re = new RegExp(reStr, "i");
		return Object.entries(sections).filter(([h]) => re.test(h)).map(([, b]) => b.join("\n")).join("\n");
	};
	for (const spec of checks.section_routing) {
		const kw = new RegExp(spec.keyword, "i");
		const inHit = kw.test(sectionText(spec.in_section));
		const notHit = spec.not_in_section ? kw.test(sectionText(spec.not_in_section)) : false;
		expect(
			`routing ${spec.id}: /${spec.keyword}/ under /${spec.in_section}/${spec.not_in_section ? ` and NOT under /${spec.not_in_section}/` : ""} — ${spec.note ?? ""}`,
			inHit && !notHit,
			`in-section: ${inHit ? "yes" : "NO"}${spec.not_in_section ? `; forbidden-section: ${notHit ? "PRESENT (leaked)" : "clean"}` : ""}`,
		);
	}
}
if (checks.expected_entities) {
	const missing = checks.expected_entities.filter((e) => !new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(body));
	expect(
		`all known entities named: [${checks.expected_entities.join(", ")}]`,
		missing.length === 0,
		missing.length ? "missing: " + missing.join(", ") : "all present",
	);
}
if (checks.compounds) {
	const blocks = body.split(/^### /m).filter((b) => /^IX-\d+/.test(b));
	const problems = [];
	for (const b of blocks) {
		const id = b.match(/^IX-\d+/)[0];
		const evidence = citesIn(b).map((c) => ({ ...c, rel: resolveRel(c.tok) }));
		const files = new Set(evidence.filter((e) => e.rel && e.line != null).map((e) => e.rel));
		if (files.size < 2) problems.push(`${id}: only ${files.size} distinct resolvable cited file(s)`);
		// verbatim: every backtick quote in the Evidence bullets must grep in its cited file
		for (const line of b.split("\n").filter((l) => /^\s*-\s*`[^`]+:\d+`/.test(l))) {
			const m = line.match(/`([^`]+):(\d+)`\s*—\s*`([^`]+)`/);
			if (!m) continue;
			const rel = resolveRel(m[1]);
			const fl = rel ? fileLines(rel) : null;
			const norm = (s) => s.replace(/\s+/g, " ").trim();
			const ln = Number(m[2]);
			if (!fl || !fl.slice(Math.max(0, ln - 4), ln + 3).map(norm).some((w) => w.includes(norm(m[3])))) problems.push(`${id}: quote not at ${m[1]}:${m[2]}`);
		}
		if (checks.compounds.constituents_subset_of) {
			// Parse ID-shaped tokens only (M1, D4, Tc12, L2-04) — agents sometimes annotate the
			// Constituents line with provenance prose; alien means an ID not in the supplied set.
			const line = b.match(/\*\*Constituents:\*\*\s*(.+)/)?.[1] ?? "";
			const cons = line.match(/\b[A-Z][A-Za-z]{0,2}-?\d{1,3}\b/g) ?? [];
			const alien = cons.filter((c) => !checks.compounds.constituents_subset_of.includes(c));
			if (alien.length) problems.push(`${id}: constituents not in supplied set: ${alien.join(", ")}`);
			if (cons.length === 0) problems.push(`${id}: no parseable constituent IDs`);
		}
	}
	expect(
		`every IX compound has >=2 distinct-file greppable cites, matching verbatim quotes, constituents within the supplied set (${blocks.length} compound(s))`,
		blocks.length > 0 && problems.length === 0,
		problems.length ? problems.slice(0, 6).join(" | ") : `${blocks.length} compounds clean`,
	);
}
if (checks.expect_no_interaction) {
	const ok = /No grounded cross-finding interaction/i.test(body);
	const ix = (body.match(/^### IX-\d+/gm) ?? []).length;
	expect(
		"returns the exact no-interaction response and emits zero IX compounds (hallucination pressure test)",
		ok && ix === 0,
		`no-interaction text: ${ok}; IX blocks: ${ix}`,
	);
}
if (checks.max_compounds != null) {
	const ix = (body.match(/^### IX-\d+/gm) ?? []).length;
	expect(
		`emits at most ${checks.max_compounds} compound(s) under pressure (restraint cap)`,
		ix <= checks.max_compounds,
		`IX blocks: ${ix}`,
	);
}
if (checks.require_rejection_reasoning) {
	// Restraint must be visible: findings NOT grouped are named with the reason they
	// failed admission, so triage knows they were considered rather than dropped.
	const ok = /(no other grounded|no grounded cross-finding|did not clear|fail(s|ed)? the admission test|ungrouped)/i.test(body);
	expect("explicitly accounts for non-grouped findings with rejection reasoning", ok, ok ? "rejection reasoning present" : "no rejection reasoning found");
}
if (checks.max_findings != null) {
	const n = (body.match(/^(?:### |\| ?)(?:🔴|🟡|I\d|S\d|Q\d)/gm) ?? []).length;
	expect(`total flagged findings <= ${checks.max_findings} (over-flagging ceiling on a clean diff)`, n <= checks.max_findings, `found ${n}`);
}
if (checks.max_table_rows != null) {
	// Row-format agents (one markdown table, one row per finding): count body rows —
	// every `|` line minus the header and separator. The max_findings marker regex
	// (🔴/I\d/...) never matches these tables, so this is their over-flagging ceiling.
	const rows = body.split("\n").filter((l) => /^\|/.test(l.trim())).length;
	const n = Math.max(0, rows - 2);
	expect(`table body rows <= ${checks.max_table_rows} (over-flagging ceiling)`, n <= checks.max_table_rows, `rows: ${n}`);
}

// ---------- 7. slice-verifier summary-row grading (capability + restraint) ----------
// The agent emits working notes then its final summary rows (Decisions / Cross-slice /
// [Correctness] / Research). We grade the FINAL rows only. To compare a 3-row baseline
// against the 4-row expanded agent FAIRLY, recall is scored as "caught in ANY row"
// (capability) — never "in the Correctness row" (that is format/routing, which only the
// 4-row agent can satisfy; scoring it would penalize the baseline for a format gap, not a
// missed bug — the exact conflation that made an earlier version misread the baseline).
// restraint = an out-of-vantage concern must not be promoted to a VIOLATION in any row.
// no_false_correctness = on a clean slice the Correctness row must carry no VIOLATION (an
// invented correctness bug); a 3-row agent with no Correctness row passes it trivially, so
// the check stays arm-fair. Legitimate Decisions/Cross-slice findings on a clean slice are
// allowed — a living codebase is never zero-finding (the IS-2/ACR-2 lesson). Working notes
// are excluded so an agent that declines an out-of-vantage concern is not penalized.
// Case-insensitive: the rows carry the agent's own prose.
if (checks.slice_rows) {
	const labels = checks.slice_rows.labels ?? ["Decisions", "Cross-slice", "Correctness", "Research"];
	const labelRe = new RegExp(`^\\s*-?\\s*(${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*:\\s*(.*)$`);
	const rowOf = {};
	for (const line of body.split("\n")) {
		const m = line.match(labelRe);
		if (m) rowOf[m[1]] = m[2]; // last occurrence wins -> the final summary row, not a working note
	}
	const allRows = labels.map((l) => rowOf[l] ?? "").join("\n");
	// capability: the defect is caught SOMEWHERE in the final rows (row-agnostic, arm-fair)
	for (const e of checks.slice_rows.capability ?? []) {
		const re = new RegExp(e.must_match, "i");
		const found = re.test(allRows);
		const where = labels.filter((l) => re.test(rowOf[l] ?? ""));
		expect(
			`capability ${e.id}: /${e.must_match}/ caught in some summary row — ${e.note ?? ""}`,
			found,
			found ? `caught (under ${where.join("/")})` : "NOT caught in any summary row",
		);
	}
	// restraint: an out-of-vantage concern must not be raised as a VIOLATION in any row
	for (const r of checks.slice_rows.restraint ?? []) {
		const re = new RegExp(r.forbid, "i");
		const flagged = labels.filter((l) => /VIOLATION/i.test(rowOf[l] ?? "") && re.test(rowOf[l] ?? ""));
		expect(
			`restraint ${r.id}: /${r.forbid}/ NOT raised as a VIOLATION (out of slice vantage) — ${r.note ?? ""}`,
			flagged.length === 0,
			flagged.length ? `OVER-REACH: raised under ${flagged.join("/")}` : "not flagged (correct)",
		);
	}
	// clean-slice false-positive control: the emitted code is correct, so the Correctness
	// row must carry no VIOLATION. A 3-row agent (no Correctness row) passes trivially.
	if (checks.slice_rows.no_false_correctness) {
		const cx = rowOf["Correctness"] ?? "";
		const invented = /VIOLATION/i.test(cx);
		expect(
			"clean slice: Correctness row carries no VIOLATION (no invented correctness bug)",
			!invented,
			invented ? `FALSE POSITIVE: "${cx.slice(0, 160)}"` : rowOf["Correctness"] == null ? "no Correctness row (3-row agent) — trivially clean" : "Correctness row clean",
		);
	}
}

finish();

function finish() {
	const passed = expectations.filter((e) => e.passed).length;
	// summary.pass_rate is what skill-creator's aggregate_benchmark reads.
	const grading = { case: caseSpec.id, artifact, expectations, summary: { passed, failed: expectations.length - passed, pass_rate: expectations.length ? passed / expectations.length : 0 } };
	if (args.out) writeFileSync(args.out, JSON.stringify(grading, null, 2));
	for (const e of expectations) console.log(`${e.passed ? "PASS" : "FAIL"}  ${e.text}\n      ${e.evidence}`);
	console.log(`\n${passed}/${expectations.length} checks passed`);
	process.exit(expectations.every((e) => e.passed) ? 0 : 1);
}
