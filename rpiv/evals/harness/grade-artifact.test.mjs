// grade-artifact.test.mjs — golden tests for the mechanical eval grader.
//
// Builds a throwaway mini-worktree (two source files) plus produced artifacts that
// deliberately mix good and bad rows, runs the grader as a subprocess (the same way the
// eval runner invokes it), and asserts each expectation's pass/fail lands exactly where
// it should. No dependencies; prints "OK" on success.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderFinding, renderTally } from "../../skills/_shared/store.mjs";

const GRADER = join(
	dirname(fileURLToPath(import.meta.url)),
	"grade-artifact.mjs",
);
const tmp = mkdtempSync(join(tmpdir(), "grade-artifact-"));

function run(artifact, caseSpec) {
	const casePath = join(tmp, "case.json");
	const outPath = join(tmp, "grading.json");
	writeFileSync(casePath, JSON.stringify(caseSpec));
	try {
		execFileSync(
			"node",
			[
				GRADER,
				"--artifact",
				artifact,
				"--repo",
				join(tmp, "repo"),
				"--case",
				casePath,
				"--out",
				outPath,
			],
			{ encoding: "utf-8" },
		);
	} catch {
		/* non-zero exit on any FAIL is expected; grading.json is still written */
	}
	return JSON.parse(readFileSync(outPath, "utf-8"));
}
const byText = (g, frag) =>
	g.expectations.find((e) => e.text.includes(frag)) ??
	assert.fail(`no expectation matching "${frag}"`);

// ---------- mini worktree ----------
mkdirSync(join(tmp, "repo", "src", "deep"), { recursive: true });
writeFileSync(
	join(tmp, "repo", "src", "alpha.ts"),
	[
		"export const CAP = 0.001;",
		"export function maxAllowed(prior: number, pct: number) {",
		"  return prior * (1 + pct / 100);",
		"}",
		"export const dead = 1;",
	].join("\n"),
);
writeFileSync(
	join(tmp, "repo", "src", "deep", "beta.ts"),
	[
		'import { CAP } from "../alpha";',
		"export function validate(load: number, prior: number, pct: number) {",
		"  return load <= prior * (1 + pct / 100) + CAP;",
		"}",
	].join("\n"),
);
mkdirSync(join(tmp, "repo", ".github", "workflows"), { recursive: true });
writeFileSync(
	join(tmp, "repo", ".github", "workflows", "ci.yml"),
	["name: ci", "on: push"].join("\n"),
);

