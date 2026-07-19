// check-citations.mjs — deterministic citation-path gate for review artifacts.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/check-citations.mjs" <artifact.md> [--root <dir>]
//
// A review artifact (architectural-review, deep-review) cites live code by `path:line`.
// A cite written as a BARE BASENAME (`service.ts:329`) is un-greppable when the repo has
// several files by that name — the review's downstream verify/drift tooling treats it as
// broken (this is the 86%-resolvable failure class). Prose rules in the skills + agents
// already forbid it and still leak it (condensing repeated paths in dense System-Model
// stage cells), so this is the deterministic backstop: it FAILS (exit 1) when any bare
// basename cite resolves to 2+ files in the repo, listing each so the skill can rewrite
// them repo-relative before flipping status: ready.
//
// Scope on purpose: only AMBIGUOUS bare basenames fail. A unique basename greps fine; a
// path with a `/` is already disambiguated; a new/nonexistent path (0 matches) is out of
// scope here (that is a hallucination check, graded elsewhere). Matching the grader's
// exact "ambiguous" definition keeps this safe to run on any review artifact.
//
// The `:line` suffix is OPTIONAL, exactly as in the grader's CITE_RE: a line-less
// mention (`service.ts` in a ripple-group cell or risk-rollup prose) is counted as a
// citation by the grader and is equally un-greppable when ambiguous — requiring the
// line here (as this gate originally did) let those sail through the Step-11 gate and
// then fail grading (the AR-1 88%-resolvable class: `types.ts`/`service.ts` mentions).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { basenameCounts, CITE_RE, EXEMPT_RE } from "./citation-grammar.mjs";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx !== -1 ? resolve(args[rootIdx + 1]) : process.cwd();
const paths = args.filter((a, i) => !a.startsWith("--") && i !== (rootIdx === -1 ? -1 : rootIdx + 1));
if (paths.length === 0) {
	console.error("usage: check-citations.mjs <artifact.md> [--root <dir>]");
	process.exit(2);
}

// ---- repo file index + grammar (single-sourced in citation-grammar.mjs) ----
const basenameCount = basenameCounts(root);

let failed = 0;
for (const artifactPath of paths) {
	if (!existsSync(artifactPath)) { console.error(`no such artifact: ${artifactPath}`); failed++; continue; }
	const text = readFileSync(artifactPath, "utf-8");
	const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const ambiguous = new Map(); // "service.ts:329" -> count
	for (const m of body.matchAll(CITE_RE)) {
		const tok = m[1];
		if (EXEMPT_RE.test(tok)) continue;
		if (tok.includes("/") || tok.includes("\\")) continue; // already path-qualified
		const n = basenameCount.get(tok) ?? 0;
		if (n >= 2) ambiguous.set(m[0], n);
	}
	if (ambiguous.size > 0) {
		failed++;
		console.error(`FAIL ${artifactPath}: ${ambiguous.size} ambiguous bare-basename citation(s) — rewrite each repo-relative from the repository root:`);
		for (const [cite, n] of [...ambiguous].slice(0, 30)) console.error(`  ${cite}  (${n} files named ${cite.split(":")[0]} in repo)`);
	}
}
if (failed) process.exit(1);
console.error("check-citations: OK — no ambiguous bare-basename citations");
