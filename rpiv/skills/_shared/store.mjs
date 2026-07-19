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

import { basenameCounts, isAmbiguous } from "./citation-grammar.mjs";
import { splitFrontmatter } from "./regen-decisions-index.mjs";
import { stampArtifact } from "./validate-artifact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FINGERPRINT = join(HERE, "..", "architectural-review", "_helpers", "fingerprint.mjs");

// ---- schema ------------------------------------------------------------------

// Live lens tags per SKILL.md Step 5d + IX + 10dim — includes Sec and P, which
// the template's Finding-shape lens row predates (trued up in Phase 6).
export const LENSES = ["D", "C", "G", "A", "T", "L", "Sec", "M", "S", "Lc", "Fe", "Fp", "Tc", "P", "IX", "10dim"];
export const ENUMS = {
	severity: ["Low", "Med", "High"],
	effort: ["S", "M", "L"],
	blastRadius: ["internal", "public-API", "on-disk", "cross-module"],
	class: ["polish", "redesign"],
	verify: ["Verified", "Weakened"],
	status: ["open", "accepted", "rejected", "deferred", "withdrawn"],
};
const REQUIRED_STRINGS = ["id", "title", "anchor", "what", "why"];
const OPTIONAL_NULLABLE = ["symbol", "entityStage", "crossCutTag", "statusNote"];
const KNOWN_KEYS = new Set([
	...REQUIRED_STRINGS,
	...OPTIONAL_NULLABLE,
	...Object.keys(ENUMS),
	"layer",
	"lens",
	"evidence",
	"remediation",
	"dependsOn",
	"fp",
]);

/** Validate one finding record against the schema + the shared ambiguity rule.
 * Returns [] when clean, else every error found (all-at-once, never first-only). */
export function validateFinding(f, counts, priorIds = new Set()) {
	const errors = [];
	if (typeof f !== "object" || f === null || Array.isArray(f)) return ["finding must be a JSON object"];
	for (const k of Object.keys(f)) if (!KNOWN_KEYS.has(k)) errors.push(`unknown field: ${k}`);
	for (const k of REQUIRED_STRINGS) {
		if (typeof f[k] !== "string" || !f[k].trim()) errors.push(`missing or empty field: ${k}`);
	}
	if (typeof f.id === "string" && priorIds.has(f.id)) {
		errors.push(`duplicate id: ${f.id} (IDs are append-only, never reused)`);
	}
	if (!/^\d+(\.\d+)?$/.test(String(f.layer ?? ""))) errors.push(`layer must be N or N.M (got: ${f.layer})`);
	if (!LENSES.includes(f.lens)) errors.push(`lens must be one of ${LENSES.join("/")} (got: ${f.lens})`);
	for (const [k, allowed] of Object.entries(ENUMS)) {
		if (!allowed.includes(f[k])) errors.push(`${k} must be one of ${allowed.join(" | ")} (got: ${f[k]})`);
	}
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
	for (const k of OPTIONAL_NULLABLE) {
		if (f[k] != null && typeof f[k] !== "string") errors.push(`${k} must be a string or null`);
	}
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

/** Load the store, lazy-initializing the envelope from the .md frontmatter on
 * first use (no `store init` op — Step 4's skeleton stays Edit-based). */
export function loadStore(artifactPath) {
	const storePath = deriveStorePath(artifactPath);
	if (existsSync(storePath)) return { storePath, store: JSON.parse(readFileSync(storePath, "utf-8")) };
	if (!existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
	const { fm } = splitFrontmatter(readFileSync(artifactPath, "utf-8"));
	return {
		storePath,
		store: {
			schema: 1,
			artifact: basename(artifactPath),
			target: fm.target ?? "",
			createdAt: new Date().toISOString(),
			findings: [],
		},
	};
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
		`- **Blast radius:** ${f.blastRadius}`,
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
	const record = { ...finding, fp: computeFingerprint(finding) };
	store.findings.push(record);
	const text = renderLayerText(readFileSync(artifactPath, "utf-8"), store, record.layer);
	saveStore(storePath, store);
	writeFileSync(artifactPath, text);
	return record;
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
		"usage: store.mjs add --artifact <review.md> [--root <dir>] < finding.json",
		"       store.mjs render --artifact <review.md> --layer <n> [--tally]",
		"       store.mjs finalize --artifact <review.md> --health-score <healthy|drifting|degraded> [--root <dir>]",
	].join("\n");
	const artifact = flag("--artifact");
	const root = resolve(flag("--root") ?? process.cwd());
	try {
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
		process.stderr.write(`${usage}\n`);
		process.exit(2);
	} catch (e) {
		process.stderr.write(`store ${cmd}: ${e.message}\n`);
		process.exit(1);
	}
}