// ---------- review-artifact case ----------
mkdirSync(join(tmp, "art", ".rpiv", "artifacts", "reviews"), {
	recursive: true,
});
const reviewArtifact = join(
	tmp,
	"art",
	".rpiv",
	"artifacts",
	"reviews",
	"r.md",
);
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
			{
				id: "D1",
				files: [
					{ path: "src/alpha.ts", line: 3 },
					{ path: "src/deep/beta.ts", line: 3 },
				],
				min_files: 2,
				note: "dup formula",
			},
			{
				id: "MISSED",
				files: [
					{ path: "src/deep/beta.ts", line: 1, radius: 0 },
					{ path: "src/never.ts" },
				],
				min_files: 2,
				note: "should miss",
			},
		],
		absence: [
			{
				id: "fixed-dup",
				pair: ["src/alpha.ts", "src/deep/beta.ts"],
				pattern: "1 ?\\+ ?pct",
				note: "cap dup was fixed",
			},
			{
				id: "other",
				pair: ["src/alpha.ts", "src/deep/beta.ts"],
				pattern: "zebra-migration",
				note: "pattern absent -> passes",
			},
		],
		frontmatter: {
			expect_nonzero_lenses: ["duplication", "dead_abstraction"],
			max: { blockers: 0 },
			present: ["commit", "nope_field"],
		},
	},
});
assert.equal(
	byText(g1, "validate-artifact.mjs passes").passed,
	true,
	"in-progress artifact with CORE fields validates",
);
assert.equal(
	byText(g1, "status: ready").passed,
	false,
	"in-progress fixture must fail the finalization check",
);
assert.equal(
	byText(g1, "placeholders").passed,
	true,
	"fixture has no step placeholders",
);
assert.equal(
	byText(g1, "citation resolves").passed,
	false,
	"ghost.ts + line 99 must fail resolvability",
);
assert.match(byText(g1, "citation resolves").evidence, /ghost\.ts/);
assert.doesNotMatch(
	byText(g1, "citation resolves").evidence,
	/ci\.yml/,
	".github/** paths resolve (dot-dir whitelist)",
);
assert.equal(
	byText(g1, "verbatim quote").passed,
	false,
	"one bad quote must fail",
);
assert.match(byText(g1, "verbatim quote").evidence, /1\/2|beta\.ts:2/);
assert.equal(
	byText(g1, "recall D1").passed,
	true,
	"both dup sites cited within window",
);
assert.equal(
	byText(g1, "recall MISSED").passed,
	false,
	"radius-0 + missing file cannot reach min_files=2",
);
assert.equal(
	byText(g1, "absence fixed-dup").passed,
	false,
	"the D1 row re-reports the fixed pair + pattern",
);
assert.equal(
	byText(g1, "absence other").passed,
	true,
	"pair cited but pattern absent -> no violation",
);
assert.equal(byText(g1, "slop_by_lens.duplication").passed, true);
assert.equal(
	byText(g1, "slop_by_lens.dead_abstraction").passed,
	false,
	"zero lens count must fail expect_nonzero",
);
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
writeFileSync(
	noneOut,
	"## Interaction Sweep — src\n\nNo grounded cross-finding interaction. Findings are independent.\n",
);
const g3 = run(noneOut, {
	id: "T-none",
	checks: {
		expect_no_interaction: true,
		forbidden_vocab: "severity|🔴|remediation",
	},
});
assert.equal(byText(g3, "no-interaction").passed, true);
assert.equal(byText(g3, "vocabulary").passed, true);

const g4 = run(ixOut, {
	id: "T-none-fail",
	checks: { expect_no_interaction: true },
});
assert.equal(
	byText(g4, "no-interaction").passed,
	false,
	"IX blocks present -> must fail",
);

// ---------- section_routing (discover-style: a keyword must land in the right section) ----------
const frdOut = join(tmp, "frd.md");
writeFileSync(
	frdOut,
	`---
status: complete
register: plain
---
## Goals
- Coach can attach a short note that the client sees on their next plan.

## Constraints & Assumptions
- Must not change plan generation; a failed note must never block the plan from rendering.

## Suggested Follow-ups
- The exercise search is slow (~5s) — raised during the interview, out of scope for the note feature.
`,
);
const g5 = run(frdOut, {
	id: "T-routing",
	checks: {
		section_routing: [
			{
				id: "scope-creep",
				keyword: "exercise search",
				in_section: "Suggested Follow-ups",
				not_in_section: "Goals|Functional",
				note: "scope-creep aside routes to follow-ups, not scope",
			},
			{
				id: "constraint",
				keyword: "never block",
				in_section: "Constraints",
				note: "constraint captured",
			},
			{
				id: "leaked",
				keyword: "exercise search",
				in_section: "Goals",
				note: "negative control — should FAIL (not in Goals)",
			},
		],
	},
});
assert.equal(
	byText(g5, "routing scope-creep").passed,
	true,
	"scope-creep keyword in Follow-ups and not in Goals",
);
assert.equal(
	byText(g5, "routing constraint").passed,
	true,
	"constraint keyword present in Constraints",
);
assert.equal(
	byText(g5, "routing leaked").passed,
	false,
	"keyword is NOT in Goals -> in_section check must fail",
);

// ---------- Phase 7: grader field-assert migration (store-backed) ----------
// A store-backed artifact grades recall/absence/max_findings over the sibling review.json;
// a non-store artifact keeps the existing markdown grep (per-artifact fallback, no dual-run).
function storeFixture(name, findings, mdBody = "# Review\n") {
	const md = join(tmp, `${name}.md`);
	writeFileSync(md, `---\nstatus: ready\n---\n${mdBody}`);
	writeFileSync(
		join(tmp, `${name}.json`),
		JSON.stringify(
			{ schema: 1, artifact: `${name}.md`, target: "src", findings },
			null,
			2,
		),
	);
	return md;
}

