// store.mjs — validated findings store for architectural-review artifacts.
//
//   echo '<finding JSON>' | node store.mjs add --artifact <review.md> [--root <dir>]
//   (Phase 3 adds: render --tally; `add` gains the .md sentinel splice)
//   (Phase 4 adds: finalize)
//
// The canonical record for AR findings is the same-stem sibling `<review>.json`;
// the `.md` stays the human-readable render (hybrid this iteration: skeleton,
// drift, and counters remain Edit-based — findings-first pilot).
//
// Validate-at-insert (the fingerprint.mjs precedent — validate BEFORE persisting):
// a record is rejected with nothing written unless every required field, enum,
// evidence citation (no ambiguous bare basenames — the check-citations rule),
// and its content-hash fingerprint check out. JSON validity is the store's own
// synchronous hard failure, not a reactive hook warning.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { basenameCounts, citesIn, fileIndex, isAmbiguous, resolveInIndex } from "./citation-grammar.mjs";
import { splitFrontmatter } from "./frontmatter.mjs";
import { isMain } from "./is-main.mjs";
import { extOf } from "./source-vocab.mjs";
import { stampArtifact, validateArtifact } from "./validate-artifact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FINGERPRINT = join(HERE, "fingerprint.mjs");

// ---- schema ------------------------------------------------------------------

// ══ Slice 1: schema foundation — kind discriminator + drift fields ══

export const KINDS = ["ar", "dr"];

// AR slop-lens tags (unchanged). DR lenses (I/Q/S/G) validate in the kind:"dr"
// arm added in Slice 8.
export const LENSES = ["D", "C", "G", "A", "T", "L", "Sec", "M", "S", "Lc", "Fe", "Fp", "Tc", "P", "IX", "10dim"];
// DR lenses (Slice 8): interaction / quality / security / gap — validated in the kind:"dr" arm.
export const DR_LENSES = ["I", "Q", "S", "G"];

// Enums that apply to BOTH kinds (triage status is shared).
export const SHARED_ENUMS = {
	status: ["open", "accepted", "rejected", "deferred", "withdrawn"],
};
// severity is SHARED CORE (per the locked DR-union decision) but its value set is
// KIND-DEPENDENT. AR: Low|Med|High. DR: the deep-review tiers (🔴 critical /
// 🟡 important / 🔵 suggestion / 💭 discuss — machine tokens, lowercase, per
// deep-review/templates/review.md:14,34).
export const SEVERITIES = {
	ar: ["Low", "Med", "High"],
	dr: ["critical", "important", "suggestion", "discuss"],
};
// blastRadius is an OPEN, MULTI-VALUE set (developer decision — a finding's blast
// can span dimensions and won't always fit a fixed list). BLAST_RADII is the
// RECOMMENDED vocabulary (incl. "other"); validation requires a non-empty array of
// non-empty strings but does NOT restrict values to this list.
export const BLAST_RADII = ["internal", "public-API", "on-disk", "cross-module", "other"];
// Enums that apply only to kind:"ar" (severity is shared above; blastRadius is the
// open array below; verify gains "Falsified" for Slice 4's retire-not-delete).
export const AR_ENUMS = {
	effort: ["S", "M", "L"],
	class: ["polish", "redesign"],
	verify: ["Verified", "Weakened", "Falsified"],
};
// Back-compat union export — ENUMS.severity/blastRadius keep the pilot's keys (the
// recommended vocabularies) so any importer of the flat ENUMS is unaffected.
export const ENUMS = { severity: SEVERITIES.ar, blastRadius: BLAST_RADII, ...SHARED_ENUMS, ...AR_ENUMS };

// SARIF baselineState (Slice 2 reads finding.baselineState ?? "new") and the rpiv
// drift classes (Slice 5 persists them). Regressed has no clean baselineState → it
// is emitted as "new" + a property bag (see Decisions).
export const BASELINE_STATES = ["new", "unchanged", "updated", "absent"];
export const DRIFT_CLASSES = ["NEW", "Still-open", "Resolved", "Regressed"];

const SHARED_REQUIRED_STRINGS = ["id", "title"];       // both kinds
const AR_REQUIRED_STRINGS = ["anchor", "what", "why"];  // kind:"ar" only
const OPTIONAL_NULLABLE = ["symbol", "entityStage", "crossCutTag", "statusNote"];
const KNOWN_KEYS = new Set([
	...SHARED_REQUIRED_STRINGS,
	...AR_REQUIRED_STRINGS,
	...OPTIONAL_NULLABLE,
	...Object.keys(SHARED_ENUMS),
	...Object.keys(AR_ENUMS),
	"kind", "severity", "blastRadius", "layer", "lens", "evidence", "remediation", "dependsOn", "fp",
	"baselineState", "driftClass", "priorFp", "priorId", "verifyNote",
	"fix", "alt", // kind:"dr" only (Slice 8)
]);

// ═══ Slice 1: validateFinding decomposition ═══

// Added near :88 (after KNOWN_KEYS) — shared field predicates + DR tier-Sets.
// Reused by later slices wherever the same compound-conditional shape appears.
const isNonEmptyStr = (x) => typeof x === "string" && x.trim().length > 0;
const isNonEmptyStrArray = (x) => Array.isArray(x) && x.length > 0 && x.every(isNonEmptyStr);
const isPositiveInt = (x) => Number.isInteger(x) && x >= 1;
const isStringArray = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
const isPlainObject = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
const isLayerId = (x) => /^\d+(\.\d+)?$/.test(String(x ?? ""));
// A nullable field is invalid only when PRESENT and failing its validator — the recurring
// "x != null && !ok(x)" shape, hoisted so the per-field checks stay single-branch.
const invalidWhenPresent = (x, ok) => x != null && !ok(x);
const DR_NEEDS_WHY = new Set(["critical", "important", "discuss"]);
const DR_NEEDS_FIX = new Set(["critical", "important", "suggestion"]);

// Replaces validateFinding :89-198 — the parent + 8 partial-array helpers. Each helper
// ACCUMULATES every error it finds (never first-only short-circuits — P1.2 asserts the
// 5-at-once surface). The parent spreads them in source order.

