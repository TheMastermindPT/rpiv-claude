// grade-artifact.test.mjs — golden tests for the mechanical eval grader.
//
// Builds a throwaway mini-worktree (two source files) plus produced artifacts that
// deliberately mix good and bad rows, runs the grader as a subprocess (the same way the
// eval runner invokes it), and asserts each expectation's pass/fail lands exactly where
// it should. No dependencies; prints "OK" on success.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GRADER = join(dirname(fileURLToPath(import.meta.url)), "grade-artifact.mjs");
const tmp = mkdtempSync(join(tmpdir(), "grade-artifact-"));

function run(artifact, caseSpec) {
	const casePath = join(tmp, "case.json");
	const outPath = join(tmp, "grading.json");
	writeFileSync(casePath, JSON.stringify(caseSpec));
	try {
		execFileSync("node", [GRADER, "--artifact", artifact, "--repo", join(tmp, "repo"), "--case", casePath, "--out", outPath], { encoding: "utf-8" });
	} catch {
		/* non-zero exit on any FAIL is expected; grading.json is still written */
	}
	return JSON.parse(readFileSync(outPath, "utf-8"));
}
const byText = (g, frag) => g.expectations.find((e) => e.text.includes(frag)) ?? assert.fail(`no expectation matching "${frag}"`);

// ---------- mini worktree ----------
mkdirSync(join(tmp, "repo", "src", "deep"), { recursive: true });
writeFileSync(
	join(tmp, "repo", "src", "alpha.ts"),
	["export const CAP = 0.001;", "export function maxAllowed(prior: number, pct: number) {", "  return prior * (1 + pct / 100);", "}", "export const dead = 1;"].join("\n"),
);
writeFileSync(
	join(tmp, "repo", "src", "deep", "beta.ts"),
	["import { CAP } from \"../alpha\";", "export function validate(load: number, prior: number, pct: number) {", "  return load <= prior * (1 + pct / 100) + CAP;", "}"].join("\n"),
);
mkdirSync(join(tmp, "repo", ".github", "workflows"), { recursive: true });
writeFileSync(join(tmp, "repo", ".github", "workflows", "ci.yml"), ["name: ci", "on: push"].join("\n"));