// P7.1 recall field-asserts over review.json WHEN a store exists.
{
	const finding = {
		id: "L0-01",
		layer: 0,
		lens: "G",
		title: "t",
		evidence: [{ path: "src/alpha.ts", startLine: 320, quoted: ["x"] }],
	};
	const md = storeFixture("recall-store", [finding]);
	const caseSpec = {
		id: "T-recall-store",
		checks: {
			render_fidelity: false,
			recall: [
				{
					id: "R1",
					files: [{ path: "src/alpha.ts", line: 322, radius: 5 }],
					min_files: 1,
				},
			],
		},
	};
	const r = byText(run(md, caseSpec), "recall R1");
	assert.equal(
		r.passed,
		true,
		"recall matches review.json evidence within the window",
	);
	assert.match(r.evidence, /\[review\.json\]/, "graded off review.json");
	// delete the finding from review.json, leave a matching body cite -> must fail (reads JSON, not body)
	writeFileSync(
		join(tmp, "recall-store.json"),
		JSON.stringify(
			{ schema: 1, artifact: "recall-store.md", target: "src", findings: [] },
			null,
			2,
		),
	);
	writeFileSync(
		md,
		"---\nstatus: ready\n---\n# Review\n\n`src/alpha.ts:322` — `x`\n",
	);
	assert.equal(
		byText(run(md, caseSpec), "recall R1").passed,
		false,
		"empty review.json -> recall fails despite a body cite",
	);
	console.log(
		"OK — P7 recall from review.json: field-asserts over the store, not the body.",
	);
}

// P7.2 NON-store artifacts keep grading recall via the UNCHANGED markdown path.
{
	const md = join(tmp, "recall-nostore.md");
	writeFileSync(
		md,
		"---\nstatus: ready\n---\n## Findings\n\n- `src/alpha.ts:3` — `return prior * (1 + pct / 100);`\n",
	);
	const r = byText(
		run(md, {
			id: "T-recall-nostore",
			checks: {
				recall: [
					{
						id: "R1",
						files: [{ path: "src/alpha.ts", line: 3 }],
						min_files: 1,
					},
				],
			},
		}),
		"recall R1",
	);
	assert.equal(r.passed, true, "markdown fallback matches the body cite");
	assert.doesNotMatch(
		r.evidence,
		/\[review\.json\]/,
		"graded off markdown, not review.json",
	);
	console.log(
		"OK — P7 non-store markdown fallback: recall via the body cite (unchanged).",
	);
}

// P7.3 absence field-asserts when store-backed; the markdown unit-grep runs otherwise.
{
	const dup = {
		id: "D1",
		status: "accepted",
		title: "cap formula duplicated 1 + pct",
		what: "",
		why: "",
		evidence: [
			{ path: "src/alpha.ts", startLine: 3 },
			{ path: "src/deep/beta.ts", startLine: 3 },
		],
	};
	const md = storeFixture("absence-store", [dup]);
	const caseSpec = {
		id: "T-absence-store",
		checks: {
			render_fidelity: false,
			absence: [
				{
					id: "fixed-dup",
					pair: ["src/alpha.ts", "src/deep/beta.ts"],
					pattern: "1 ?\\+ ?pct",
					note: "was fixed",
				},
			],
		},
	};
	assert.equal(
		byText(run(md, caseSpec), "absence fixed-dup").passed,
		false,
		"store finding re-reports the fixed pair+pattern",
	);
	writeFileSync(
		join(tmp, "absence-store.json"),
		JSON.stringify(
			{ schema: 1, artifact: "absence-store.md", target: "src", findings: [] },
			null,
			2,
		),
	);
	assert.equal(
		byText(run(md, caseSpec), "absence fixed-dup").passed,
		true,
		"no finding in review.json -> not re-reported",
	);
	const mdNo = join(tmp, "absence-nostore.md");
	writeFileSync(
		mdNo,
		"---\nstatus: ready\n---\n## Findings\n\n| D1 | dup | `src/alpha.ts:3` and `src/deep/beta.ts:3` 1 + pct | High |\n",
	);
	assert.equal(
		byText(
			run(mdNo, {
				id: "T-absence-nostore",
				checks: {
					absence: [
						{
							id: "fixed-dup",
							pair: ["src/alpha.ts", "src/deep/beta.ts"],
							pattern: "1 ?\\+ ?pct",
						},
					],
				},
			}),
			"absence fixed-dup",
		).passed,
		false,
		"markdown unit re-reports -> fail",
	);
	console.log(
		"OK — P7 absence store + fallback: store field-assert; markdown unit-grep otherwise.",
	);
}

