// citation-grammar.mjs — single source for the citation grammar shared by the
// citation-path gate (check-citations.mjs), the eval grader (grade-artifact.mjs),
// and the findings store (store.mjs).
//
// The gate and the grader each carried a private copy of CITE_RE / EXEMPT_RE and
// they drifted twice (range-end capture; the `check-citations` exempt token).
// This module is the reconciled UNION: CITE_RE captures the range end (group 3 —
// consumers that ignore it are unaffected), EXEMPT_RE carries every exempt token
// either copy had, plus the store-era helpers (store, citation-grammar) that
// artifacts cite as tool provenance, not as code.
//
// Shadowing risk (documented, accepted for the pilot): a TARGET repo that has
// its own store.mjs would have bare-basename cites to it skipped by gate and
// grader alike — revisit token scoping (plugin-path-qualified exemption) when
// the grader field-assert migration lands.
//
// CITE_RE is /g — consume it via String.prototype.matchAll (never mutates
// lastIndex) or citesIn(); never bare .exec(), which would leak lastIndex state
// between consumers sharing this one regex object.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `path/to/file.ext:line-end` — group 1 token, group 2 line, group 3 range end. */
export const CITE_RE =
	/([\w@$()./\\-]+\.(?:tsx?|mjs|cjs|jsx?|sql|css|scss|json|ya?ml|toml|md))(?::(\d+)(?:-(\d+))?)?/g;

/** Tokens that are never codebase citations: artifact self-paths, URLs, glob and
 * template fragments, and the plugin's own helper scripts cited as tool provenance. */
export const EXEMPT_RE =
	/(^|\/)\.rpiv\/|^https?:|node_modules|\{|\}|^-|\*|^(metrics|semantic|mutation|coverage|fingerprint|warrant|now|review-range|validate-artifact|check-citations|git-context|store|citation-grammar)\.mjs$/;

/** Every non-exempt citation in a text chunk: { raw, tok, line, end }. */
export function citesIn(chunk) {
	const out = [];
	for (const m of chunk.matchAll(CITE_RE)) {
		if (EXEMPT_RE.test(m[1])) continue;
		out.push({ raw: m[0], tok: m[1], line: m[2] ? Number(m[2]) : null, end: m[3] ? Number(m[3]) : null });
	}
	return out;
}

// Dirs that are never citation targets — dependency/build/report output. Kept
// here (not in the consumers) so the gate's and the store's ambiguity walks can
// never diverge.
const SKIP = new Set(["node_modules", "coverage", "reports", "playwright-report", "dist", "build", "out", ".stryker-tmp"]);

/** Repo basename -> file count for the "ambiguous bare basename" rule. Skips
 * SKIP dirs and dot-dirs except .github (CI workflows are cited). */
export function basenameCounts(root) {
	const counts = new Map();
	(function walk(dir) {
		let entries;
		try { entries = readdirSync(dir); } catch { return; }
		for (const e of entries) {
			if ((e.startsWith(".") && e !== ".github") || SKIP.has(e)) continue;
			const p = join(dir, e);
			let st;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) walk(p);
			else counts.set(e, (counts.get(e) ?? 0) + 1);
		}
	})(root);
	return counts;
}

/** The gate's exact "ambiguous" definition: a bare basename (no path separator)
 * that resolves to >= 2 files is un-greppable — reject/flag it. */
export function isAmbiguous(tok, counts) {
	if (tok.includes("/") || tok.includes("\\")) return false;
	return (counts.get(tok) ?? 0) >= 2;
}