/** kind enum + unknown fields + required strings + dup-id (append-only). */
function validateShape(f, kind, priorIds) {
	const errors = [];
	if (!KINDS.includes(kind)) errors.push(`kind must be one of ${KINDS.join(" | ")} (got: ${f.kind})`);
	for (const k of Object.keys(f)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown field: ${k}`);
	for (const k of SHARED_REQUIRED_STRINGS) if (!isNonEmptyStr(f[k])) errors.push(`missing or empty field: ${k}`);
	if (typeof f.id === "string" && priorIds.has(f.id)) errors.push(`duplicate id: ${f.id} (IDs are append-only, never reused)`);
	return errors;
}

/** Shared enums + the kind-dependent severity value set. severity is guarded by
 *  KINDS.includes(kind) so an unknown kind ("xr") skips it → single enum error (P1.1). */
function validateSharedEnums(f, kind) {
	const errors = [];
	for (const [k, allowed] of Object.entries(SHARED_ENUMS)) {
		if (!allowed.includes(f[k])) errors.push(`${k} must be one of ${allowed.join(" | ")} (got: ${f[k]})`);
	}
	if (KINDS.includes(kind) && !SEVERITIES[kind].includes(f.severity)) {
		errors.push(`severity must be one of ${SEVERITIES[kind].join(" | ")} (got: ${f.severity})`);
	}
	return errors;
}

/** One evidence entry: path (resolvable, non-ambiguous), startLine, endLine, quoted. */
function validateEvidenceEntry(ev, i, counts) {
	const { path, startLine, endLine, quoted } = ev ?? {};
	const errors = [];
	if (!isNonEmptyStr(path)) errors.push(`evidence[${i}].path missing`);
	else if (isAmbiguous(path, counts)) errors.push(`evidence[${i}].path is an ambiguous bare basename: ${path} (rewrite repo-relative from the repository root)`);
	if (!isPositiveInt(startLine)) errors.push(`evidence[${i}].startLine must be a positive integer`);
	if (invalidWhenPresent(endLine, (e) => Number.isInteger(e) && e >= startLine)) errors.push(`evidence[${i}].endLine must be an integer >= startLine`);
	if (!isNonEmptyStrArray(quoted)) errors.push(`evidence[${i}].quoted must be a non-empty array of verbatim lines`);
	return errors;
}

/** Evidence structure — shared (both kinds cite a location + verbatim lines). */
function validateEvidence(f, counts) {
	if (!Array.isArray(f.evidence) || f.evidence.length === 0) return ["evidence must be a non-empty array"];
	return f.evidence.flatMap((ev, i) => validateEvidenceEntry(ev, i, counts));
}

/** remediation object shape (AR-only). */
function validateRemediation(r) {
	if (!isPlainObject(r)) return ["remediation must be an object"];
	const errors = [];
	for (const k of ["steps", "acceptance"]) {
		if (!isNonEmptyStrArray(r[k])) errors.push(`remediation.${k} must be a non-empty string array`);
	}
	for (const k of ["testStrategy", "tradeoff"]) if (!isNonEmptyStr(r[k])) errors.push(`remediation.${k} missing`);
	return errors;
}

/** AR-only fields (gated on kind:"ar" by the parent). */
function validateArFields(f) {
	const errors = [];
	for (const k of AR_REQUIRED_STRINGS) if (!isNonEmptyStr(f[k])) errors.push(`missing or empty field: ${k}`);
	if (!isLayerId(f.layer)) errors.push(`layer must be N or N.M (got: ${f.layer})`);
	if (!LENSES.includes(f.lens)) errors.push(`lens must be one of ${LENSES.join("/")} (got: ${f.lens})`);
	for (const [k, allowed] of Object.entries(AR_ENUMS)) {
		if (!allowed.includes(f[k])) errors.push(`${k} must be one of ${allowed.join(" | ")} (got: ${f[k]})`);
	}
	if (!isNonEmptyStrArray(f.blastRadius)) {
		errors.push("blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)");
	}
	errors.push(...validateRemediation(f.remediation));
	if (!isStringArray(f.dependsOn)) errors.push("dependsOn must be a string array (may be empty)");
	return errors;
}

/** DR-only fields (gated on kind:"dr" by the parent). */
function validateDrFields(f) {
	const errors = [];
	const sev = f.severity;
	if (!DR_LENSES.includes(f.lens)) errors.push(`lens must be one of ${DR_LENSES.join("/")} for kind:dr (got: ${f.lens})`);
	if (DR_NEEDS_WHY.has(sev) && !isNonEmptyStr(f.why)) errors.push(`kind:dr ${sev} finding requires a why`);
	if (DR_NEEDS_FIX.has(sev) && !isNonEmptyStr(f.fix)) errors.push(`kind:dr ${sev} finding requires a fix`);
	if (invalidWhenPresent(f.alt, isNonEmptyStr)) errors.push("alt must be a non-empty string or null (kind:dr)");
	if (!AR_ENUMS.verify.includes(f.verify)) errors.push(`verify must be one of ${AR_ENUMS.verify.join(" | ")} (got: ${f.verify})`);
	if (f.verify === "Falsified" && f.status !== "withdrawn") {
		errors.push("kind:dr Falsified finding must have status withdrawn");
	} else if (f.verify !== "Falsified" && f.status === "withdrawn") {
		errors.push("kind:dr withdrawn finding must be Falsified");
	}
	if (["Weakened", "Falsified"].includes(f.verify) && !isNonEmptyStr(f.verifyNote)) {
		errors.push(`kind:dr ${f.verify} finding requires a verifyNote`);
	}
	return errors;
}

/** Prose fields that RENDER as body text: an ambiguous bare-basename cite in any of
 *  them fails the Step-11.7 citation gate long after insert — inside a sentinel region
 *  hand-Edits are forbidden, so a bad cite that got in could not get out (dogfooding #1).
 *  Reject at write time instead, with the same ambiguity rule as evidence paths (a
 *  unique basename greps fine and stays legal). Shared by add and update re-validate. */
function validateProseCites(f, counts) {
	const prose = [
		["title", f.title], ["anchor", f.anchor], ["what", f.what], ["why", f.why],
		["fix", f.fix], ["alt", f.alt], ["statusNote", f.statusNote], ["verifyNote", f.verifyNote],
		...(isPlainObject(f.remediation)
			? [
					...(Array.isArray(f.remediation.steps) ? f.remediation.steps.map((s, i) => [`remediation.steps[${i}]`, s]) : []),
					...(Array.isArray(f.remediation.acceptance) ? f.remediation.acceptance.map((s, i) => [`remediation.acceptance[${i}]`, s]) : []),
					["remediation.testStrategy", f.remediation.testStrategy],
					["remediation.tradeoff", f.remediation.tradeoff],
				]
			: []),
	];
	const errors = [];
	for (const [field, text] of prose) {
		if (typeof text !== "string") continue;
		for (const c of citesIn(text)) {
			if (isAmbiguous(c.tok, counts)) {
				errors.push(`${field} cites ambiguous bare basename ${c.raw} (${counts.get(c.tok)} files named ${c.tok} in repo — write it repo-relative from the repository root)`);
			}
		}
	}
	return errors;
}

/** Drift fields — optional, validated when present (either kind). */
function validateDriftFields(f) {
	const errors = [];
	if (invalidWhenPresent(f.baselineState, (v) => BASELINE_STATES.includes(v))) errors.push(`baselineState must be one of ${BASELINE_STATES.join(" | ")} (got: ${f.baselineState})`);
	if (invalidWhenPresent(f.driftClass, (v) => DRIFT_CLASSES.includes(v))) errors.push(`driftClass must be one of ${DRIFT_CLASSES.join(" | ")} (got: ${f.driftClass})`);
	for (const k of ["priorFp", "priorId", "verifyNote"]) if (invalidWhenPresent(f[k], isNonEmptyStr)) errors.push(`${k} must be a non-empty string or null`);
	for (const k of OPTIONAL_NULLABLE) if (invalidWhenPresent(f[k], (v) => typeof v === "string")) errors.push(`${k} must be a string or null`);
	return errors;
}

/** Validate one finding against the schema + the shared ambiguity rule. Parent keeps the
 *  object-guard early return (the ONLY early return), the kind derivation, and the AR/DR
 *  dispatch; helpers return partial arrays spread in source order. Returns [] when clean,
 *  else every error found (all-at-once, never first-only). */
export function validateFinding(f, counts, priorIds = new Set()) {
	if (!isPlainObject(f)) return ["finding must be a JSON object"];
	const kind = f.kind ?? "ar";
	const errors = [
		...validateShape(f, kind, priorIds),
		...validateSharedEnums(f, kind),
		...validateEvidence(f, counts),
		...validateProseCites(f, counts),
	];
	if (kind === "ar") errors.push(...validateArFields(f));
	else if (kind === "dr") errors.push(...validateDrFields(f));
	errors.push(...validateDriftFields(f));
	return errors;
}

// ---- evidence grounding (against the real repo at --root) --------------------

const normWs = (s) => s.replace(/\s+/g, " ").trim();

// ═══ Slice 5: finalizeReview + checkEvidenceGrounding pure cores ═══

// -- checkEvidenceGrounding --

/** A normalized window line matches a quote — exact, or a long-enough prefix/suffix. */
const matchesQuote = (w, want) => w.includes(want) || (want.includes(w) && w.length > 5);

/** Match each quoted line against the ±3 window at ev.startLine (whitespace-normalized),
 *  returning an actionable error (naming the real line if the quote is elsewhere) per miss.
 *  Pure — operates on already-read file lines. normWs stays module-level. */
function groundQuoteInLines(lines, ev, i, rel) {
	const errors = [];
	const normLines = lines.map(normWs);
	const window = normLines.slice(Math.max(0, ev.startLine - 4), ev.startLine + 3);
	for (const q of ev.quoted) {
		const want = normWs(q).replace(/\s*(\.\.\.|…)$/, "");
		if (!window.some((w) => matchesQuote(w, want))) {
			const at = [];
			if (want) normLines.forEach((w, idx) => { if (w.includes(want)) at.push(idx + 1); });
			const hint = at.length ? ` (found at line${at.length > 1 ? "s" : ""} ${at.slice(0, 5).join(", ")})` : "";
			errors.push(`evidence[${i}].quoted not found at ${rel}:${ev.startLine} (±3)${hint}: "${q.slice(0, 50)}"`);
		}
	}
	return errors;
}

/** Ground every evidence entry against the repo: path resolves, startLine in range, and each
 *  quoted line greps at path:startLine (±3). Returns [] when clean, else every grounding error. */
export function checkEvidenceGrounding(finding, root) {
	const errors = [];
	const files = fileIndex(root);
	finding.evidence.forEach((ev, i) => {
		const rel = resolveInIndex(ev.path, files);
		if (!rel) {
			errors.push(`evidence[${i}].path does not resolve to a repo file: ${ev.path} (cite it repo-relative from the root)`);
			return;
		}
		const lines = readFileSync(join(root, rel), "utf-8").split("\n");
		if (ev.startLine > lines.length) {
			errors.push(`evidence[${i}].startLine ${ev.startLine} exceeds ${rel} length (${lines.length} lines)`);
			return;
		}
		errors.push(...groundQuoteInLines(lines, ev, i, rel));
	});
	return errors;
}

// ---- fingerprint (subprocess — never absorbed) -------------------------------

/** Content-hash fingerprint via fingerprint.mjs, honoring the drift-fingerprints
 * 8a assertions: exactly one stdout line per input line, and fp:null is an
 * insert rejection (invalid evidence), surfaced with the helper's own error.
 * `ext` (primary evidence path's extension) steers the helper's language-aware
 * comment grammar — see fingerprint.mjs's normalisation-v2 note. */
export function computeFingerprint(finding) {
	const quoted = finding.evidence.flatMap((ev) => ev.quoted);
	const ext = extOf(finding.evidence[0]?.path ?? "");
	const input = JSON.stringify({ id: finding.id, lens: finding.lens, quoted, symbol: finding.symbol ?? null, ext });
	const res = spawnSync(process.execPath, [FINGERPRINT], { input: `${input}\n`, encoding: "utf-8" });
	if (res.error) throw new Error(`fingerprint.mjs failed to spawn: ${res.error.message}`);
	if (res.status !== 0) throw new Error(`fingerprint.mjs exited ${res.status}: ${(res.stderr ?? "").trim()}`);
	const lines = (res.stdout ?? "").trim().split("\n").filter(Boolean);
	if (lines.length !== 1) throw new Error(`fingerprint.mjs emitted ${lines.length} lines for 1 input (count assertion)`);
	const out = JSON.parse(lines[0]);
	if (out.fp == null) throw new Error(`fingerprint invalid for ${finding.id}: ${out.error}`);
	return out.fp;
}

// ---- envelope IO -------------------------------------------------------------

/** `<review>.md` -> its same-stem canonical store `<review>.json`. */
export function deriveStorePath(artifactPath) {
	if (!/\.md$/.test(artifactPath)) throw new Error(`artifact must be a .md path: ${artifactPath}`);
	return artifactPath.replace(/\.md$/, ".json");
}

// ══ Slice 3: store init — explicit envelope + .md sentinel-region emission ══
// The layers-root region the template provides; init expands per-layer sections
// between these markers (a plain pair, not sentinelsFor's layer=N shape).
const LAYERS_REGION = { begin: "<!-- BEGIN store:layers -->", end: "<!-- END store:layers -->" };

/** One EMPTY per-layer section: heading + the two store-managed sentinel pairs with
 * empty interiors (add/render/update/diff splice findings + tally into them).
 * Byte-shaped per templates/architecture-review.md:292-363. */
function renderLayerSection(layer) {
	const heading = layer.name ? `## Layer ${layer.n} — ${layer.name}` : `## Layer ${layer.n}`;
	const f = sentinelsFor("findings", layer.n);
	const t = sentinelsFor("tally", layer.n);
	return [heading, "", f.begin, f.end, "", t.begin, t.end].join("\n");
}

// ═══ Slice 4: initStore pure normalizeInitSpec ═══

/** Normalize one layer spec ({ n, name }) or throw on a bad layer id. Pure. */
function normalizeLayer(l) {
	if (!isLayerId(l?.n)) throw new Error(`init: layer.n must be N or N.M (got: ${l?.n})`);
	return { n: String(l.n), name: typeof l.name === "string" ? l.name.trim() : "" };
}

/** Validate + normalize the init spec (pure — no IO). Returns { target, layers } or throws. */
function normalizeInitSpec(spec) {
	if (!isNonEmptyStr(spec?.target)) throw new Error("init: spec.target (non-empty string) is required");
	if (!Array.isArray(spec.layers) || spec.layers.length === 0) throw new Error("init: spec.layers must be a non-empty array");
	return { target: spec.target.trim(), layers: spec.layers.map(normalizeLayer) };
}

/** Explicit init: build the review.json envelope AND emit the per-layer skeleton sections into
 *  the .md's store:layers region. Refuses to clobber an existing store. Reads spec { target,
 *  layers: [{ n, name }] }. */
export function initStore(artifactPath, spec) {
	const storePath = deriveStorePath(artifactPath);
	if (existsSync(storePath)) throw new Error(`store already initialized: ${storePath} (delete it to re-init)`);
	if (!existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
	const { target, layers } = normalizeInitSpec(spec);
	const sections = layers.map(renderLayerSection).join("\n\n---\n\n");
	const text = spliceRegion(readFileSync(artifactPath, "utf-8"), LAYERS_REGION, sections);
	const store = {
		schema: 1,
		artifact: basename(artifactPath),
		target,
		createdAt: new Date().toISOString(),
		layers,
		findings: [],
	};
	saveStore(storePath, store);
	writeFileSync(artifactPath, text);
	return { storePath, layers: layers.map((l) => l.n) };
}

/** Initialize a code-review store without altering the write-once Markdown body. */
export function initReviewStore(artifactPath, spec) {
	const storePath = deriveStorePath(artifactPath);
	if (existsSync(storePath)) throw new Error(`store already initialized: ${storePath} (delete it to re-init)`);
	if (!existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
	if (!isNonEmptyStr(spec?.target)) throw new Error("init --review: spec.target (non-empty string) is required");
	if (!isPlainObject(spec.review)) throw new Error("init --review: spec.review must be an object");
	if (spec.review.sections != null && !isStringArray(spec.review.sections)) {
		throw new Error("init --review: review.sections must be a string array");
	}
	if (
		spec.review.in_scope_files_count != null &&
		(!Number.isInteger(spec.review.in_scope_files_count) || spec.review.in_scope_files_count < 0)
	) {
		throw new Error("init --review: review.in_scope_files_count must be a non-negative integer");
	}
	if (spec.review.status != null && spec.review.status !== "ready") {
		throw new Error("init --review: review.status must be ready");
	}
	if (spec.review.review_status != null && spec.review.review_status !== "complete") {
		throw new Error("init --review: review.review_status must be complete");
	}
	if (spec.review.merge_status != null) {
		throw new Error("init --review: review.merge_status is derived from active blockers");
	}
	const store = {
		schema: 1,
		artifact: basename(artifactPath),
		target: spec.target.trim(),
		createdAt: new Date().toISOString(),
		review: { ...spec.review, status: "ready", review_status: "complete" },
		findings: [],
	};
	saveStore(storePath, store);
	return { storePath };
}

/** Load the store. No more lazy-init: the store must be created by `store init`.
 * A missing envelope is an explicit error, not a silent frontmatter-derived stub. */
export function loadStore(artifactPath) {
	const storePath = deriveStorePath(artifactPath);
	if (!existsSync(storePath)) {
		throw new Error(`no store for ${basename(artifactPath)} — run \`store init\` first`);
	}
	return { storePath, store: JSON.parse(readFileSync(storePath, "utf-8")) };
}

export function saveStore(storePath, store) {
	writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
}

// ---- render (deterministic, sentinel-spliced) --------------------------------

/** Sentinel pair bounding a store-managed region of the .md render. */
export function sentinelsFor(kind, layer) {
	return {
		begin: `<!-- BEGIN store:${kind} layer=${layer} -->`,
		end: `<!-- END store:${kind} layer=${layer} -->`,
	};
}

/** Inline-code-safe verbatim quote: truncate at the first backtick (the prefix
 * stays character-exact and greppable, per the citation contract's `...`
 * convention); fall back to quote-replacement when the backtick leads the line. */
function codeSpanSafe(q) {
	if (!q.includes("`")) return q;
	const prefix = q.slice(0, q.indexOf("`")).trimEnd();
	return prefix ? `${prefix}...` : q.replaceAll("`", "'");
}

function evidenceLines(f) {
	return f.evidence
		.flatMap((ev) => {
			const range = ev.endLine != null ? `${ev.startLine}-${ev.endLine}` : String(ev.startLine);
			return ev.quoted.map((q) => `\`${ev.path}:${range}\` — \`${codeSpanSafe(q)}\``);
		})
		.join("\n");
}

/** One finding block, byte-shaped per templates/architecture-review.md:298-336 —
 * 15 rendered fields; `fp` and `symbol` persist in JSON but never render. */
export function renderFinding(f) {
	const lines = [
		`### ${f.id} — ${f.title}`,
		"",
		`- **Lens:** ${f.lens}`,
		"",
		"**Evidence**",
		"",
		evidenceLines(f),
		"",
		"**Quantified anchor**",
		"",
		f.anchor,
		"",
		"**What it is**",
		"",
		f.what,
		"",
		"**Why it's slop**",
		"",
		f.why,
		"",
		"**Remediation**",
		"",
		...f.remediation.steps.map((s, i) => `${i + 1}. ${s}`),
		"",
		`- **Acceptance criteria:** ${f.remediation.acceptance.join("; ")}`,
		`- **Test strategy:** ${f.remediation.testStrategy}`,
		`- **Trade-off / alternative:** ${f.remediation.tradeoff}`,
		"",
		`- **Severity:** ${f.severity}`,
		`- **Effort:** ${f.effort}`,
		`- **Blast radius:** ${Array.isArray(f.blastRadius) ? f.blastRadius.join(", ") : f.blastRadius}`,
		`- **Class:** ${f.class}`,
		`- **Entity / stage:** ${f.entityStage ?? "—"}`,
		`- **Verify:** ${f.verify}`,
		`- **Status:** **${f.status}**${f.statusNote ? ` — ${f.statusNote}` : ""}`,
		`- **Depends on:** ${f.dependsOn.length ? f.dependsOn.join(", ") : "—"}`,
	];
	if (f.crossCutTag) lines.push(`- **Cross-cut tag:** \`${f.crossCutTag}\``);
	return lines.join("\n");
}

/** Numeric layer order ("0.1" < "1", "2" < "10") for introduced-vs-reused tags. */
function layerLess(a, b) {
	const [a0, a1 = -1] = String(a).split(".").map(Number);
	const [b0, b1 = -1] = String(b).split(".").map(Number);
	return a0 !== b0 ? a0 < b0 : a1 < b1;
}

/** Deterministic tally region: status table + fired-lens counts (inline code by
 * construction — the backtick discipline the prose rule guarded) + cross-cut
 * tags + within-layer dependency edges. */
export function renderTally(store, layer) {
	const inLayer = store.findings.filter((f) => String(f.layer) === String(layer));
	const count = (status) => inLayer.filter((f) => f.status === status).length;
	const lensCounts = new Map();
	for (const f of inLayer) lensCounts.set(f.lens, (lensCounts.get(f.lens) ?? 0) + 1);
	const lensStr = [...lensCounts].map(([l, n]) => `${l}: ${n}`).join("; ");
	const tags = [...new Set(inLayer.map((f) => f.crossCutTag).filter(Boolean))];
	const introduced = [];
	const reused = [];
	for (const t of tags) {
		const earlier = store.findings.some((f) => f.crossCutTag === t && layerLess(f.layer, layer));
		(earlier ? reused : introduced).push(t);
	}
	const edges = inLayer
		.filter((f) => f.dependsOn.length > 0)
		.flatMap((f) =>
			f.dependsOn.map((d) => {
				const dep = store.findings.find((x) => x.id === d);
				return `- ${f.id} depends on ${d}${dep ? ` (${dep.title})` : ""}`;
			}),
		);
	const lines = [
		`### Layer ${layer} — tally`,
		"",
		"| Status | Count |",
		"|---|---|",
		`| accepted | ${count("accepted")} |`,
		`| rejected | ${count("rejected")} |`,
		`| deferred | ${count("deferred")} |`,
		`| withdrawn | ${count("withdrawn")} |`,
		"",
		`Slop lenses fired in this layer: \`{${lensStr}}\``,
		`Cross-cutting tags introduced: ${introduced.join(", ") || "none"}. Reused: ${reused.join(", ") || "none"}.`,
	];
	if (edges.length > 0) lines.push("", `Dependency edges within Layer ${layer}:`, "", ...edges);
	return lines.join("\n");
}

/** The begin/end sentinels are both present and correctly ordered. */
const sentinelPairFound = (bi, ei) => bi !== -1 && ei !== -1 && bi <= ei;

/** Idempotent sentinel splice: replace the region between begin/end. Sentinels
 * ABSENT is an error — the skeleton owns marker placement; the store never
 * guesses an insertion point (regen-decisions-index applyBlock precedent,
 * hardened: that one appends when absent, this one refuses). */
export function spliceRegion(text, { begin, end }, content) {
	const bi = text.indexOf(begin);
	const ei = text.indexOf(end);
	if (!sentinelPairFound(bi, ei)) throw new Error(`sentinel pair not found in artifact: ${begin}`);
	return `${text.slice(0, bi + begin.length)}\n${content}\n${text.slice(ei)}`;
}

/** Pure single-layer re-render over an in-memory .md text — the ONE copy of the
 * findings+tally splice sequence (used by renderInto and addFinding alike). */
function renderLayerText(text, store, layer, parts = { findings: true, tally: true }) {
	const inLayer = store.findings.filter((f) => String(f.layer) === String(layer));
	if (parts.findings) {
		text = spliceRegion(text, sentinelsFor("findings", layer), inLayer.map(renderFinding).join("\n\n"));
	}
	if (parts.tally) {
		text = spliceRegion(text, sentinelsFor("tally", layer), renderTally(store, layer));
	}
	return text;
}

/** Re-render this layer's store-managed regions inside the .md. `parts` selects
 * regions: add re-renders both; the 7.6 command re-renders the tally only. */
export function renderInto(artifactPath, store, layer, parts = { findings: true, tally: true }) {
	writeFileSync(artifactPath, renderLayerText(readFileSync(artifactPath, "utf-8"), store, layer, parts));
}

// ---- finalize ----------------------------------------------------------------

const HEALTH = ["healthy", "drifting", "degraded"];

/** Targeted frontmatter line replacement (head region only — body untouched). */
function setFrontmatterField(text, key, value) {
	const fmEnd = text.indexOf("\n---", 3);
	if (!text.startsWith("---") || fmEnd === -1) throw new Error("artifact has no frontmatter");
	const head = text.slice(0, fmEnd);
	const re = new RegExp(`^${key}:.*$`, "m");
	if (!re.test(head)) throw new Error(`frontmatter field not found: ${key}`);
	return head.replace(re, `${key}: ${value}`) + text.slice(fmEnd);
}

// -- finalizeReview --

/** Ids of untriaged (status:"open") findings — the finalize gate. Pure. */
function openIds(store) {
	return store.findings.filter((f) => f.status === "open").map((f) => f.id);
}

/** "id: path" for every evidence citation that is ambiguous under the current repo basename
 *  counts (a finding went ambiguous since insert). Pure. */
function ambiguousEvidence(findings, counts) {
	const out = [];
	for (const f of findings) {
		for (const ev of f.evidence) if (isAmbiguous(ev.path, counts)) out.push(`${f.id}: ${ev.path}`);
	}
	return out;
}

/** Phases-frontmatter gate: the `phases:` array the orchestrator rebuilds by hand must
 *  agree with the body's `### Phase N — <title>` headings — a wrong hand-rebuild would
 *  otherwise ship contract-schema-invalid frontmatter through the flip unchecked.
 *  Deliberately a CONSISTENCY check, not a rebuild: `depends_on`/`effort` are judgment
 *  fields the template body does not carry in parseable form. Returns an error string
 *  or null. */
function phasesGate(text) {
	const headings = [...text.matchAll(/^### Phase (\d+) — .+$/gm)].map((m) => Number(m[1]));
	if (headings.length === 0) {
		return "no `### Phase N — <title>` headings in the body — write the polish plan before finalize";
	}
	const fmEnd = text.indexOf("\n---", 3);
	const fmText = fmEnd < 0 ? "" : text.slice(0, fmEnd);
	const block = fmText.match(/^phases:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
	if (!block) return "frontmatter `phases:` array missing/empty — rebuild it from the `### Phase` headings";
	const entryLines = [...block[1].matchAll(/^[ \t]+-.*$/gm)].map((m) => m[0]);
	const ns = [];
	for (const line of entryLines) {
		const n = line.match(/\bn:\s*(\d+)/);
		if (!n) return `phases entry missing \`n:\` — ${line.trim()}`;
		if (!/\btitle\s*:/.test(line)) return `phases entry missing \`title:\` — ${line.trim()}`;
		ns.push(Number(n[1]));
	}
	const hs = [...new Set(headings)].sort((a, b) => a - b).join(",");
	const es = [...new Set(ns)].sort((a, b) => a - b).join(",");
	if (hs !== es) return `frontmatter phases n-set [${es}] != body \`### Phase\` headings [${hs}]`;
	return null;
}

/** Finalize gate — every finding triaged, no evidence went ambiguous since insert, phases
 *  frontmatter consistent with the body plan, body lint clean. Throws on the first failing
 *  gate; runs entirely BEFORE any write. */
function finalizeGate(artifactPath, store, root) {
	const open = openIds(store);
	if (open.length > 0) throw new Error(`untriaged findings remain: ${open.join(", ")}`);
	const ambiguous = ambiguousEvidence(store.findings, basenameCounts(root));
	if (ambiguous.length > 0) {
		throw new Error(`evidence went ambiguous since insert (repo gained same-named files): ${ambiguous.join("; ")}`);
	}
	const phasesErr = phasesGate(readFileSync(artifactPath, "utf-8"));
	if (phasesErr) throw new Error(`phases gate: ${phasesErr}`);
	const lint = validateArtifact(artifactPath, root, { finalizing: true, verifyHash: false });
	if (lint.errors.length > 0) {
		throw new Error(`body fails the finalization lint (resolve before finalizing):\n${lint.errors.map((e) => `  ${e}`).join("\n")}`);
	}
}

/** Step-11 ready flip: the gates (via finalizeGate), then health_score + status flip in the
 *  .md, mirrored envelope fields, and the content_hash stamp LAST. */
export function finalizeReview(artifactPath, root, healthScore) {
	if (!HEALTH.includes(healthScore)) {
		throw new Error(`--health-score must be one of ${HEALTH.join(" | ")} (got: ${healthScore ?? "none"})`);
	}
	const { storePath, store } = loadStore(artifactPath);
	finalizeGate(artifactPath, store, root);
	let text = readFileSync(artifactPath, "utf-8");
	const { fm } = splitFrontmatter(text);
	if (fm.status === "ready") throw new Error("artifact already ready — re-stamp via validate-artifact.mjs --stamp");
	text = setFrontmatterField(text, "health_score", healthScore);
	text = setFrontmatterField(text, "status", "ready");
	writeFileSync(artifactPath, text);
	store.status = "ready";
	store.healthScore = healthScore;
	store.finalizedAt = new Date().toISOString();
	saveStore(storePath, store);
	const hash = stampArtifact(artifactPath);
	return { hash, findings: store.findings.length };
}

// ---- add ---------------------------------------------------------------------

/** Validate-then-append-then-render. Throws without writing on ANY validation,
 * fingerprint, or sentinel error; on success persists review.json AND the .md. */
export function addFindings(artifactPath, root, findings) {
	if (!Array.isArray(findings) || findings.length === 0) {
		throw new Error("add-many: expected a non-empty JSON array of findings");
	}
	const { storePath, store } = loadStore(artifactPath);
	const counts = basenameCounts(root);
	const ids = new Set(store.findings.map((finding) => finding.id));
	const records = [];
	for (const finding of findings) {
		const errors = validateFinding(finding, counts, ids);
		if (errors.length > 0) throw new Error(errors.map((error) => `invalid finding: ${error}`).join("\n"));
		const grounding = checkEvidenceGrounding(finding, root);
		if (grounding.length > 0) throw new Error(grounding.map((error) => `invalid finding: ${error}`).join("\n"));
		const record = { ...finding, fp: computeFingerprint(finding) };
		records.push(record);
		ids.add(record.id);
	}
	store.findings.push(...records);
	const arLayers = [...new Set(records.filter((record) => (record.kind ?? "ar") === "ar").map((record) => record.layer))];
	if (arLayers.length > 0) {
		let text = readFileSync(artifactPath, "utf-8");
		for (const layer of arLayers) text = renderLayerText(text, store, layer);
		saveStore(storePath, store);
		writeFileSync(artifactPath, text);
	} else {
		saveStore(storePath, store);
	}
	return records;
}

/** Validate-then-append one finding through the batch implementation. */
export function addFinding(artifactPath, root, finding) {
	return addFindings(artifactPath, root, [finding])[0];
}

// ---- update (Slice 4 — verify transitions) ----------------------------------

// Weakened demotes one severity tier toward the less-severe end, per kind (explicit
// map — independent of SEVERITIES array order, which differs by kind). Floor stays.
const DEMOTE = {
	ar: { High: "Med", Med: "Low", Low: "Low" },
	dr: { critical: "important", important: "suggestion", suggestion: "discuss", discuss: "discuss" },
};

// ═══ Slice 2: updateFinding void in-place arms ═══
// DEMOTE stays module-level (unchanged) — declarative house-style const.

/** A DR demotion across a tier that requires a why/fix the finding lacks is a hard error
 *  the re-validate can't repair — guard it here (no-op for AR or a same-tier floor). */
function assertDemotionAllowed(f, kind, demoted) {
	if (kind !== "dr" || demoted === f.severity) return;
	if (DR_NEEDS_WHY.has(demoted) && !isNonEmptyStr(f.why)) throw new Error(`update: cannot Weaken ${f.id} to ${demoted} — that tier requires a \`why\` this finding lacks`);
	if (DR_NEEDS_FIX.has(demoted) && !isNonEmptyStr(f.fix)) throw new Error(`update: cannot Weaken ${f.id} to ${demoted} — that tier requires a \`fix\` this finding lacks`);
}

/** Weakened: demote one severity tier (requires a verifyNote). VOID — mutates f in place
 *  (f is a reference into store.findings; saveStore persists it). */
function applyWeakened(f, kind, patch) {
	if (!isNonEmptyStr(patch.verifyNote)) {
		throw new Error("update: Weakened requires a verifyNote (why it is narrower than first stated)");
	}
	f.verifyNote = patch.verifyNote.trim();
	const demoted = (DEMOTE[kind] ?? DEMOTE.ar)[f.severity] ?? f.severity;
	assertDemotionAllowed(f, kind, demoted);
	f.severity = demoted;
}

/** Falsified: retire-not-delete — status flips to "withdrawn" (requires a verifyNote).
 *  VOID — mutates f in place. */
function applyFalsified(f, patch) {
	if (!isNonEmptyStr(patch.verifyNote)) {
		throw new Error("update: Falsified requires a verifyNote (why the claim does not hold)");
	}
	f.verifyNote = patch.verifyNote.trim();
	f.status = "withdrawn"; // retire-not-delete — the record stays (append-only)
	delete f.baselineState;
	delete f.driftClass;
	delete f.priorFp;
	delete f.priorId;
}

// Content fields update may patch (each REPLACES the stored value wholesale, then the
// whole record re-validates like add). id is the selector; kind/layer/lens/fp and the
// drift fields (baselineState/driftClass/priorFp/priorId) stay immutable — identity,
// render-home, and store-diff-owned state respectively.
const PATCHABLE = ["title", "anchor", "what", "why", "evidence", "remediation", "severity", "effort", "blastRadius", "class", "symbol", "entityStage", "crossCutTag", "dependsOn", "fix", "alt"];
const PATCH_KEYS = new Set(["id", "verify", "verifyNote", "status", "statusNote", ...PATCHABLE]);

/** patch shape gate — id (string) required; an unknown/immutable key is a HARD error
 *  (a silently ignored patch field was dogfooding #1's exact failure mode); verify,
 *  when present, must be a valid verdict; and the patch must carry something to apply. */
function assertUpdatablePatch(patch) {
	if (!isNonEmptyStr(patch?.id)) throw new Error("update: patch.id (string) is required");
	const unknown = Object.keys(patch).filter((k) => !PATCH_KEYS.has(k));
	if (unknown.length > 0) {
		throw new Error(`update: unknown or immutable patch field(s): ${unknown.join(", ")} (updatable: verify, verifyNote, status, statusNote, ${PATCHABLE.join(", ")})`);
	}
	if (patch.verify != null && !AR_ENUMS.verify.includes(patch.verify)) {
		throw new Error(`update: verify must be one of ${AR_ENUMS.verify.join(" | ")} (got: ${patch.verify})`);
	}
	if (Object.keys(patch).every((k) => k === "id")) {
		throw new Error("update: patch carries only id — nothing to apply");
	}
}

/** Re-validate the mutated record (the demoted severity must stay a valid tier, etc.). */
function revalidateAfterUpdate(f, root) {
	const errors = validateFinding(f, basenameCounts(root), new Set());
	if (errors.length > 0) throw new Error(errors.map((e) => `invalid finding after update: ${e}`).join("\n"));
}

/** Apply a patch to an existing stored finding, in place, then re-render its layer.
 *  Two patch families compose (content first, verdict second):
 *  - CONTENT fields (PATCHABLE) each REPLACE the stored value wholesale, and the whole
 *    record re-validates like `add` — including evidence re-grounding and a fingerprint
 *    recompute when evidence/symbol change. The store is the only sanctioned writer
 *    inside sentinel regions, so it must accept the full finding shape (dogfooding #1:
 *    it used to silently drop every field but the verdict).
 *  - VERIFY verdict (optional): Verified stands. Weakened: demote one tier (from the
 *    PATCHED severity, when both ride one patch). Falsified: retire (status→withdrawn).
 *  An explicit status/statusNote in the patch overrides. Returns the updated record. */
export function updateFinding(artifactPath, root, patch) {
	assertUpdatablePatch(patch);
	const { storePath, store } = loadStore(artifactPath);
	const f = store.findings.find((x) => x.id === patch.id);
	if (!f) throw new Error(`update: no finding with id ${patch.id}`);
	const kind = f.kind ?? "ar";
	const wasFalsified = f.verify === "Falsified";
	const touched = PATCHABLE.filter((k) => k in patch);
	for (const k of touched) f[k] = patch[k];
	if (patch.verify != null) {
		f.verify = patch.verify;
		if (patch.verify === "Weakened") applyWeakened(f, kind, patch);
		else if (patch.verify === "Falsified") applyFalsified(f, patch);
		else if (isNonEmptyStr(patch.verifyNote)) f.verifyNote = patch.verifyNote.trim();
		else delete f.verifyNote;
	} else if (isNonEmptyStr(patch.verifyNote)) {
		f.verifyNote = patch.verifyNote.trim();
	}
	if (typeof patch.status === "string") f.status = patch.status;
	if (f.verify === "Falsified") f.status = "withdrawn";
	if (wasFalsified && patch.verify != null && patch.verify !== "Falsified" && patch.status == null) {
		throw new Error("update: changing a Falsified verdict requires an explicit status");
	}
	if (typeof patch.statusNote === "string") f.statusNote = patch.statusNote.trim();
	revalidateAfterUpdate(f, root);
	if (touched.includes("evidence")) {
		const grounding = checkEvidenceGrounding(f, root);
		if (grounding.length > 0) throw new Error(grounding.map((e) => `invalid finding after update: ${e}`).join("\n"));
	}
	// fp hashes { lens, quoted, symbol }; id is correlation metadata only — recompute when inputs moved, so the
	// next `store diff` sees the edited finding as changed content, not the old one.
	if (touched.includes("evidence") || touched.includes("symbol")) f.fp = computeFingerprint(f);
	saveStore(storePath, store);
	if (kind === "ar") renderInto(artifactPath, store, f.layer); // DR whole-doc re-render: Slice 8
	return f;
}

// ---- diff (Slice 5 — drift classification) ----------------------------------
// Findings already carry a stored `fp` (computed at add), so drift matches on stored
// fingerprints directly — no fingerprint.mjs recompute. Persists baselineState +
// driftClass on current findings (Slice 2's toSarif reads them via `?? "new"`).

const DRIFT_REGION = { begin: "<!-- BEGIN store:drift -->", end: "<!-- END store:drift -->" };

/** The Drift Delta region body (no heading — the `## Drift Delta` section heading is
 * template-owned, outside the sentinels): a vs-line, a 4-class count table, and the
 * NEW / Regressed / Resolved id lists. */
export function renderDrift(store) {
	const d = store.drift;
	const byClass = (cls) => store.findings.filter((f) => f.driftClass === cls).map((f) => `- ${f.id} — ${f.title}`);
	const lines = [
		`_vs \`${d.priorArtifact}\` — compared ${d.comparedAt.slice(0, 10)}_`,
		"",
		"| Class | Count |",
		"|---|---|",
		`| NEW | ${d.counts.new} |`,
		`| Still-open | ${d.counts.stillOpen} |`,
		`| Regressed | ${d.counts.regressed} |`,
		`| Resolved | ${d.counts.resolved} |`,
	];
	const section = (title, rows) => { if (rows.length) lines.push("", `**${title}**`, "", ...rows); };
	section("NEW", byClass("NEW"));
	section("Regressed (fixed, now back)", byClass("Regressed"));
	section("Resolved (gone since prior)", d.resolved.map((r) => `- ${r.id} — ${r.title}`));
	return lines.join("\n");
}

/** Fingerprint-match current findings against a prior review and classify each:
 *   Still-open — fp matches an active prior finding      → baselineState "unchanged"
 *   Regressed  — fp is in the prior review's drift.resolved set (fixed, now back)
 *                                                        → baselineState "new" + priorFp/priorId
 *   NEW        — fp in neither                           → baselineState "new"
 * Prior findings whose fp is absent from current are Resolved (captured in the drift
 * summary + rendered in the Drift Delta; NOT carried into the findings array — they
 * stay in review.json's `drift` envelope). Persists on the current store, updates the
 * frontmatter `drift:` counts (if present), and splices the Drift Delta region. */
export function diffReview(artifactPath, priorPath) {
	const { storePath, store } = loadStore(artifactPath);
	if (!existsSync(priorPath)) throw new Error(`diff: prior review not found: ${priorPath}`);
	const prior = JSON.parse(readFileSync(priorPath, "utf-8"));
	const activeCurrent = store.findings.filter((finding) => finding.status !== "withdrawn");
	const activePrior = (prior.findings ?? []).filter((finding) => finding.status !== "withdrawn");
	const priorByFp = new Map(activePrior.map((f) => [f.fp, f]));
	const priorResolved = new Map((prior.drift?.resolved ?? []).map((r) => [r.fp, r]));
	const currentFps = new Set(activeCurrent.map((f) => f.fp));
	for (const f of activeCurrent) {
		const p = priorByFp.get(f.fp);
		if (p) {
			f.driftClass = "Still-open";
			f.baselineState = "unchanged";
			f.priorFp = p.fp;
			f.priorId = p.id;
		} else if (priorResolved.has(f.fp)) {
			f.driftClass = "Regressed";
			f.baselineState = "new"; // SARIF cannot say "fixed then came back" — property bag carries it
			f.priorFp = f.fp;
			f.priorId = priorResolved.get(f.fp).id ?? null;
		} else {
			f.driftClass = "NEW";
			f.baselineState = "new";
			f.priorFp = null;
			f.priorId = null;
		}
	}
	const resolved = activePrior
		.filter((p) => !currentFps.has(p.fp))
		.map((p) => ({ id: p.id, title: p.title, fp: p.fp }));
	store.drift = {
		priorArtifact: prior.artifact ?? basename(priorPath),
		comparedAt: new Date().toISOString(),
		resolved,
		counts: {
			new: activeCurrent.filter((f) => f.driftClass === "NEW").length,
			stillOpen: activeCurrent.filter((f) => f.driftClass === "Still-open").length,
			regressed: activeCurrent.filter((f) => f.driftClass === "Regressed").length,
			resolved: resolved.length,
		},
	};
	saveStore(storePath, store);
	let text = readFileSync(artifactPath, "utf-8");
	const c = store.drift.counts;
	const net = c.new - c.resolved;
	const head = text.slice(0, text.indexOf("\n---", 3));
	if (/^drift:/m.test(head)) {
		text = setFrontmatterField(text, "drift", `{ resolved: ${c.resolved}, regressed: ${c.regressed}, still_open: ${c.stillOpen}, new: ${c.new}, net: ${net >= 0 ? "+" : ""}${net} }`);
	}
	const isDrReview = Boolean(store.review) || store.findings.every((finding) => (finding.kind ?? "ar") === "dr");
	if (!isDrReview) {
		text = spliceRegion(text, DRIFT_REGION, renderDrift(store));
		writeFileSync(artifactPath, text);
	}
	return store.drift;
}

// ---- query --clusters (Slice 6 — read-only cluster discovery) ---------------

// ═══ Slice 3: queryClusters helpers ═══

/** A cluster is "anticipated" when every member shares one cross-cut tag (the
 *  "subtract known themes" step). */
function anticipatedOf(ids, byId) {
	const tags = ids.map((id) => byId.get(id)?.crossCutTag).filter(Boolean);
	return tags.length === ids.length && new Set(tags).size === 1;
}

/** Bucket active finding ids by every key `keysOf` yields (falsy keys skipped). */
function groupIds(active, keysOf) {
	const map = new Map();
	for (const f of active) {
		for (const k of keysOf(f)) {
			if (!k) continue;
			if (!map.has(k)) map.set(k, []);
			map.get(k).push(f.id);
		}
	}
	return map;
}

/** Group active findings by a shared store-intrinsic key (file / symbol / entity-stage),
 *  keeping only groups of >= 2 findings. Returns clusters[]. */
function groupByKey(dimension, active, keysOf, byId) {
	const clusters = [];
	for (const [key, ids] of groupIds(active, keysOf)) {
		if (ids.length >= 2) clusters.push({ dimension, key, ids, anticipated: anticipatedOf(ids, byId) });
	}
	return clusters;
}

/** The canonical unordered edges one finding contributes (self-refs + dangling skipped). */
function edgesFrom(f, byId) {
	const edges = [];
	if (!Array.isArray(f.dependsOn)) return edges;
	for (const d of f.dependsOn) {
		if (d !== f.id && byId.has(d)) edges.push([f.id, d].sort());
	}
	return edges;
}

/** Each Depends-on edge → a 2-member cluster. Edges canonicalized to an UNORDERED pair
 *  (mutual A<->B is one cluster) and self-references skipped. NOT routed through groupByKey
 *  — an edge names both members, so grouping would yield a length-1 group (P6.1/P6.2). */
function dependsOnClusters(active, byId) {
	const clusters = [];
	const seen = new Set();
	for (const f of active) {
		for (const ids of edgesFrom(f, byId)) {
			const key = ids.join(" <-> ");
			if (seen.has(key)) continue;
			seen.add(key);
			clusters.push({ dimension: "dependsOn", key, ids, anticipated: anticipatedOf(ids, byId) });
		}
	}
	return clusters;
}

/** Discover clusters over the persisted finding set (Step 9.5 steps 1-3): group
 *  accepted/deferred findings by file / symbol / entity-stage, plus each Depends-on edge as
 *  a 2-member cluster, keeping only groups of >= 2 distinct findings. Each cluster is flagged
 *  `anticipated` when every member already shares one cross-cut tag. READ-ONLY. */
export function queryClusters(store) {
	const active = store.findings.filter((f) => f.status === "accepted" || f.status === "deferred");
	const byId = new Map(active.map((f) => [f.id, f]));
	const clusters = [
		...groupByKey("file", active, (f) => f.evidence.map((ev) => ev.path), byId),
		...groupByKey("symbol", active, (f) => [f.symbol], byId),
		...groupByKey("entity", active, (f) => [f.entityStage], byId),
		...dependsOnClusters(active, byId),
	];
	return { clusters, discovered: clusters.length, unanticipated: clusters.filter((c) => !c.anticipated).length };
}

// ---- query --plan (Step 11 topo order + base ranking, absorbed) --------------

const PLAN_SEV_W = { High: 3, Med: 2, Low: 1 };
const PLAN_BLAST_W = { "cross-module": 4, "public-API": 3, "on-disk": 3, internal: 1 };
const PLAN_EFFORT_W = { S: 1, M: 2, L: 3 };

/** Deterministic Step-11 inputs over the ACCEPTED findings: Kahn topo order along
 *  `dependsOn` (dependency-free findings first; cycles broken at the smallest id and
 *  flagged) plus the base `severity x blast-radius / effort` ranking the Risk Rollup
 *  starts from. Weights are documented in the rendered header. The compound-risk
 *  promotion rule and the volatile-hub/bus-factor weighting stay judgment-tier —
 *  they need IX/theme/metrics context the store does not hold. READ-ONLY. */
export function queryPlan(store) {
	const active = store.findings.filter((f) => f.status === "accepted");
	const ids = new Set(active.map((f) => f.id));
	const rowOf = (f) => {
		const blast = (Array.isArray(f.blastRadius) ? f.blastRadius : []).reduce(
			(best, b) => Math.max(best, PLAN_BLAST_W[b] ?? 2),
			0,
		);
		const score = ((PLAN_SEV_W[f.severity] ?? 2) * (blast || 2)) / (PLAN_EFFORT_W[f.effort] ?? 2);
		return { id: f.id, sev: f.severity, blast: (f.blastRadius ?? []).join("+") || "-", effort: f.effort, score, dependsOn: (f.dependsOn ?? []).filter((d) => ids.has(d)), cycle: false };
	};
	const rows = new Map(active.map((f) => [f.id, rowOf(f)]));
	// Kahn: in-degree = # in-set dependencies not yet emitted; deps land before dependents.
	const remaining = new Map([...rows.values()].map((r) => [r.id, r.dependsOn.length]));
	const dependents = new Map();
	for (const r of rows.values()) {
		for (const d of r.dependsOn) {
			if (!dependents.has(d)) dependents.set(d, []);
			dependents.get(d).push(r.id);
		}
	}
	const sortedIds = [...rows.keys()].sort();
	const done = new Set();
	const order = [];
	while (done.size < rows.size) {
		let pick = sortedIds.find((id) => !done.has(id) && remaining.get(id) === 0);
		if (pick == null) {
			pick = sortedIds.find((id) => !done.has(id)); // dependency cycle — break at the smallest id
			rows.get(pick).cycle = true;
		}
		done.add(pick);
		order.push(rows.get(pick));
		for (const dep of dependents.get(pick) ?? []) {
			if (!done.has(dep)) remaining.set(dep, remaining.get(dep) - 1);
		}
	}
	const ranked = [...order].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return { order, ranked };
}

/** Render the plan report for stdout. */
export function renderPlan({ order, ranked }) {
	const fmt = (r) =>
		`${r.id}\tsev=${r.sev}\tblast=${r.blast}\teffort=${r.effort}\tscore=${r.score.toFixed(2)}\tdependsOn=${r.dependsOn.join(",") || "-"}${r.cycle ? "\tCYCLE-BROKEN" : ""}`;
	const lines = [
		`Plan: ${order.length} accepted finding(s). score = severity(High3/Med2/Low1) x max-blast(cross-module4/public-API3/on-disk3/other2/internal1) / effort(S1/M2/L3).`,
		"---plan-order---",
		...order.map(fmt),
		"---plan-rank---",
		...ranked.map(fmt),
	];
	return `${lines.join("\n")}\n`;
}

/** Render the cluster report for stdout. */
export function renderClusters({ clusters, discovered, unanticipated }) {
	const lines = [`Clusters: ${discovered} discovered (${unanticipated} un-anticipated).`];
	if (clusters.length === 0) lines.push("  (none — no shared dimension across >= 2 findings)");
	for (const c of clusters) lines.push(`  [${c.anticipated ? "known" : "AUTO"}] ${c.dimension} ${c.key}: ${c.ids.join(", ")}`);
	return lines.join("\n");
}

// ---- DR render mode (Slice 8 — whole-document write-once assembly) ----------

// DR severity tiers → emoji + section title, render order most-severe first. Emoji
// byte-preserved (consumers grep 🔴/🟡/🔵/💭 verbatim — deep-review/SKILL.md:477).
const DR_TIERS = [
	{ sev: "critical", emoji: "🔴", section: "Critical" },
	{ sev: "important", emoji: "🟡", section: "Important" },
	{ sev: "suggestion", emoji: "🔵", section: "Suggestions" },
	{ sev: "discuss", emoji: "💭", section: "Discussion" },
];

const DR_LEGEND = [
	"## Legend", "", "```text",
	"Severity    🔴 fix before merge   🟡 fix soon   🔵 nice to have   💭 discuss",
	"ID prefix   I interaction   Q quality   S security   G gap",
	"Verify      ✓ verified   − weakened (demoted)   ✗ falsified (dropped)",
	"Annotate    [precedent-weighted]   [cascade: <kind>]   [subsumed-by <ID>]", // byte-shaped per templates/review.md:37
	"```",
].join("\n");

// ═══ Slice 6: renderDrFinding data-driven tier table ═══

// Which display sections each DR tier shows, in order (deep-review/templates/review.md:42-105).
// Data-driven replacement for the four ||-chain tier conditionals (the cc=11 driver).
const DR_TIER_SECTIONS = {
	critical: ["Code", "Why", "Fix", "Alt"],
	important: ["Code", "Why", "Fix"],
	suggestion: ["Fix"],
	discuss: ["Why"],
};

/** Emit one display section's lines for a DR finding ([] when the field is absent — Alt). */
function drSection(name, f) {
	if (name === "Code") return ["", "**Code**", "```", f.evidence.flatMap((ev) => ev.quoted).join("\n"), "```"];
	if (name === "Why") return ["", "**Why**", f.why];
	if (name === "Fix") return ["", "**Fix**", f.fix];
	if (name === "Alt") return f.alt ? ["", "**Alt**", f.alt] : [];
	return [];
}

/** One DR finding block, degrade-per-tier (deep-review/templates/review.md:42-105):
 *   critical: Where + Code + Why + Fix + Alt?   important: Where + Code + Why + Fix
 *   suggestion: Where + Fix                      discuss: Where + Why
 * Code/Why/Fix persist for all tiers (fingerprint/validation) but only DISPLAY per tier.
 * Unknown severity → suggestion emoji (DR_TIERS[2]) + no sections (only Where), as before. */
export function renderDrFinding(f) {
	const tier = DR_TIERS.find((t) => t.sev === f.severity) ?? DR_TIERS[2];
	const where = f.evidence.map((ev) => `\`${ev.path}:${ev.endLine != null ? `${ev.startLine}-${ev.endLine}` : ev.startLine}\``).join(" ");
	const lines = [`### ${f.id} ${tier.emoji} ${f.title}`, "", "**Where**", where];
	for (const name of DR_TIER_SECTIONS[f.severity] ?? []) lines.push(...drSection(name, f));
	return lines.join("\n");
}

/** Whole-document DR assembly (write-once — NOT sentinel splice). Full template frontmatter
 * (metadata from store.review; severity/verification counts + blockers_count derived), Legend,
 * Top Blockers (🔴 + 🟡, per deep-review/SKILL.md:398,:441), the four severity sections, then
 * any envelope-carried trailing analysis sections (store.review.sections, pre-rendered by the
 * DR skill). Withdrawn (falsified-retired) omitted from the body; falsified still counted. */
export function renderReview(store) {
	const meta = store.review ?? {};
	const active = store.findings.filter((f) => (f.kind ?? "ar") === "dr" && f.status !== "withdrawn");
	const n = (sev) => active.filter((f) => f.severity === sev).length;
	const vn = (V) => store.findings.filter((f) => (f.kind ?? "ar") === "dr" && f.verify === V).length; // capitalized store → lowercase key
	const fm = [
		"---",
		"template_version: 2",
		`date: ${meta.date ?? ""}`,
		`author: ${meta.author ?? ""}`,
		`repository: ${meta.repository ?? ""}`,
		`branch: ${meta.branch ?? ""}`,
		`commit: ${meta.commit ?? ""}`,
		`review_type: ${meta.review_type ?? "working"}`,
		`scope: "${meta.scope ?? store.target ?? ""}"`,
		`scope_strategy: ${meta.scope_strategy ?? "working-tree"}`,
		`in_scope_files_count: ${meta.in_scope_files_count ?? 0}`,
		`status: ${meta.status ?? "needs_changes"}`,
		`review_status: ${meta.review_status ?? "complete"}`,
		`merge_status: ${n("critical") + n("important") > 0 ? "blocked" : "clear"}`,
		`severity: { critical: ${n("critical")}, important: ${n("important")}, suggestion: ${n("suggestion")} }`,
		`verification: { verified: ${vn("Verified")}, weakened: ${vn("Weakened")}, falsified: ${vn("Falsified")} }`,
		`blockers_count: ${n("critical") + n("important")}`,
		"tags: [code-review]",
		"---",
	].join("\n");
	// Post-heading summary line — byte-shaped per deep-review/templates/review.md:22.
	const summaryLine = `**Commit:** \`${meta.commit ?? ""}\` · **Status:** \`${meta.status ?? "needs_changes"}\` · **Findings:** ${n("critical")}🔴 · ${n("important")}🟡 · ${n("suggestion")}🔵 · **Verification:** ${vn("Verified")}✓ / ${vn("Weakened")}− / ${vn("Falsified")}✗`;
	const blockers = active
		.filter((f) => f.severity === "critical" || f.severity === "important")
		.map((f, i) => `${i + 1}. **${f.id}** — ${f.title}`);
	const sections = [];
	for (const tier of DR_TIERS) {
		const inTier = active.filter((f) => f.severity === tier.sev);
		if (inTier.length) sections.push(`## ${tier.emoji} ${tier.section}`, "", inTier.map(renderDrFinding).join("\n\n---\n\n"));
	}
	const trailingSections = [
		store.drift ? `## Drift Delta\n\n${renderDrift(store)}` : "",
		...(meta.sections ?? []),
	].filter(Boolean);
	return [
		fm, "",
		`# Code Review — ${meta.scope ?? store.target ?? ""}`, "",
		summaryLine, "",
		"## Top Blockers", "", blockers.join("\n") || "_none_", "",
		DR_LEGEND, "",
		sections.join("\n\n"),
		trailingSections.join("\n\n"),
	].filter(Boolean).join("\n");
}

// ---- SARIF 2.1.0 export (Slice 2 — hand-built, zero deps) --------------------

const SARIF_SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

// severity (kind-dependent value set, Slice 1) → SARIF result.level.
const SARIF_LEVEL = {
	High: "error", Med: "warning", Low: "note",
	critical: "error", important: "warning", suggestion: "note", discuss: "note",
};
// Optional rank (0-100) — coarse viewer ordering within a level.
const SARIF_RANK = {
	High: 90, critical: 90, Med: 60, important: 60, Low: 30, suggestion: 30, discuss: 10,
};

/** One SARIF location per evidence entry: relative uri + region + snippet. */
function sarifLocations(finding) {
	return finding.evidence.map((ev) => ({
		physicalLocation: {
			artifactLocation: { uri: ev.path.replaceAll("\\", "/") },
			region: {
				startLine: ev.startLine,
				endLine: ev.endLine ?? ev.startLine,
				snippet: { text: ev.quoted.join("\n") },
			},
		},
	}));
}

/** Property bag — rpiv-specific fields SARIF has no first-class slot for. Only
 * present/non-null keys are emitted (a clean bag round-trips through viewers). */
function sarifProperties(finding) {
	const props = { lens: finding.lens, severity: finding.severity };
	if (finding.class != null) props.class = finding.class;
	if (finding.entityStage != null) props.entityStage = finding.entityStage;
	if (finding.crossCutTag != null) props.crossCutTag = finding.crossCutTag;
	// Regressed has no clean baselineState → drift class + prior identity ride the bag.
	if (finding.driftClass != null) props.rpivDriftClass = finding.driftClass;
	if (finding.priorFp != null) props.priorFingerprint = finding.priorFp;
	if (finding.priorId != null) props.priorId = finding.priorId;
	return props;
}

/** Triaged-away findings (rejected/withdrawn, or AR verify Falsified) are retired-
 * not-deleted → emit a SARIF suppression rather than dropping them (research:
 * Falsified ≈ SARIF suppressions). DR falsified-case mapping lands with Slice 8. */
function sarifSuppression(finding) {
	const off = finding.status === "rejected" || finding.status === "withdrawn" || finding.verify === "Falsified";
	return off ? [{ kind: "external", justification: finding.statusNote ?? finding.verifyNote ?? String(finding.verify ?? finding.status) }] : null;
}

/** Build a SARIF 2.1.0 log from a store, by hand (zero deps). Per-lens rules (one
 * reportingDescriptor per fired lens); class rides a result property, not a second
 * rule axis. baselineState reads finding.baselineState ?? "new" so export is
 * independent of the drift op (Slice 5) and auto-upgrades once drift persists. */
export function toSarif(store) {
	const findings = store.findings;
	const kind = findings.length > 0 && findings.every((f) => (f.kind ?? "ar") === "dr") ? "dr" : "ar";
	const lenses = [...new Set(findings.map((f) => f.lens))];
	const rules = lenses.map((lens) => ({ id: lens, name: lens, shortDescription: { text: `rpiv lens ${lens}` } }));
	const ruleIndex = new Map(lenses.map((lens, i) => [lens, i]));
	const results = findings.map((f) => {
		const result = {
			ruleId: f.lens,
			ruleIndex: ruleIndex.get(f.lens),
			level: SARIF_LEVEL[f.severity] ?? "warning",
			message: { text: f.title },
			locations: sarifLocations(f),
			partialFingerprints: { "rpivFingerprint/v1": f.fp },
			baselineState: f.baselineState ?? "new",
			properties: sarifProperties(f),
		};
		if (SARIF_RANK[f.severity] != null) result.rank = SARIF_RANK[f.severity];
		const supp = sarifSuppression(f);
		if (supp) result.suppressions = supp;
		return result;
	});
	return {
		$schema: SARIF_SCHEMA,
		version: "2.1.0",
		runs: [
			{
				tool: {
					driver: {
						name: kind === "dr" ? "rpiv-deep-review" : "rpiv-architectural-review",
						informationUri: "https://github.com/rpiv",
						rules,
					},
				},
				results,
			},
		],
	};
}

// ---- CLI ---------------------------------------------------------------------

// ═══ Slice 7: dispatch(argv, io) importable routing + shim ═══

const USAGE = [
	"usage: store.mjs init --artifact <review.md> [--root <dir>] < {target,layers:[{n,name}]}.json",
	"       store.mjs init --review --artifact <review.md> < {target,review:{...}}.json",
	"       store.mjs add --artifact <review.md> [--root <dir>] < finding.json",
	"       store.mjs add-many --artifact <review.md> [--root <dir>] < [finding, ...]",
	"       store.mjs update --artifact <review.md> [--root <dir>] < {id,verify?,verifyNote?,status?,statusNote?,<content fields>}.json",
	"           (content fields — title, anchor, what, why, evidence, remediation, severity, effort,",
	"            blastRadius, class, symbol, entityStage, crossCutTag, dependsOn, fix, alt — each",
	"            REPLACES the stored value and the record re-validates like add)",
	"       store.mjs diff --artifact <review.md> --prior <prior-review.json> [--root <dir>]",
	"       store.mjs query --clusters --artifact <review.md>",
	"       store.mjs query --plan --artifact <review.md>",
	"       store.mjs render --review --artifact <review.md>   (DR write-once)",
	"       store.mjs render --artifact <review.md> --layer <n> [--tally]",
	"       store.mjs finalize --artifact <review.md> --health-score <healthy|drifting|degraded> [--root <dir>]",
	"       store.mjs export --sarif --artifact <review.md> [--out <path>]",
].join("\n");

/** Arg/usage error: print usage, signal exit 2. */
function usageExit(ctx) {
	ctx.stderr.write(`${USAGE}\n`);
	return 2;
}

/** Trimmed stdin, or null after writing the command's empty-stdin message (caller returns 2). */
function stdinOrNull(ctx, emptyMsg) {
	const raw = ctx.readStdin().trim();
	if (raw) return raw;
	ctx.stderr.write(emptyMsg);
	return null;
}

function cmdInit(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const raw = stdinOrNull(ctx, "store init: empty stdin — pipe { target, layers:[{n,name}] } JSON\n");
	if (raw === null) return 2;
	if (ctx.rest.includes("--review")) {
		const { storePath } = initReviewStore(resolve(ctx.artifact), JSON.parse(raw));
		ctx.stdout.write(`initialized DR review ${storePath}\n`);
		return 0;
	}
	const { storePath, layers } = initStore(resolve(ctx.artifact), JSON.parse(raw));
	ctx.stdout.write(`initialized ${storePath} with layer(s) ${layers.join(", ")}\n`);
	return 0;
}

function cmdAddMany(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const raw = stdinOrNull(ctx, "store add-many: empty stdin — pipe a JSON array of findings\n");
	if (raw === null) return 2;
	const records = addFindings(resolve(ctx.artifact), ctx.root, JSON.parse(raw));
	ctx.stdout.write(`added ${records.length} finding(s) -> ${deriveStorePath(resolve(ctx.artifact))}\n`);
	return 0;
}

function cmdAdd(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const raw = stdinOrNull(ctx, "store add: empty stdin — pipe one finding JSON object\n");
	if (raw === null) return 2;
	const record = addFinding(resolve(ctx.artifact), ctx.root, JSON.parse(raw));
	ctx.stdout.write(`added ${record.id} (fp ${record.fp}) -> ${deriveStorePath(resolve(ctx.artifact))}\n`);
	return 0;
}

function cmdUpdate(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const raw = stdinOrNull(ctx, "store update: empty stdin — pipe { id, verify?, verifyNote?, status?, statusNote?, <content fields> } JSON\n");
	if (raw === null) return 2;
	const rec = updateFinding(resolve(ctx.artifact), ctx.root, JSON.parse(raw));
	ctx.stdout.write(`updated ${rec.id}: verify ${rec.verify}, severity ${rec.severity}, status ${rec.status}\n`);
	return 0;
}

function cmdQuery(ctx) {
	const wantClusters = ctx.rest.includes("--clusters");
	const wantPlan = ctx.rest.includes("--plan");
	if (!ctx.artifact || (!wantClusters && !wantPlan)) return usageExit(ctx);
	const { store } = loadStore(resolve(ctx.artifact));
	if (wantClusters) ctx.stdout.write(`${renderClusters(queryClusters(store))}\n`);
	if (wantPlan) ctx.stdout.write(renderPlan(queryPlan(store)));
	return 0;
}

function cmdDiff(ctx) {
	const prior = ctx.flag("--prior");
	if (!ctx.artifact || !prior) return usageExit(ctx);
	const d = diffReview(resolve(ctx.artifact), resolve(prior));
	ctx.stdout.write(`drift vs ${d.priorArtifact}: ${d.counts.new} new, ${d.counts.stillOpen} still-open, ${d.counts.regressed} regressed, ${d.counts.resolved} resolved\n`);
	return 0;
}

function cmdRenderReview(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const { store } = loadStore(resolve(ctx.artifact));
	writeFileSync(resolve(ctx.artifact), `${renderReview(store)}\n`);
	ctx.stdout.write(`rendered DR review (${store.findings.length} finding(s)) -> ${resolve(ctx.artifact)}\n`);
	return 0;
}

function cmdRenderLayer(ctx) {
	const layer = ctx.flag("--layer");
	if (!ctx.artifact || layer == null) return usageExit(ctx);
	const tallyOnly = ctx.rest.includes("--tally");
	const { store } = loadStore(resolve(ctx.artifact));
	renderInto(resolve(ctx.artifact), store, layer, tallyOnly ? { findings: false, tally: true } : { findings: true, tally: true });
	ctx.stdout.write(`rendered layer ${layer}${tallyOnly ? " (tally only)" : ""}\n`);
	return 0;
}

/** `render --review` (DR write-once) vs `render --layer <n> [--tally]`. */
function cmdRender(ctx) {
	return ctx.rest.includes("--review") ? cmdRenderReview(ctx) : cmdRenderLayer(ctx);
}

function cmdFinalize(ctx) {
	if (!ctx.artifact) return usageExit(ctx);
	const { hash, findings } = finalizeReview(resolve(ctx.artifact), ctx.root, ctx.flag("--health-score"));
	ctx.stdout.write(`finalized: ${findings} finding(s), health ${ctx.flag("--health-score")}, content_hash ${hash.slice(0, 12)}...\n`);
	return 0;
}

function cmdExport(ctx) {
	if (!ctx.artifact || !ctx.rest.includes("--sarif")) return usageExit(ctx);
	const { store } = loadStore(resolve(ctx.artifact));
	const sarif = `${JSON.stringify(toSarif(store), null, 2)}\n`;
	const out = ctx.flag("--out");
	if (!out) {
		ctx.stdout.write(sarif);
		return 0;
	}
	writeFileSync(resolve(out), sarif);
	ctx.stdout.write(`exported ${store.findings.length} finding(s) -> ${resolve(out)}\n`);
	return 0;
}

// Command table — dispatch is a lookup + a single try/catch (0 ok / 2 usage/arg / 1 thrown).
const COMMANDS = { init: cmdInit, add: cmdAdd, "add-many": cmdAddMany, update: cmdUpdate, query: cmdQuery, diff: cmdDiff, render: cmdRender, finalize: cmdFinalize, export: cmdExport };

/** Importable CLI routing — the isMain tail extracted so vitest attributes its mutants.
 *  Returns an exit code (0 ok / 2 usage/arg error / 1 thrown). `io` defaults read fd 0 and
 *  the process streams; tests pass fakes. */
export function dispatch(argv, { readStdin = () => readFileSync(0, "utf-8"), stdout = process.stdout, stderr = process.stderr } = {}) {
	const [cmd, ...rest] = argv;
	const flag = (name) => {
		const i = rest.indexOf(name);
		return i === -1 ? null : rest[i + 1];
	};
	const ctx = { rest, readStdin, stdout, stderr, flag, artifact: flag("--artifact"), root: resolve(flag("--root") ?? process.cwd()) };
	const handler = COMMANDS[cmd];
	if (!handler) return usageExit(ctx);
	try {
		return handler(ctx);
	} catch (e) {
		stderr.write(`store ${cmd}: ${e.message}\n`);
		return 1;
	}
}

if (isMain(import.meta.url)) process.exit(dispatch(process.argv.slice(2)));
