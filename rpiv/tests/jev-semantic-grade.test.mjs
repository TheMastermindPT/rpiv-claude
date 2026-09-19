// tests/jev-semantic-grade.test.mjs — contract tests for the semantic
// grading stage (evals/harness/jev-semantic-grade.mjs). No network:
// semanticGrade runs through an injected fetch fake.
// Pins the three invariants:
//   - candidate matching finds the nearest in-window finding per recall item
//   - verdict bands: p >= 0.7 pass, 0.3-0.7 uncertain, <= 0.3 fail
//   - a broken call is per-item, never thrown, and no-candidate is honest

import { describe, expect, it } from "vitest";

import {
	extractFindings,
	FAIL_BAR,
	matchCandidate,
	PASS_BAR,
	semanticGrade,
} from "../evals/harness/jev-semantic-grade.mjs";

const ARTIFACT = `## Review

### Q1 Severity

**Where**
\`lib/generation/adaptive-context/validation.ts:311\`

**Why**
The inlined formula divides the whole product by 100 — operator precedence.

### Q2 Severity

**Where**
\`lib/generation/load-cap.ts:19\`

**Why**
Single-owner contract notes.
`;

const RECALL_ITEM = {
	id: "planted-cap-bug",
	note: "the inlined cap formula with the precedence bug",
	files: [
		{
			path: "lib/generation/adaptive-context/validation.ts",
			line: 311,
			radius: 12,
		},
	],
};

const okJson = (body) => ({ ok: true, json: async () => body });
const jevP = (p) => ({ answers: { describes_defect: { noul: p } } });

describe("extractFindings", () => {
	it("keeps legacy suffixed IDs but ignores prose and number-only headings", () => {
		expect(
			extractFindings(
				"### Notes\ntext\n### 123 not an ID\ntext\n### Q1_suffix Finding\ntext\n### Q_2 Other\ntext\n",
			).map((f) => f.id),
		).toEqual(["Q1_suffix", "Q_2"]);
	});
	it("preserves canonical hyphenated architectural IDs", () => {
		expect(
			extractFindings(
				"### L0-01 First\nbody\n### L0-02 Second\nbody\n### IX-3 Compound\nbody",
			).map((f) => f.id),
		).toEqual(["L0-01", "L0-02", "IX-3"]);
	});
	it("parses ### sections with ids", () => {
		const findings = extractFindings(ARTIFACT);
		expect(findings.map((f) => f.id)).toEqual(["Q1", "Q2"]);
		expect(findings[0].text).toContain("operator precedence");
	});
});

describe("matchCandidate", () => {
	it("matches a finding citing a file inside the recall window", () => {
		const findings = extractFindings(ARTIFACT);
		const match = matchCandidate(findings[0], RECALL_ITEM);
		expect(match).toMatchObject({ id: "Q1", distance: 0 });
	});

	it("returns null when nothing is inside the window", () => {
		const findings = extractFindings(ARTIFACT);
		expect(matchCandidate(findings[1], RECALL_ITEM)).toBeNull();
	});

	it("accepts suffix path matches", () => {
		const findings = extractFindings(
			"### X1 P\n\n**Where**\n`adaptive-context/validation.ts:305`\n",
		);
		expect(matchCandidate(findings[0], RECALL_ITEM)?.id).toBe("X1");
	});
});

describe("semanticGrade", () => {
	it.each([
		[0, "fail"],
		[1, "pass"],
		[0.3, "fail"],
		[0.7, "pass"],
	])("accepts boundary probability %s as %s", async (p, verdict) => {
		const result = await semanticGrade({
			recallItems: [RECALL_ITEM],
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async () => okJson(jevP(p)),
		});
		expect(result.results[0].verdict).toBe(verdict);
		expect(result.summary.broken).toBe(0);
	});
	it.each([undefined, null, "0.8", NaN, Infinity, -0.1, 1.1])(
		"treats invalid probability %s as broken, never uncertain",
		async (p) => {
			const result = await semanticGrade({
				recallItems: [RECALL_ITEM],
				artifactText: ARTIFACT,
				key: "k",
				fetchImpl: async () => okJson(jevP(p)),
			});
			expect(result.summary.broken).toBe(1);
			expect(result.summary.uncertain).toBe(0);
			expect(result.results[0].note).toMatch(/malformed/);
		},
	);
	it("bands verdicts and picks the best candidate per item", async () => {
		const { results, summary } = await semanticGrade({
			recallItems: [RECALL_ITEM],
			groundTruthNote: "the precedence bug in the inlined cap formula",
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async (_url, opts) => {
				const body = JSON.parse(opts.body);
				expect(body.state.ground_truth_note).toContain("precedence bug");
				expect(body.state.candidate_finding).toContain("operator precedence");
				return okJson(jevP(0.98));
			},
		});
		expect(results[0]).toMatchObject({
			id: "planted-cap-bug",
			candidate: "Q1",
			verdict: "pass",
		});
		expect(summary.pass).toBe(1);
	});

	it("mid probabilities are uncertain, low are fail", async () => {
		const mid = await semanticGrade({
			recallItems: [RECALL_ITEM],
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async () => okJson(jevP(0.5)),
		});
		expect(mid.results[0].verdict).toBe("uncertain");
		const low = await semanticGrade({
			recallItems: [RECALL_ITEM],
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async () => okJson(jevP(0.2)),
		});
		expect(low.results[0].verdict).toBe("fail");
		expect(PASS_BAR).toBe(0.7);
		expect(FAIL_BAR).toBe(0.3);
	});

	it("reports no-candidate honestly when nothing matches", async () => {
		const { results, summary } = await semanticGrade({
			recallItems: [
				{
					id: "absent-defect",
					files: [{ path: "lib/other/missing.ts", line: 1 }],
				},
			],
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async () => okJson(jevP(0.9)),
		});
		expect(results[0].verdict).toBe("no-candidate");
		expect(summary.noCandidate).toBe(1);
	});

	it("a broken call is per-item and never thrown", async () => {
		const { results, summary } = await semanticGrade({
			recallItems: [RECALL_ITEM],
			artifactText: ARTIFACT,
			key: "k",
			fetchImpl: async () => {
				throw new Error("down");
			},
		});
		expect(results[0].verdict).toBe("broken");
		expect(results[0].note).toContain("down");
		expect(summary.broken).toBe(1);
	});
});