// P7.4 max_findings counts active review.json findings when store-backed (withdrawn excluded); else body markers.
{
	const mk = (statuses) => statuses.map((s, i) => ({ id: `F${i}`, status: s }));
	const md = storeFixture(
		"max-store",
		mk(["accepted", "accepted", "accepted", "withdrawn"]),
	);
	assert.equal(
		byText(
			run(md, {
				id: "T-max-store-3",
				checks: { render_fidelity: false, max_findings: 3 },
			}),
			"findings <= 3",
		).passed,
		true,
		"3 active + 1 withdrawn <= 3",
	);
	assert.equal(
		byText(
			run(md, {
				id: "T-max-store-2",
				checks: { render_fidelity: false, max_findings: 2 },
			}),
			"findings <= 2",
		).passed,
		false,
		"3 active > 2",
	);
	const mdNo = join(tmp, "max-nostore.md");
	writeFileSync(mdNo, "---\nstatus: ready\n---\n### 🔴 one\n### 🟡 two\n");
	assert.equal(
		byText(
			run(mdNo, { id: "T-max-nostore", checks: { max_findings: 1 } }),
			"flagged findings <= 1",
		).passed,
		false,
		"2 body markers > 1",
	);
	console.log(
		"OK — P7 max_findings store + fallback: active count vs body-marker count.",
	);
}

// P7.5 render-fidelity fails when a region diverges from a fresh render; skipped when no store.
{
	const finding = {
		id: "L0-01",
		layer: 0,
		lens: "G",
		title: "god-object",
		evidence: [
			{
				path: "src/alpha.ts",
				startLine: 3,
				endLine: null,
				quoted: ["return prior * (1 + pct / 100);"],
			},
		],
		symbol: null,
		anchor: "a",
		what: "w",
		why: "y",
		remediation: {
			steps: ["s"],
			acceptance: ["a"],
			testStrategy: "t",
			tradeoff: "o",
		},
		severity: "High",
		effort: "L",
		blastRadius: ["cross-module"],
		class: "redesign",
		entityStage: null,
		verify: "Verified",
		status: "accepted",
		statusNote: null,
		dependsOn: [],
		crossCutTag: null,
		fp: "deadbeefdeadbeef",
	};
	const store = {
		schema: 1,
		artifact: "rf.md",
		target: "src",
		findings: [finding],
	};
	const findingsRegion = renderFinding(finding);
	const tallyRegion = renderTally(store, 0);
	const body = `# Review\n\n<!-- BEGIN store:findings layer=0 -->\n${findingsRegion}\n<!-- END store:findings layer=0 -->\n\n<!-- BEGIN store:tally layer=0 -->\n${tallyRegion}\n<!-- END store:tally layer=0 -->\n`;
	const md = join(tmp, "rf.md");
	writeFileSync(md, `---\nstatus: ready\n---\n${body}`);
	writeFileSync(join(tmp, "rf.json"), JSON.stringify(store, null, 2));
	assert.equal(
		byText(run(md, { id: "T-rf", checks: {} }), "render-fidelity").passed,
		true,
		"regions match a fresh render -> faithful",
	);
	// mutate one char inside the findings region (review.json unchanged) -> stale
	writeFileSync(
		md,
		`---\nstatus: ready\n---\n${body.replace("- **Lens:** G", "- **Lens:** X")}`,
	);
	const stale = byText(
		run(md, { id: "T-rf-stale", checks: {} }),
		"render-fidelity",
	);
	assert.equal(stale.passed, false, "mutated region -> stale");
	assert.match(stale.evidence, /layer 0 findings/, "names the stale region");
	// no sibling review.json -> render-fidelity is store-gated (no expectation emitted)
	const mdNo = join(tmp, "rf-nostore.md");
	writeFileSync(mdNo, "---\nstatus: ready\n---\n# Review\n");
	const g = run(mdNo, { id: "T-rf-nostore", checks: {} });
	assert.equal(
		g.expectations.find((e) => e.text.includes("render-fidelity")),
		undefined,
		"no render-fidelity expectation without a store",
	);
	console.log(
		"OK — P7 render-fidelity: faithful passes, mutated fails, store-gated when absent.",
	);
}