// ---------- review-artifact case ----------
mkdirSync(join(tmp, "art", ".rpiv", "artifacts", "reviews"), { recursive: true });
const reviewArtifact = join(tmp, "art", ".rpiv", "artifacts", "reviews", "r.md");
writeFileSync(
	reviewArtifact,
	`---
date: 2026-07-08T03:00:00+0100
author: T
commit: abc
branch: main
repository: mini
status: in-progress
blockers: 0
slop_by_lens: { duplication: 2, dead_abstraction: 0 }
---
## Findings

| ID | What | Where | Severity |
|---|---|---|---|
| D1 | cap formula duplicated | \`src/alpha.ts:3\` and \`src/deep/beta.ts:3\` prior*(1+pct/100) both sides | High |
| X1 | hallucinated | \`src/ghost.ts:9\` | Low |
| X2 | line out of range | \`src/alpha.ts:99\` | Low |

- \`src/alpha.ts:3\` — \`return prior * (1 + pct / 100);\` (good quote)
- \`src/deep/beta.ts:2\` — \`export function TOTALLY_WRONG(\` (bad quote)
- \`.github/workflows/ci.yml:1\` — CI gate unaffected (dot-dir citation must resolve)
`,
);
const g1 = run(reviewArtifact, {
	id: "T-review",
	checks: {
		validate_artifact: true,
		citations: { min_resolvable_pct: 100, verbatim: true },
		recall: [
			{ id: "D1", files: [{ path: "src/alpha.ts", line: 3 }, { path: "src/deep/beta.ts", line: 3 }], min_files: 2, note: "dup formula" },
			{ id: "MISSED", files: [{ path: "src/deep/beta.ts", line: 1, radius: 0 }, { path: "src/never.ts" }], min_files: 2, note: "should miss" },
		],
		absence: [
			{ id: "fixed-dup", pair: ["src/alpha.ts", "src/deep/beta.ts"], pattern: "1 ?\\+ ?pct", note: "cap dup was fixed" },
			{ id: "other", pair: ["src/alpha.ts", "src/deep/beta.ts"], pattern: "zebra-migration", note: "pattern absent -> passes" },
		],
		frontmatter: { expect_nonzero_lenses: ["duplication", "dead_abstraction"], max: { blockers: 0 }, present: ["commit", "nope_field"] },
	},
});
assert.equal(byText(g1, "validate-artifact.mjs passes").passed, true, "in-progress artifact with CORE fields validates");
assert.equal(byText(g1, "status: ready").passed, false, "in-progress fixture must fail the finalization check");
assert.equal(byText(g1, "placeholders").passed, true, "fixture has no step placeholders");
assert.equal(byText(g1, "citation resolves").passed, false, "ghost.ts + line 99 must fail resolvability");
assert.match(byText(g1, "citation resolves").evidence, /ghost\.ts/);
assert.doesNotMatch(byText(g1, "citation resolves").evidence, /ci\.yml/, ".github/** paths resolve (dot-dir whitelist)");
assert.equal(byText(g1, "verbatim quote").passed, false, "one bad quote must fail");
assert.match(byText(g1, "verbatim quote").evidence, /1\/2|beta\.ts:2/);
assert.equal(byText(g1, "recall D1").passed, true, "both dup sites cited within window");
assert.equal(byText(g1, "recall MISSED").passed, false, "radius-0 + missing file cannot reach min_files=2");
assert.equal(byText(g1, "absence fixed-dup").passed, false, "the D1 row re-reports the fixed pair + pattern");
assert.equal(byText(g1, "absence other").passed, true, "pair cited but pattern absent -> no violation");
assert.equal(byText(g1, "slop_by_lens.duplication").passed, true);
assert.equal(byText(g1, "slop_by_lens.dead_abstraction").passed, false, "zero lens count must fail expect_nonzero");
assert.equal(byText(g1, "blockers <= 0").passed, true);
assert.equal(byText(g1, "field commit").passed, true);
assert.equal(byText(g1, "field nope_field").passed, false);

// ---------- agent-output: compounds ----------
const ixOut = join(tmp, "ix.md");
writeFileSync(
	ixOut,
	`## Interaction Sweep — src

### IX-1 — cap enforced twice
- **Kind:** distributed-invariant
- **Constituents:** D1, M2
- **Root cause:** the cap has no owning module
- **Evidence:**
  - \`src/alpha.ts:3\` — \`return prior * (1 + pct / 100);\`
  - \`src/deep/beta.ts:3\` — \`return load <= prior * (1 + pct / 100) + CAP;\`

### IX-2 — single-file, alien constituent
- **Kind:** masking
- **Constituents:** ZZ9
- **Root cause:** n/a
- **Evidence:**
  - \`src/alpha.ts:5\` — \`export const dead = 1;\`
`,
);
const g2 = run(ixOut, {
	id: "T-ix",
	checks: { compounds: { constituents_subset_of: ["D1", "M2", "A4"] } },
});
const comp = byText(g2, "IX compound");
assert.equal(comp.passed, false, "IX-2 has 1 file + alien constituent");
assert.match(comp.evidence, /IX-2/);
assert.doesNotMatch(comp.evidence, /IX-1:/, "IX-1 is clean");

// ---------- agent-output: exact no-interaction + forbidden vocab ----------
const noneOut = join(tmp, "none.md");
writeFileSync(noneOut, "## Interaction Sweep — src\n\nNo grounded cross-finding interaction. Findings are independent.\n");
const g3 = run(noneOut, { id: "T-none", checks: { expect_no_interaction: true, forbidden_vocab: "severity|🔴|remediation" } });
assert.equal(byText(g3, "no-interaction").passed, true);
assert.equal(byText(g3, "vocabulary").passed, true);

const g4 = run(ixOut, { id: "T-none-fail", checks: { expect_no_interaction: true } });
assert.equal(byText(g4, "no-interaction").passed, false, "IX blocks present -> must fail");

rmSync(tmp, { recursive: true, force: true });
console.log("OK");
