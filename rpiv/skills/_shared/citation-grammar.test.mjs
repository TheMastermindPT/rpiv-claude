// citation-grammar.test.mjs — unit tests for the single-sourced citation grammar
// shared by check-citations.mjs, grade-artifact.mjs, and store.mjs.
//
//   node skills/_shared/citation-grammar.test.mjs   (prints OK, or throws)

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { CITE_RE, EXEMPT_RE, citesIn, basenameCounts, isAmbiguous } from "./citation-grammar.mjs";

// 1. CITE_RE captures the range end; citesIn surfaces line-only, line-range, and
//    no-line cites distinctly.
{
	const out = citesIn("see lib/api/service.ts:10-20 and lib/api/util.ts:7 and docs/x.md");
	assert.deepEqual(out, [
		{ raw: "lib/api/service.ts:10-20", tok: "lib/api/service.ts", line: 10, end: 20 },
		{ raw: "lib/api/util.ts:7", tok: "lib/api/util.ts", line: 7, end: null },
		{ raw: "docs/x.md", tok: "docs/x.md", line: null, end: null },
	]);
	console.log("OK — CITE_RE captures range end; line-only/line-range/no-line surfaced distinctly.");
}

// 2. EXEMPT_RE is the reconciled union — provenance mentions of the plugin's own
//    helpers (including the two this feature introduces) and artifact self-paths
//    are never citations.
{
	assert.deepEqual(
		citesIn("via check-citations.mjs:12 + store.mjs + citation-grammar.mjs + .rpiv/artifacts/plans/x.md"),
		[],
	);
	assert.deepEqual(citesIn("service.mjs:4"), [
		{ raw: "service.mjs:4", tok: "service.mjs", line: 4, end: null },
	]);
	console.log("OK — EXEMPT_RE union: helper-provenance + self-paths exempt; a real .mjs cite still surfaces.");
}

// 3. basenameCounts + isAmbiguous implement the gate's exact ambiguity rule,
//    including the skip-dir and .github edges.
{
	const tmp = mkdtempSync(join(tmpdir(), "cite-grammar-"));
	try {
		mkdirSync(join(tmp, "a"), { recursive: true });
		mkdirSync(join(tmp, "b"), { recursive: true });
		mkdirSync(join(tmp, "x"), { recursive: true });
		mkdirSync(join(tmp, "node_modules"), { recursive: true });
		mkdirSync(join(tmp, ".github"), { recursive: true });
		writeFileSync(join(tmp, "a", "service.ts"), "export const a = 1;\n");
		writeFileSync(join(tmp, "b", "service.ts"), "export const b = 1;\n");
		writeFileSync(join(tmp, "only.ts"), "export const c = 1;\n");
		writeFileSync(join(tmp, "node_modules", "dup.ts"), "export const d = 1;\n");
		writeFileSync(join(tmp, "x", "dup.ts"), "export const e = 1;\n");
		writeFileSync(join(tmp, ".github", "ci.yml"), "name: ci\n");

		const counts = basenameCounts(tmp);
		assert.equal(counts.get("service.ts"), 2, "two service.ts across a/ and b/");
		assert.equal(counts.get("dup.ts"), 1, "node_modules/dup.ts skipped — only x/dup.ts counts");
		assert.equal(counts.get("ci.yml"), 1, ".github is walked (CI workflows are cited)");

		assert.equal(isAmbiguous("service.ts", counts), true, "bare basename resolving to 2 files is ambiguous");
		assert.equal(isAmbiguous("only.ts", counts), false, "unique bare basename is greppable");
		assert.equal(isAmbiguous("a/service.ts", counts), false, "forward-slash path is already disambiguated");
		assert.equal(isAmbiguous("a\\service.ts", counts), false, "backslash path is already disambiguated");
		assert.equal(isAmbiguous("ghost.ts", counts), false, "0 matches is out of scope (hallucination check elsewhere)");

		console.log("OK — basenameCounts + isAmbiguous: skip-dirs, .github edge, path-qualified + zero-match exclusions.");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// Sanity: the shared regexes are the exported objects the consumers import.
assert.ok(CITE_RE instanceof RegExp && CITE_RE.flags.includes("g"), "CITE_RE is a global regex");
assert.ok(EXEMPT_RE instanceof RegExp, "EXEMPT_RE is a regex");
void dirname;

console.log("OK");
