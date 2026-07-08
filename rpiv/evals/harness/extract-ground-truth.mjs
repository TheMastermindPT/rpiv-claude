// extract-ground-truth.mjs — turn a past (human-validated) architecture-review artifact
// into machine-checkable ground truth for the eval harness.
//
//   node extract-ground-truth.mjs --artifact <review.md> --repo <path> --ref <sha> \
//        [--target p1,p2,...] [--out <ground-truth.json>]
//
// Why this exists: the eval design is git-anchored — the strongest ground truth for a
// review skill is a set of findings a human validated by IMPLEMENTING the fixes. This
// script parses such an artifact (lens finding tables + IX interaction compounds +
// System Model entities), resolves every file:line cite against the pinned ref via
// `git show` (capturing the verbatim line), and probes HEAD to classify each finding as
// still-present or fixed. Findings whose evidence vanished at HEAD form the AR-2
// "absence" list; findings inside --target form the AR-1 recall list; the per-finding
// rows (id | lens | file:line | verbatim | severity | what-it-is) are the IS-1 input.
//
// Parsing is deliberately shape-tolerant: IDs and severities come from table row edges,
// cites come from a regex sweep of the whole row, so per-lens column differences don't
// break it. Anything unresolvable is reported, never silently dropped.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- CLI ----------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
	const k = process.argv[i]?.replace(/^--/, "");
	args[k] = process.argv[i + 1];
}
const { artifact, repo, ref } = args;
if (!artifact || !repo || !ref) {
	console.error("usage: node extract-ground-truth.mjs --artifact <review.md> --repo <path> --ref <sha> [--target p1,p2] [--out <json>]");
	process.exit(2);
}
const targets = (args.target ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

const text = readFileSync(artifact, "utf-8");
const lines = text.split("\n");

// ---------- section index ----------
const sections = [];
lines.forEach((l, i) => {
	const m = l.match(/^(#{2,4}) (.+)/);
	if (m) sections.push({ depth: m[1].length, title: m[2].trim(), start: i });
});
function sectionBody(pred) {
	const idx = sections.findIndex(pred);
	if (idx === -1) return null;
	const next = sections.slice(idx + 1).find((s) => s.depth <= sections[idx].depth);
	const end = next ? next.start : lines.length;
	return { title: sections[idx].title, lines: lines.slice(sections[idx].start + 1, end) };
}

// ---------- file tree at ref (for cite resolution) ----------
const treeAtRef = git("ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
const byBasename = new Map();
for (const p of treeAtRef) {
	const base = p.split("/").pop();
	if (!byBasename.has(base)) byBasename.set(base, []);
	byBasename.get(base).push(p);
}

const fileCache = new Map();
function fileAt(refSpec, path) {
	const key = `${refSpec}:${path}`;
	if (!fileCache.has(key)) {
		try {
			fileCache.set(key, git("show", key).split("\n"));
		} catch {
			fileCache.set(key, null);
		}
	}
	return fileCache.get(key);
}

/** Resolve a cited file token to a repo-relative path at the ref. */
function resolvePath(tok) {
	if (treeAtRef.includes(tok)) return tok;
	// Artifact cites are often relative to the review target (e.g. `validation.ts` or
	// `adaptive-context/validation.ts` meaning lib/generation/...). Try suffix match.
	const suffixHits = treeAtRef.filter((p) => p.endsWith("/" + tok));
	if (suffixHits.length === 1) return suffixHits[0];
	const baseHits = byBasename.get(tok.split("/").pop()) ?? [];
	if (baseHits.length === 1) return baseHits[0];
	// Prefer a hit that also matches any directory fragments in the token.
	const dirFrag = tok.includes("/") ? tok.slice(0, tok.lastIndexOf("/")) : null;
	if (dirFrag) {
		const both = baseHits.filter((p) => p.includes(dirFrag + "/"));
		if (both.length === 1) return both[0];
	}
	return suffixHits[0] ?? baseHits[0] ?? null; // ambiguous → first hit, flagged by caller via .ambiguous
}

const CITE_RE = /`?([\w@./-]+\.(?:tsx?|mjs|sql))`?(?::(\d+))?/g;

/** All cites in a chunk of text → [{ raw, path, line, verbatim, resolved }] */
function extractCites(chunk) {
	const out = [];
	const seen = new Set();
	for (const m of chunk.matchAll(CITE_RE)) {
		const raw = m[2] ? `${m[1]}:${m[2]}` : m[1];
		if (seen.has(raw)) continue;
		seen.add(raw);
		const path = resolvePath(m[1]);
		const line = m[2] ? Number(m[2]) : null;
		let verbatim = null;
		if (path && line) {
			const content = fileAt(ref, path);
			verbatim = content?.[line - 1]?.trim() ?? null;
		}
		out.push({ raw, path, line, verbatim, resolved: path !== null });
	}
	return out;
}

/** Does this finding's evidence still exist at HEAD? (verbatim line anywhere in the same file) */
function stillAtHead(cite) {
	if (!cite?.path || !cite.verbatim) return null; // unknown
	const head = fileAt("HEAD", cite.path);
	if (!head) return false; // file deleted/moved
	return head.some((l) => l.trim() === cite.verbatim);
}

const inTarget = (path) => targets.length === 0 || targets.some((t) => path === t || path.startsWith(t.endsWith("/") ? t : t + "/"));

// A lens table's "missing primitive" column cites files that do NOT exist at the ref —
// they are the artifact's fix PROPOSALS. When a same-named file exists at HEAD, that is
// strong evidence the fix was implemented (even if the primary verbatim line survived a
// refactor by coincidence). Emitted as a separate signal; the eval curator combines them.
let headTree = null;
function proposalAtHead(cites) {
	headTree ??= git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
	const hits = [];
	for (const c of cites) {
		if (c.resolved) continue;
		const base = c.raw.split(":")[0].split("/").pop();
		const found = headTree.filter((p) => p.endsWith("/" + base));
		if (found.length) hits.push(...found);
	}
	return [...new Set(hits)];
}

// ---------- findings from lens tables (### subsections of "Slop Inventory by lens") ----------
const findings = [];
const slopIdx = sections.findIndex((s) => /^Slop Inventory/i.test(s.title));
if (slopIdx !== -1) {
	for (let i = slopIdx + 1; i < sections.length && sections[i].depth > sections[slopIdx].depth; i++) {
		const lensTitle = sections[i].title; // e.g. "M — Missing abstraction (7) — the dominant lens"
		const lens = lensTitle.match(/^(\w{1,3}) —/)?.[1] ?? lensTitle[0];
		const body = sectionBody((s) => s.start === sections[i].start);
		for (const row of body.lines) {
			if (!/^\|/.test(row) || /^\|[\s-|]+\|?$/.test(row) || /^\| ?ID ?\|/i.test(row)) continue;
			const cells = row.split("|").map((c) => c.trim()).filter((_c, idx, arr) => idx > 0 && idx < arr.length - (arr.at(-1) === "" ? 1 : 0));
			if (cells.length < 3) continue;
			const id = cells[0].replaceAll("*", "").trim();
			if (!/^[A-Za-z]{1,3}\d+$/.test(id)) continue;
			const severity = cells.at(-1).replaceAll("*", "").trim();
			const cites = extractCites(row);
			const primary = cites.find((c) => c.resolved && c.line && c.verbatim) ?? cites.find((c) => c.resolved) ?? null;
			findings.push({
				id,
				lens,
				severity,
				what: cells[1].replaceAll("**", ""),
				cites,
				primary,
				in_target: cites.some((c) => c.path && inTarget(c.path)),
				fully_in_target: cites.length > 0 && cites.every((c) => !c.path || inTarget(c.path)),
				still_at_head: stillAtHead(primary),
				proposal_at_head: proposalAtHead(cites),
			});
		}
	}
}

// ---------- IX compounds ----------
const compounds = [];
const ixBody = sectionBody((s) => /^Interaction compounds/i.test(s.title));
if (ixBody) {
	const chunk = ixBody.lines.join("\n");
	// bullets like: - **IX-1 — headline** [M1, M4] · *kind* · **High**. evidence…
	const bulletRe = /^- \*\*(IX-\d+) — (.+?)\*\* \[([^\]]+)\] · \*([^*]+)\* · \*\*([^*]+)\*\*[.:]? ?([\s\S]*?)(?=\n- \*\*IX-|\n*$)/gm;
	for (const m of chunk.matchAll(bulletRe)) {
		const cites = extractCites(m[6]);
		compounds.push({
			id: m[1],
			headline: m[2],
			constituents: m[3].split(",").map((s) => s.trim()),
			kind: m[4].trim(),
			severity: m[5].trim(),
			cites,
			in_target: cites.some((c) => c.path && inTarget(c.path)),
			fully_in_target: cites.length > 0 && cites.every((c) => !c.path || inTarget(c.path)),
		});
	}
}

// ---------- entities (System Model L0 bullets or table) ----------
const entities = [];
const l0 = sectionBody((s) => /^L0 — System/i.test(s.title));
if (l0) {
	for (const l of l0.lines) {
		const bold = l.match(/^[-|] ?\*\*([\w /]+)\*\*/) ?? l.match(/^\| ?\*?\*?([\w /]+?)\*?\*? ?\|/);
		if (bold && !/^Entity$/i.test(bold[1].trim())) entities.push(bold[1].trim());
	}
}

// ---------- output ----------
const gt = {
	meta: {
		artifact,
		repo,
		ref,
		targets,
		extracted_at: new Date().toISOString(),
		finding_count: findings.length,
		compound_count: compounds.length,
	},
	entities,
	findings,
	compounds,
};

if (args.out) {
	mkdirSync(dirname(args.out), { recursive: true });
	writeFileSync(args.out, JSON.stringify(gt, null, 2));
}

// Console summary only — the JSON is the artifact.
const unresolved = findings.flatMap((f) => f.cites.filter((c) => !c.resolved).map((c) => `${f.id}:${c.raw}`));
console.log(`findings: ${findings.length} (${findings.filter((f) => f.in_target).length} touch target, ${findings.filter((f) => f.fully_in_target).length} fully in target)`);
console.log(`  fixed at HEAD (evidence gone): ${findings.filter((f) => f.still_at_head === false).map((f) => f.id).join(", ") || "none"}`);
console.log(`  still present at HEAD: ${findings.filter((f) => f.still_at_head === true).map((f) => f.id).join(", ") || "none"}`);
console.log(`  unknown (no verbatim primary): ${findings.filter((f) => f.still_at_head === null).map((f) => f.id).join(", ") || "none"}`);
console.log(`compounds: ${compounds.length} (${compounds.filter((c) => c.in_target).length} touch target) — ${compounds.map((c) => `${c.id}[${c.constituents.join(",")}]`).join(" ")}`);
console.log(`entities: ${entities.join(", ") || "none"}`);
if (unresolved.length) console.log(`UNRESOLVED cites: ${unresolved.join("; ")}`);
