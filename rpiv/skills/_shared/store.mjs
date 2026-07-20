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

import { basenameCounts, fileIndex, isAmbiguous, resolveInIndex } from "./citation-grammar.mjs";
import { splitFrontmatter } from "./regen-decisions-index.mjs";
import { stampArtifact, validateArtifact } from "./validate-artifact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FINGERPRINT = join(HERE, "..", "architectural-review", "_helpers", "fingerprint.mjs");

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

/** Validate one finding against the schema + the shared ambiguity rule. Shared
 * core (id/title/evidence/severity/status) applies to both kinds; the AR-extra
 * fields are gated on kind:"ar". severity's VALUE SET is kind-dependent. The
 * kind:"dr" arm's remaining specifics (DR lenses, per-tier field degradation,
 * emoji/verify mapping) land in Slice 8; until then a dr finding gets shared-core
 * validation only — inert because no dr finding is inserted before Slice 8.
 * Returns [] when clean, else every error found (all-at-once, never first-only). */
export function validateFinding(f, counts, priorIds = new Set()) {
	const errors = [];
	if (typeof f !== "object" || f === null || Array.isArray(f)) return ["finding must be a JSON object"];
	const kind = f.kind ?? "ar";
	if (!KINDS.includes(kind)) errors.push(`kind must be one of ${KINDS.join(" | ")} (got: ${f.kind})`);
	for (const k of Object.keys(f)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown field: ${k}`);
	for (const k of SHARED_REQUIRED_STRINGS) {
		if (typeof f[k] !== "string" || !f[k].trim()) errors.push(`missing or empty field: ${k}`);
	}
	if (typeof f.id === "string" && priorIds.has(f.id)) {
		errors.push(`duplicate id: ${f.id} (IDs are append-only, never reused)`);
	}
	for (const [k, allowed] of Object.entries(SHARED_ENUMS)) {
		if (!allowed.includes(f[k])) errors.push(`${k} must be one of ${allowed.join(" | ")} (got: ${f[k]})`);
	}
	// severity — shared core, kind-dependent value set; validated for BOTH kinds.
	if (KINDS.includes(kind)) {
		const allowedSev = SEVERITIES[kind];
		if (!allowedSev.includes(f.severity)) {
			errors.push(`severity must be one of ${allowedSev.join(" | ")} (got: ${f.severity})`);
		}
	}
	// evidence structure — shared (both kinds cite a location + verbatim lines).
	if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
		errors.push("evidence must be a non-empty array");
	} else {
		f.evidence.forEach((ev, i) => {
			if (typeof ev?.path !== "string" || !ev.path.trim()) {
				errors.push(`evidence[${i}].path missing`);
			} else if (isAmbiguous(ev.path, counts)) {
				errors.push(
					`evidence[${i}].path is an ambiguous bare basename: ${ev.path} (rewrite repo-relative from the repository root)`,
				);
			}
			if (!Number.isInteger(ev?.startLine) || ev.startLine < 1) {
				errors.push(`evidence[${i}].startLine must be a positive integer`);
			}
			if (ev?.endLine != null && (!Number.isInteger(ev.endLine) || ev.endLine < ev.startLine)) {
				errors.push(`evidence[${i}].endLine must be an integer >= startLine`);
			}
			if (!Array.isArray(ev?.quoted) || ev.quoted.length === 0 || ev.quoted.some((q) => typeof q !== "string" || !q.trim())) {
				errors.push(`evidence[${i}].quoted must be a non-empty array of verbatim lines`);
			}
		});
	}
	// AR-only fields — gated on kind:"ar".
	if (kind === "ar") {
		for (const k of AR_REQUIRED_STRINGS) {
			if (typeof f[k] !== "string" || !f[k].trim()) errors.push(`missing or empty field: ${k}`);
		}
		if (!/^\d+(\.\d+)?$/.test(String(f.layer ?? ""))) errors.push(`layer must be N or N.M (got: ${f.layer})`);
		if (!LENSES.includes(f.lens)) errors.push(`lens must be one of ${LENSES.join("/")} (got: ${f.lens})`);
		for (const [k, allowed] of Object.entries(AR_ENUMS)) {
			if (!allowed.includes(f[k])) errors.push(`${k} must be one of ${allowed.join(" | ")} (got: ${f[k]})`);
		}
		// blastRadius — OPEN, MULTI-VALUE: a non-empty array of non-empty strings.
		// Recommended vocabulary is BLAST_RADII (incl. "other"), but values are NOT
		// restricted to it (developer decision — blast can span multiple dimensions).
		if (!Array.isArray(f.blastRadius) || f.blastRadius.length === 0 || f.blastRadius.some((b) => typeof b !== "string" || !b.trim())) {
			errors.push("blastRadius must be a non-empty array of strings (recommended: internal | public-API | on-disk | cross-module | other; free-form allowed)");
		}
		const r = f.remediation;
		if (typeof r !== "object" || r === null || Array.isArray(r)) {
			errors.push("remediation must be an object");
		} else {
			for (const k of ["steps", "acceptance"]) {
				if (!Array.isArray(r[k]) || r[k].length === 0 || r[k].some((s) => typeof s !== "string" || !s.trim())) {
					errors.push(`remediation.${k} must be a non-empty string array`);
				}
			}
			for (const k of ["testStrategy", "tradeoff"]) {
				if (typeof r[k] !== "string" || !r[k].trim()) errors.push(`remediation.${k} missing`);
			}
		}
		if (!Array.isArray(f.dependsOn) || f.dependsOn.some((d) => typeof d !== "string")) {
			errors.push("dependsOn must be a string array (may be empty)");
		}
	} else if (kind === "dr") {
		// DR validation arm (Slice 8). Shared severity already validated f.severity ∈
		// SEVERITIES.dr; evidence + quoted are shared-required (every DR finding is
		// fingerprintable — per-tier degradation is a RENDER concern, not storage).
		if (!DR_LENSES.includes(f.lens)) errors.push(`lens must be one of ${DR_LENSES.join("/")} for kind:dr (got: ${f.lens})`);
		const sev = f.severity;
		if ((sev === "critical" || sev === "important" || sev === "discuss") && (typeof f.why !== "string" || !f.why.trim())) errors.push(`kind:dr ${sev} finding requires a why`);
		if ((sev === "critical" || sev === "important" || sev === "suggestion") && (typeof f.fix !== "string" || !f.fix.trim())) errors.push(`kind:dr ${sev} finding requires a fix`);
		if (f.alt != null && (typeof f.alt !== "string" || !f.alt.trim())) errors.push("alt must be a non-empty string or null (kind:dr)");
		if (f.verify != null && !AR_ENUMS.verify.includes(f.verify)) errors.push(`verify must be one of ${AR_ENUMS.verify.join(" | ")} (got: ${f.verify})`);
	}
	// drift fields — optional, validated when present (either kind).
	if (f.baselineState != null && !BASELINE_STATES.includes(f.baselineState)) {
		errors.push(`baselineState must be one of ${BASELINE_STATES.join(" | ")} (got: ${f.baselineState})`);
	}
	if (f.driftClass != null && !DRIFT_CLASSES.includes(f.driftClass)) {
		errors.push(`driftClass must be one of ${DRIFT_CLASSES.join(" | ")} (got: ${f.driftClass})`);
	}
	for (const k of ["priorFp", "priorId", "verifyNote"]) {
		if (f[k] != null && (typeof f[k] !== "string" || !f[k].trim())) errors.push(`${k} must be a non-empty string or null`);
	}
	for (const k of OPTIONAL_NULLABLE) {
		if (f[k] != null && typeof f[k] !== "string") errors.push(`${k} must be a string or null`);
	}
	return errors;
}

// ---- evidence grounding (against the real repo at --root) --------------------

const normWs = (s) => s.replace(/\s+/g, " ").trim();

/** Ground every evidence entry against the repo: the path resolves to a real file,
 * startLine is within it, and each quoted line greps at path:startLine (±3,
 * whitespace-normalized — the grader's verbatim rule, enforced upstream at insert).
 * Returns [] when clean, else every grounding error found. */
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
		const normLines = lines.map(normWs);
		const window = normLines.slice(Math.max(0, ev.startLine - 4), ev.startLine + 3);
		for (const q of ev.quoted) {
			const want = normWs(q).replace(/\s*(\.\.\.|…)$/, "");
			if (!window.some((w) => w.includes(want) || (want.includes(w) && w.length > 5))) {
				// Actionable: if the quote IS in the file, name the real line(s) so the
				// caller fixes startLine (or splits the evidence) instead of guessing.
				const at = [];
				if (want) normLines.forEach((w, idx) => { if (w.includes(want)) at.push(idx + 1); });
				const hint = at.length ? ` (found at line${at.length > 1 ? "s" : ""} ${at.slice(0, 5).join(", ")})` : "";
				errors.push(`evidence[${i}].quoted not found at ${rel}:${ev.startLine} (±3)${hint}: "${q.slice(0, 50)}"`);
			}
		}
	});
	return errors;
}

// ---- fingerprint (subprocess — never absorbed) -------------------------------

/** Content-hash fingerprint via fingerprint.mjs, honoring the drift-fingerprints
 * 8a assertions: exactly one stdout line per input line, and fp:null is an
 * insert rejection (invalid evidence), surfaced with the helper's own error. */
export function computeFingerprint(finding) {
	const quoted = finding.evidence.flatMap((ev) => ev.quoted);
	const input = JSON.stringify({ id: finding.id, lens: finding.lens, quoted, symbol: finding.symbol ?? null });
	const res = spawnSync("node", [FINGERPRINT], { input: `${input}\n`, encoding: "utf-8" });
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

/** Explicit init: build the review.json envelope AND emit the per-layer skeleton
 * sections into the .md's store:layers region (replaces the Edit-based Step-4
 * skeleton). Refuses to clobber an existing store. Reads spec { target, layers:
 * [{ n, name }] }. */
export function initStore(artifactPath, spec) {
	const storePath = deriveStorePath(artifactPath);
	if (existsSync(storePath)) throw new Error(`store already initialized: ${storePath} (delete it to re-init)`);
	if (!existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
	if (!spec || typeof spec.target !== "string" || !spec.target.trim()) throw new Error("init: spec.target (non-empty string) is required");
	if (!Array.isArray(spec.layers) || spec.layers.length === 0) throw new Error("init: spec.layers must be a non-empty array");
	const layers = spec.layers.map((l) => {
		if (!/^\d+(\.\d+)?$/.test(String(l?.n ?? ""))) throw new Error(`init: layer.n must be N or N.M (got: ${l?.n})`);
		return { n: String(l.n), name: typeof l.name === "string" ? l.name.trim() : "" };
	});
	const sections = layers.map(renderLayerSection).join("\n\n---\n\n");
	const text = spliceRegion(readFileSync(artifactPath, "utf-8"), LAYERS_REGION, sections);
	const store = {
		schema: 1,
		artifact: basename(artifactPath),
		target: spec.target.trim(),
		createdAt: new Date().toISOString(),
		layers,
		findings: [],
	};
	saveStore(storePath, store);
	writeFileSync(artifactPath, text);
	return { storePath, layers: layers.map((l) => l.n) };
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

/** Idempotent sentinel splice: replace the region between begin/end. Sentinels
 * ABSENT is an error — the skeleton owns marker placement; the store never
 * guesses an insertion point (regen-decisions-index applyBlock precedent,
 * hardened: that one appends when absent, this one refuses). */
export function spliceRegion(text, { begin, end }, content) {
	const bi = text.indexOf(begin);
	const ei = text.indexOf(end);
	if (bi === -1 || ei === -1 || ei < bi) {
		throw new Error(`sentinel pair not found in artifact: ${begin}`);
	}
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

/** Step-11 ready flip: gates (every finding triaged; health verdict is a real
 * enum value, never `pending`; no evidence citation went ambiguous since insert;
 * not already finalized), then health_score + status flip in the .md, mirrored
 * envelope fields in review.json, and the content_hash stamp LAST — the same
 * "last body-affecting action" invariant research/design/blueprint artifacts
 * already carry (stampArtifact appends content_hash as the final fm field). */
export function finalizeReview(artifactPath, root, healthScore) {
	if (!HEALTH.includes(healthScore)) {
		throw new Error(`--health-score must be one of ${HEALTH.join(" | ")} (got: ${healthScore ?? "none"})`);
	}
	const { storePath, store } = loadStore(artifactPath);
	const open = store.findings.filter((f) => f.status === "open").map((f) => f.id);
	if (open.length > 0) throw new Error(`untriaged findings remain: ${open.join(", ")}`);
	const counts = basenameCounts(root);
	const ambiguous = [];
	for (const f of store.findings) {
		for (const ev of f.evidence) if (isAmbiguous(ev.path, counts)) ambiguous.push(`${f.id}: ${ev.path}`);
	}
	if (ambiguous.length > 0) {
		throw new Error(`evidence went ambiguous since insert (repo gained same-named files): ${ambiguous.join("; ")}`);
	}
	// Body-prose gate: the store's finalize now runs the same prose scan the .md lint
	// does (unfilled {tokens}, TODO/TBD/FIXME, empty fences) so a token-dirty body
	// cannot flip to ready. verifyHash:false — content_hash is stamped later, below.
	const lint = validateArtifact(artifactPath, root, { finalizing: true, verifyHash: false });
	if (lint.errors.length > 0) {
		throw new Error(`body fails the finalization lint (resolve before finalizing):\n${lint.errors.map((e) => `  ${e}`).join("\n")}`);
	}
	let text = readFileSync(artifactPath, "utf-8");
	const { fm } = splitFrontmatter(text);
	if (fm.status === "ready") throw new Error("artifact already ready — re-stamp via validate-artifact.mjs --stamp");
	text = setFrontmatterField(text, "health_score", healthScore);
	text = setFrontmatterField(text, "status", "ready");
	// Hybrid-state write order: .md flip, envelope mirror, stamp. A crash between
	// writes leaves a detectable half-state (validate-artifact flags a ready
	// artifact without a matching stamp only after content_hash exists — the
	// pilot accepts this window; the store is still the findings authority).
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
export function addFinding(artifactPath, root, finding) {
	const { storePath, store } = loadStore(artifactPath);
	const counts = basenameCounts(root);
	const errors = validateFinding(finding, counts, new Set(store.findings.map((x) => x.id)));
	if (errors.length > 0) throw new Error(errors.map((e) => `invalid finding: ${e}`).join("\n"));
	const grounding = checkEvidenceGrounding(finding, root);
	if (grounding.length > 0) throw new Error(grounding.map((e) => `invalid finding: ${e}`).join("\n"));
	const record = { ...finding, fp: computeFingerprint(finding) };
	store.findings.push(record);
	// AR renders into its layer sentinels; DR skips the per-add render (the whole .md is
	// written write-once by renderReview via `store render --review`).
	if ((record.kind ?? "ar") === "ar") {
		const text = renderLayerText(readFileSync(artifactPath, "utf-8"), store, record.layer);
		saveStore(storePath, store);
		writeFileSync(artifactPath, text);
	} else {
		saveStore(storePath, store);
	}
	return record;
}

// ---- update (Slice 4 — verify transitions) ----------------------------------

// Weakened demotes one severity tier toward the less-severe end, per kind (explicit
// map — independent of SEVERITIES array order, which differs by kind). Floor stays.
const DEMOTE = {
	ar: { High: "Med", Med: "Low", Low: "Low" },
	dr: { critical: "important", important: "suggestion", suggestion: "discuss", discuss: "discuss" },
};

/** Apply a verify verdict to an existing stored finding, in place, then re-render its
 * layer. Verified: stands. Weakened: demote one severity tier (requires a verifyNote —
 * "narrower than first stated"). Falsified: retire-not-delete — the record STAYS
 * (append-only) but status flips to "withdrawn" (requires a verifyNote). An explicit
 * status/statusNote in the patch overrides. Returns the updated record. */
export function updateFinding(artifactPath, root, patch) {
	if (!patch || typeof patch.id !== "string" || !patch.id.trim()) throw new Error("update: patch.id (string) is required");
	if (!["Verified", "Weakened", "Falsified"].includes(patch.verify)) {
		throw new Error(`update: verify must be one of Verified | Weakened | Falsified (got: ${patch.verify})`);
	}
	const { storePath, store } = loadStore(artifactPath);
	const f = store.findings.find((x) => x.id === patch.id);
	if (!f) throw new Error(`update: no finding with id ${patch.id}`);
	const kind = f.kind ?? "ar";
	f.verify = patch.verify;
	if (patch.verify === "Weakened") {
		if (typeof patch.verifyNote !== "string" || !patch.verifyNote.trim()) {
			throw new Error("update: Weakened requires a verifyNote (why it is narrower than first stated)");
		}
		f.verifyNote = patch.verifyNote.trim();
		const demoted = (DEMOTE[kind] ?? DEMOTE.ar)[f.severity] ?? f.severity;
		// DR tiers require different fields (discuss needs `why`, suggestion needs `fix`);
		// demoting across that boundary would fail the re-validate below with a message the
		// patch can't satisfy. Guard with a clear error instead. [plan-local guard; design
		// follow-up: DEMOTE.dr × DR-arm tier-field interaction]
		if (kind === "dr" && demoted !== f.severity) {
			const needsWhy = demoted === "critical" || demoted === "important" || demoted === "discuss";
			const needsFix = demoted === "critical" || demoted === "important" || demoted === "suggestion";
			if (needsWhy && (typeof f.why !== "string" || !f.why.trim())) throw new Error(`update: cannot Weaken ${f.id} to ${demoted} — that tier requires a \`why\` this finding lacks`);
			if (needsFix && (typeof f.fix !== "string" || !f.fix.trim())) throw new Error(`update: cannot Weaken ${f.id} to ${demoted} — that tier requires a \`fix\` this finding lacks`);
		}
		f.severity = demoted;
	} else if (patch.verify === "Falsified") {
		if (typeof patch.verifyNote !== "string" || !patch.verifyNote.trim()) {
			throw new Error("update: Falsified requires a verifyNote (why the claim does not hold)");
		}
		f.verifyNote = patch.verifyNote.trim();
		f.status = "withdrawn"; // retire-not-delete — the record stays (append-only)
	}
	if (typeof patch.status === "string") f.status = patch.status;
	if (typeof patch.statusNote === "string") f.statusNote = patch.statusNote.trim();
	// Re-validate the mutated record (the demoted severity must stay a valid tier, etc.).
	const errors = validateFinding(f, basenameCounts(root), new Set());
	if (errors.length > 0) throw new Error(errors.map((e) => `invalid finding after update: ${e}`).join("\n"));
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
	const priorByFp = new Map((prior.findings ?? []).map((f) => [f.fp, f]));
	const priorResolved = new Map((prior.drift?.resolved ?? []).map((r) => [r.fp, r]));
	const currentFps = new Set(store.findings.map((f) => f.fp));
	for (const f of store.findings) {
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
	const resolved = (prior.findings ?? [])
		.filter((p) => !currentFps.has(p.fp))
		.map((p) => ({ id: p.id, title: p.title, fp: p.fp }));
	store.drift = {
		priorArtifact: prior.artifact ?? basename(priorPath),
		comparedAt: new Date().toISOString(),
		resolved,
		counts: {
			new: store.findings.filter((f) => f.driftClass === "NEW").length,
			stillOpen: store.findings.filter((f) => f.driftClass === "Still-open").length,
			regressed: store.findings.filter((f) => f.driftClass === "Regressed").length,
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
	text = spliceRegion(text, DRIFT_REGION, renderDrift(store));
	writeFileSync(artifactPath, text);
	return store.drift;
}

// ---- query --clusters (Slice 6 — read-only cluster discovery) ---------------

/** Discover clusters over the persisted finding set (Step 9.5 steps 1-3): group
 * accepted/deferred findings by a shared store-intrinsic key — file, exported symbol,
 * or System-Model Entity/stage — plus each Depends-on edge as a 2-member cluster,
 * keeping only groups of >= 2 DISTINCT findings. Each cluster is flagged `anticipated`
 * when every member already shares one cross-cut tag (the "subtract known themes"
 * step). READ-ONLY — never mutates the store. */
export function queryClusters(store) {
	const active = store.findings.filter((f) => f.status === "accepted" || f.status === "deferred");
	const byId = new Map(active.map((f) => [f.id, f]));
	const clusters = [];
	const anticipatedOf = (ids) => {
		const tags = ids.map((id) => byId.get(id)?.crossCutTag).filter(Boolean);
		return tags.length === ids.length && new Set(tags).size === 1;
	};
	const group = (dimension, keysOf) => {
		const map = new Map();
		for (const f of active) {
			for (const k of keysOf(f)) {
				if (!k) continue;
				if (!map.has(k)) map.set(k, []);
				map.get(k).push(f.id);
			}
		}
		for (const [key, ids] of map) {
			if (ids.length >= 2) clusters.push({ dimension, key, ids, anticipated: anticipatedOf(ids) });
		}
	};
	group("file", (f) => f.evidence.map((ev) => ev.path));
	group("symbol", (f) => [f.symbol]);
	group("entity", (f) => [f.entityStage]);
	// (c) a Depends-on edge links two findings into a 2-member cluster. Edges are
	// canonicalized to an UNORDERED pair (a mutual A<->B is one cluster, not two) and
	// self-references are skipped (a cluster needs >= 2 DISTINCT findings). Direction
	// is preserved in each finding's own dependsOn field for the Step-11 topo-sort.
	const seen = new Set();
	for (const f of active) {
		if (!Array.isArray(f.dependsOn)) continue;
		for (const d of f.dependsOn) {
			if (d === f.id || !byId.has(d)) continue;
			const ids = [f.id, d].sort();
			const key = ids.join(" <-> ");
			if (seen.has(key)) continue;
			seen.add(key);
			clusters.push({ dimension: "dependsOn", key, ids, anticipated: anticipatedOf(ids) });
		}
	}
	return { clusters, discovered: clusters.length, unanticipated: clusters.filter((c) => !c.anticipated).length };
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

/** One DR finding block, degrade-per-tier (deep-review/templates/review.md:42-105):
 *   critical: Where + Code + Why + Fix + Alt?   important: Where + Code + Why + Fix
 *   suggestion: Where + Fix                      discuss: Where + Why
 * Code/Why/Fix persist for all tiers (fingerprint/validation) but only DISPLAY per tier. */
export function renderDrFinding(f) {
	const tier = DR_TIERS.find((t) => t.sev === f.severity) ?? DR_TIERS[2];
	const where = f.evidence.map((ev) => `\`${ev.path}:${ev.endLine != null ? `${ev.startLine}-${ev.endLine}` : ev.startLine}\``).join(" ");
	const lines = [`### ${f.id} ${tier.emoji} ${f.title}`, "", "**Where**", where];
	const sev = f.severity;
	if (sev === "critical" || sev === "important") lines.push("", "**Code**", "```", f.evidence.flatMap((ev) => ev.quoted).join("\n"), "```");
	if (sev === "critical" || sev === "important" || sev === "discuss") lines.push("", "**Why**", f.why);
	if (sev === "critical" || sev === "important" || sev === "suggestion") lines.push("", "**Fix**", f.fix);
	if (sev === "critical" && f.alt) lines.push("", "**Alt**", f.alt);
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
	return [
		fm, "",
		`# Code Review — ${meta.scope ?? store.target ?? ""}`, "",
		summaryLine, "",
		"## Top Blockers", "", blockers.join("\n") || "_none_", "",
		DR_LEGEND, "",
		sections.join("\n\n"),
		(meta.sections ?? []).join("\n\n"),
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

const isMain = (() => {
	try {
		return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
	} catch {
		return false;
	}
})();
if (isMain) {
	const [cmd, ...rest] = process.argv.slice(2);
	const flag = (name) => {
		const i = rest.indexOf(name);
		return i === -1 ? null : rest[i + 1];
	};
	const usage = [
		"usage: store.mjs init --artifact <review.md> [--root <dir>] < {target,layers:[{n,name}]}.json",
		"       store.mjs add --artifact <review.md> [--root <dir>] < finding.json",
		"       store.mjs update --artifact <review.md> [--root <dir>] < {id,verify,verifyNote?,status?,statusNote?}.json",
		"       store.mjs diff --artifact <review.md> --prior <prior-review.json> [--root <dir>]",
		"       store.mjs query --clusters --artifact <review.md>",
		"       store.mjs render --review --artifact <review.md>   (DR write-once)",
		"       store.mjs render --artifact <review.md> --layer <n> [--tally]",
		"       store.mjs finalize --artifact <review.md> --health-score <healthy|drifting|degraded> [--root <dir>]",
		"       store.mjs export --sarif --artifact <review.md> [--out <path>]",
	].join("\n");
	const artifact = flag("--artifact");
	const root = resolve(flag("--root") ?? process.cwd());
	try {
		if (cmd === "init") {
			if (!artifact) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const raw = readFileSync(0, "utf-8").trim();
			if (!raw) {
				process.stderr.write("store init: empty stdin — pipe { target, layers:[{n,name}] } JSON\n");
				process.exit(2);
			}
			const { storePath, layers } = initStore(resolve(artifact), JSON.parse(raw));
			process.stdout.write(`initialized ${storePath} with layer(s) ${layers.join(", ")}\n`);
			process.exit(0);
		}
		if (cmd === "add") {
			if (!artifact) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const raw = readFileSync(0, "utf-8").trim();
			if (!raw) {
				process.stderr.write("store add: empty stdin — pipe one finding JSON object\n");
				process.exit(2);
			}
			const record = addFinding(resolve(artifact), root, JSON.parse(raw));
			process.stdout.write(`added ${record.id} (fp ${record.fp}) -> ${deriveStorePath(resolve(artifact))}\n`);
			process.exit(0);
		}
		if (cmd === "update") {
			if (!artifact) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const raw = readFileSync(0, "utf-8").trim();
			if (!raw) {
				process.stderr.write("store update: empty stdin — pipe { id, verify, verifyNote?, status?, statusNote? } JSON\n");
				process.exit(2);
			}
			const rec = updateFinding(resolve(artifact), root, JSON.parse(raw));
			process.stdout.write(`updated ${rec.id}: verify ${rec.verify}, severity ${rec.severity}, status ${rec.status}\n`);
			process.exit(0);
		}
		if (cmd === "query") {
			if (!artifact || !rest.includes("--clusters")) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const { store } = loadStore(resolve(artifact));
			process.stdout.write(`${renderClusters(queryClusters(store))}\n`);
			process.exit(0);
		}
		if (cmd === "diff") {
			const prior = flag("--prior");
			if (!artifact || !prior) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const d = diffReview(resolve(artifact), resolve(prior));
			process.stdout.write(`drift vs ${d.priorArtifact}: ${d.counts.new} new, ${d.counts.stillOpen} still-open, ${d.counts.regressed} regressed, ${d.counts.resolved} resolved\n`);
			process.exit(0);
		}
		if (cmd === "render" && rest.includes("--review")) {
			if (!artifact) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const { store } = loadStore(resolve(artifact));
			writeFileSync(resolve(artifact), `${renderReview(store)}\n`);
			process.stdout.write(`rendered DR review (${store.findings.length} finding(s)) -> ${resolve(artifact)}\n`);
			process.exit(0);
		}
		if (cmd === "render") {
			const layer = flag("--layer");
			if (!artifact || layer == null) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const tallyOnly = rest.includes("--tally");
			const { store } = loadStore(resolve(artifact));
			renderInto(resolve(artifact), store, layer, tallyOnly ? { findings: false, tally: true } : { findings: true, tally: true });
			process.stdout.write(`rendered layer ${layer}${tallyOnly ? " (tally only)" : ""}\n`);
			process.exit(0);
		}
		if (cmd === "finalize") {
			if (!artifact) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const { hash, findings } = finalizeReview(resolve(artifact), root, flag("--health-score"));
			process.stdout.write(`finalized: ${findings} finding(s), health ${flag("--health-score")}, content_hash ${hash.slice(0, 12)}...\n`);
			process.exit(0);
		}
		if (cmd === "export") {
			if (!artifact || !rest.includes("--sarif")) {
				process.stderr.write(`${usage}\n`);
				process.exit(2);
			}
			const { store } = loadStore(resolve(artifact));
			const sarif = `${JSON.stringify(toSarif(store), null, 2)}\n`;
			const out = flag("--out");
			if (out) {
				writeFileSync(resolve(out), sarif);
				process.stdout.write(`exported ${store.findings.length} finding(s) -> ${resolve(out)}\n`);
			} else {
				process.stdout.write(sarif);
			}
			process.exit(0);
		}
		process.stderr.write(`${usage}\n`);
		process.exit(2);
	} catch (e) {
		process.stderr.write(`store ${cmd}: ${e.message}\n`);
		process.exit(1);
	}
}