// Current reviewers cannot earn negative-control credit from an uninspected output.
{
	const md = join(tmp, "current-review.md");
	writeFileSync(
		md,
		"inspection: unavailable\ndiagnostic: required source cannot be read\n",
	);
	const grade = run(md, {
		id: "T-current-unavailable",
		checks: {
			current_review: { mode: "intent", format: "slice-rows" },
			slice_rows: { restraint: [{ id: "no-invented-leak", forbid: "leak" }] },
		},
	});
	assert.equal(
		byText(grade, "restraint no-invented-leak").passed,
		false,
		"unavailable is not clean restraint",
	);
}

// The opt-in contract binds intent, actual input bytes, completion, and the role's shape.
{
	const md = join(tmp, "integrity.md");
	const ref = "b460257e1d22bb6abe073f0ad33aa628a268b0ab";
	const inputs = ["brief.md", "contract.md", "src/alpha.ts"];
	writeFileSync(
		join(tmp, "repo", "brief.md"),
		"# Next Slice\nContract: contract.md#ca-over\n",
	);
	writeFileSync(
		join(tmp, "repo", "contract.md"),
		"# CA-OVER\n110 at prior 100 and 5 percent -> 105\n",
	);
	const preamble = [
		"mode: intent",
		`repository_path: ${join(tmp, "repo")}`,
		"artifact_path: brief.md",
		"slice_id: audit-entry",
		`base_commit: ${ref}`,
		...inputs.map(
			(path) =>
				`input_sha256: ${path} ${createHash("sha256")
					.update(readFileSync(join(tmp, "repo", path)))
					.digest("hex")}`,
		),
		"identity_check: unchanged",
		"inspection: completed",
		"outcome: passed",
	].join("\n");
	const rows = "- Decisions: OK\n- Cross-slice: OK\n- Research: OK";
	const header =
		"| plan-loc | codebase-loc | severity | dimension | finding | recommendation |";
	const table = `${header}\n| --- | --- | --- | --- | --- | --- |`;
	const checks = {
		current_review: {
			mode: "intent",
			format: "slice-rows",
			artifact_path: "brief.md",
			slice_id: "audit-entry",
			inputs,
		},
		slice_rows: {
			labels: ["Decisions", "Cross-slice", "Research"],
			restraint: [{ id: "clean", forbid: ".*" }],
		},
	};
	function gradeCurrent(output, selectedChecks = checks) {
		writeFileSync(md, output);
		return run(md, { id: "T-integrity", ref, checks: selectedChecks });
	}
	assert.equal(
		gradeCurrent(`${preamble}\n\n${rows}`).summary.failed,
		0,
		"genuine completed clean intent review passes",
	);
	for (const [name, output] of [
		["missing rows", preamble],
		["missing one row", `${preamble}\n${rows.replace("- Research: OK", "")}`],
		["duplicate row", `${preamble}\n- Decisions: OK\n${rows}`],
		["old fourth row", `${preamble}\n- Correctness: OK\n${rows}`],
		["missing mode", `${preamble.replace("mode: intent", "")}\n${rows}`],
		[
			"wrong mode",
			`${preamble.replace("mode: intent", "mode: candidate")}\n${rows}`,
		],
		["wrong base", `${preamble.replace(ref, "HEAD")}\n${rows}`],
		[
			"wrong slice",
			`${preamble.replace("slice_id: audit-entry", "slice_id: other")}\n${rows}`,
		],
		[
			"wrong artifact",
			`${preamble.replace("artifact_path: brief.md", "artifact_path: other.md")}\n${rows}`,
		],
		[
			"missing contract identity",
			`${preamble.replace(/^input_sha256: contract.md .*\n/m, "")}\n${rows}`,
		],
		[
			"stale contract digest",
			`${preamble.replace(/(input_sha256: contract.md )\w+/, `$1${"0".repeat(64)}`)}\n${rows}`,
		],
		[
			"changed identity",
			`${preamble.replace("identity_check: unchanged", "identity_check: stale")}\n${rows}`,
		],
		...["unavailable", "broken", "pending", "stale", "incomplete"].map(
			(state) => [
				state,
				`${preamble.replace("inspection: completed", `inspection: ${state}`)}\n${rows}`,
			],
		),
		[
			"broken outcome with completed claim",
			`${preamble.replace("outcome: passed", "outcome: broken")}\n${rows}`,
		],
		[
			"uninspected category",
			`${preamble}\n${rows.replace("Research: OK", "Research: UNAVAILABLE: source access")}`,
		],
	]) {
		const grade = gradeCurrent(output);
		assert.equal(byText(grade, "current review integrity").passed, false, name);
		assert.equal(
			byText(grade, "restraint clean").passed,
			false,
			`${name} cannot earn restraint credit`,
		);
	}
	const tableChecks = {
		current_review: { ...checks.current_review, format: "findings-table" },
		max_table_rows: 3,
		forbidden_vocab: "\\|\\s*blocker\\s*\\|",
		absence: [{ id: "not-reported", pair: ["src/alpha.ts"], pattern: "leak" }],
	};
	assert.equal(
		gradeCurrent(`${preamble}\n\n${table}`, tableChecks).summary.failed,
		0,
		"completed inspection plus an empty findings table is genuinely clean",
	);
	for (const output of [
		table,
		`${preamble}\n${header}`,
		`${preamble}\nno findings`,
		`${preamble.replace("outcome: passed", "outcome: broken")}\n${table}`,
	]) {
		const grade = gradeCurrent(output, tableChecks);
		for (const fragment of [
			"current review integrity",
			"table body rows",
			"vocabulary",
			"absence not-reported",
		]) {
			assert.equal(
				byText(grade, fragment).passed,
				false,
				`${fragment}: a header-only or broken review is not clean`,
			);
		}
	}
	const finding =
		"| Next Slice | src/alpha.ts:3 | concern | test-contract | Missing boundary oracle | Pin the boundary |";
	assert.equal(
		gradeCurrent(
			`${preamble.replace("outcome: passed", "outcome: failed")}\n${table}\n${finding}`,
			tableChecks,
		).summary.failed,
		0,
		"completed review with an identified concern is not broken execution",
	);
	writeFileSync(join(tmp, "repo", "contract.md"), "changed approved oracle");
	assert.equal(
		byText(gradeCurrent(`${preamble}\n${rows}`), "current review integrity")
			.passed,
		false,
		"changed input bytes invalidate the recorded binding",
	);
	const legacy = gradeCurrent(table, {
		max_table_rows: 3,
		slice_rows: { no_false_correctness: true },
	});
	assert.equal(
		legacy.summary.failed,
		0,
		"explicit legacy comparison without the opt-in retains old checks",
	);
	assert.equal(
		legacy.expectations.some((e) =>
			e.text.includes("current review integrity"),
		),
		false,
		"legacy output schema has no extra expectation",
	);
	console.log("OK - current intent review integrity and legacy compatibility.");
}

rmSync(tmp, { recursive: true, force: true });
console.log("OK");
