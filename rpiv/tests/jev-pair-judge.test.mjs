// tests/jev-pair-judge.test.mjs — contract tests for the pair-judge family.
// No network: judgePairs runs through an injected fetch fake.
// Pins the invariants:
//   - patch hunks parse and hunkFor matches by suffix within the hunk range
//   - scope pairs assemble from findings + patch, null context when no hunk
//   - bands: >= 0.7 ok, 0.3-0.7 uncertain, <= 0.3 miss with per-check labels
//   - null-context pairs are skipped loudly, never judged blind

import { describe, expect, it } from "vitest";

import {
	assembleScopePairs,
	CHECKS,
	hunkFor,
	judgePairs,
	parsePatchHunks,
} from "../scripts/jev-pair-judge.mjs";

const PATCH = `diff --git a/lib/gen/validation.ts b/lib/gen/validation.ts
index fda2003..05efebd 100644
--- a/lib/gen/validation.ts
+++ b/lib/gen/validation.ts
@@ -306,10 +306,9 @@ function getIncreaseLoadValidationError(
     return \`\${exercise.exercise_id}: requires load above kg\`;
   }
 
-  const maxAllowedLoad = getMaxAllowedLoadKg(
-    summary.prescribedLoadKg,
-    recommendation.max_load_increase_pct,
-  );
+  // Cap math inlined here.
+  const maxAllowedLoad =
+    (summary.prescribedLoadKg * (1 + recommendation.max_load_increase_pct)) / 100;
 
   if (loadAtOrBelow(exercise.load_target_kg, maxAllowedLoad)) {
     return null;
`;

const FINDINGS = [
	{
		id: "Q1",
		file: "lib/gen/validation.ts",
		line: 311,
		verbatim:
			"(summary.prescribedLoadKg * (1 + recommendation.max_load_increase_pct)) / 100;",
		note: "precedence bug",
	},
	{
		id: "Q2",
		file: "lib/gen/other.ts",
		line: 10,
		verbatim: "x",
		note: "elsewhere",
	},
];

const okJson = (body) => ({ ok: true, json: async () => body });
const jevP = (p) => ({ answers: { consistent: { noul: p } } });

describe("patch parsing", () => {
	it("distinguishes deleted SQL comments from file headers across hunks", () => {
		const patch =
			"diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+-- new comment\n SELECT 1;\n@@ -8 +8 @@\n-SELECT 2;\n+SELECT 3;\n";
		const pairs = assembleScopePairs(
			[
				{ id: "Q1", file: "query.sql", line: 2 },
				{ id: "Q2", file: "query.sql", line: 8 },
			],
			[patch],
		);
		expect(pairs[0].b).toContain("SELECT 1;");
		expect(pairs[1].b).toContain("SELECT 3;");
	});
	it("uses exclusive new-file spans, ignoring deletions and patch metadata", () => {
		const patch =
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,4 +10,1 @@\n-old1\n-old2\n-old3\n-old4\n+new\ndiff --git a/b.ts b/b.ts\nindex abc..def\n";
		const hunks = parsePatchHunks(patch);
		expect(hunkFor({ file: "a.ts", line: 10 }, hunks)).not.toBeNull();
		expect(hunkFor({ file: "a.ts", line: 11 }, hunks)).toBeNull();
		expect(hunkFor({ file: "a.ts", line: 14 }, hunks)).toBeNull();
		expect(hunks[0].text).not.toContain("diff --git");
		expect(
			hunkFor(
				{ file: "a.ts", line: 10 },
				parsePatchHunks(patch.replace("+10,1", "+10,0")),
			),
		).toBeNull();
	});
	it("parses hunks with new-file start lines", () => {
		const hunks = parsePatchHunks(PATCH);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({
			file: "lib/gen/validation.ts",
			start: 306,
		});
		expect(hunks[0].text).toContain("Cap math inlined");
	});

	it("hunkFor matches inside the range, misses outside and wrong files", () => {
		const hunks = parsePatchHunks(PATCH);
		expect(hunkFor(FINDINGS[0], hunks)?.file).toBe("lib/gen/validation.ts");
		expect(
			hunkFor({ file: "lib/gen/validation.ts", line: 500 }, hunks),
		).toBeNull();
		expect(hunkFor(FINDINGS[1], hunks)).toBeNull();
	});
});

describe("assembleScopePairs", () => {
	it("bounds context around the cited line rather than dropping late evidence", () => {
		const lines = Array.from(
			{ length: 200 },
			(_, i) => `+const item${i} = '${"x".repeat(60)}';`,
		);
		lines[180] = "+const TARGET_EVIDENCE = false;";
		const patch = `--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,200 @@\n${lines.join("\n")}\n`;
		const [pair] = assembleScopePairs(
			[{ id: "Q1", file: "a.ts", line: 181 }],
			[patch],
		);
		expect(pair.b).toContain("TARGET_EVIDENCE");
		expect(pair.b.length).toBeLessThanOrEqual(6200);
		const [oversize] = assembleScopePairs(
			[{ id: "Q1", file: "a.ts", line: 1 }],
			[`--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+${"x".repeat(7000)}\n`],
		);
		expect(oversize.b).toBeNull();
	});
	it("builds pairs with the hunk as context, null when no hunk covers", () => {
		const pairs = assembleScopePairs(FINDINGS, [PATCH]);
		expect(pairs).toHaveLength(2);
		expect(pairs[0].b).toContain("hunk at line 306");
		expect(pairs[1].b).toBeNull();
	});
});

describe("judgePairs", () => {
	const check = CHECKS.scope;

	it("bands verdicts and skips null-context pairs loudly", async () => {
		const results = await judgePairs({
			check,
			pairs: assembleScopePairs(FINDINGS, [PATCH]),
			key: "k",
			fetchImpl: async () => okJson(jevP(0.95)),
		});
		expect(results.find((r) => r.id === "Q1")).toMatchObject({ verdict: "ok" });
		expect(results.find((r) => r.id === "Q2")).toMatchObject({
			verdict: "no-context",
		});
	});

	it("mid and low probabilities band as uncertain and miss", async () => {
		const pairs = [
			{ id: "A", a: "finding", b: "hunk" },
			{ id: "B", a: "finding", b: "hunk" },
		];
		let calls = 0;
		const results = await judgePairs({
			check,
			pairs,
			key: "k",
			fetchImpl: async () => okJson(jevP(calls++ === 0 ? 0.5 : 0.2)),
		});
		expect(results.find((r) => r.id === "A").verdict).toBe("uncertain");
		expect(results.find((r) => r.id === "B").verdict).toBe("miss");
	});

	it("broken calls are per-pair, never thrown", async () => {
		const results = await judgePairs({
			check,
			pairs: [{ id: "A", a: "f", b: "h" }],
			key: "k",
			fetchImpl: async () => {
				throw new Error("down");
			},
		});
		expect(results[0].broken).toBe("down");
	});

	it("every check declares its labels and miss vocabulary", () => {
		expect(CHECKS.scope.missLabel).toBe("out-of-scope");
		expect(CHECKS.resolution.missLabel).toBe("does-not-address");
		expect(CHECKS.oracle.missLabel).toBe("theater");
	});
});
