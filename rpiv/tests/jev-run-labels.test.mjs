// tests/jev-run-labels.test.mjs — contract tests for the eval-run Jev
// junction (evals/harness/jev-run-labels.mjs). Pure fs: citation checking and
// label decisions run against a synthetic mini-repo. No network.
// Pins the three invariants:
//   - a matching quote at the cited line (+-3) labels correct=true
//   - an unresolvable path or mismatched quote labels correct=false
//   - rows without checkable citations get NO label (null, never a guess)

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	checkCitation,
	extractCitations,
	labelDecision,
	labelFromLog,
} from "../evals/harness/jev-run-labels.mjs";

const tmp = mkdtempSync(join(tmpdir(), "jev-run-labels-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const repo = join(tmp, "repo");
mkdirSync(join(repo, "lib"), { recursive: true });
writeFileSync(
	join(repo, "lib", "a.ts"),
	"export const max = 100;\nfunction inner() {\n  return max / 2;\n}\n",
);

describe("extraction", () => {
	it("finds path:line tokens and backtick quotes", () => {
		const text = "lib/a.ts:1 | `export const max = 100;` | surface 3 | note";
		expect(extractCitations(text)).toHaveLength(1);
		expect(extractCitations(text)[0]).toMatchObject({
			path: "lib/a.ts",
			line: 1,
		});
	});
});

describe("checkCitation", () => {
	it("matches a quote at the cited line within the window", () => {
		const verdicts = checkCitation(
			"lib/a.ts:1 | `export const max = 100;` | ok",
			repo,
		);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].verdict).toBe("match");
	});

	it("matches whitespace-normalized quotes a few lines off", () => {
		const verdicts = checkCitation(
			"lib/a.ts:1 | `return   max / 2;` | ok",
			repo,
		);
		expect(verdicts[0].verdict).toBe("match");
	});

	it("flags mismatched quotes", () => {
		const verdicts = checkCitation(
			"lib/a.ts:1 | `this line does not exist` | ok",
			repo,
		);
		expect(verdicts[0].verdict).toBe("mismatch");
	});

	it("flags unresolvable paths", () => {
		const verdicts = checkCitation("lib/missing.ts:1 | `whatever` | ok", repo);
		expect(verdicts[0].verdict).toBe("unresolvable");
	});

	it("returns no-quote when the row cites without a quote", () => {
		const verdicts = checkCitation(
			"lib/a.ts:1 | some note without a quote",
			repo,
		);
		expect(verdicts[0].verdict).toBe("no-quote");
	});
});

describe("labelDecision", () => {
	it("labels correct=false on any mismatch or unresolvable citation", () => {
		expect(labelDecision([{ verdict: "match" }, { verdict: "mismatch" }])).toBe(
			false,
		);
		expect(labelDecision([{ verdict: "unresolvable" }])).toBe(false);
	});

	it("labels correct=true when at least one citation matches and none fail", () => {
		expect(labelDecision([{ verdict: "match" }])).toBe(true);
		expect(labelDecision([{ verdict: "match" }, { verdict: "no-quote" }])).toBe(
			true,
		);
	});

	it("returns null when nothing is checkable", () => {
		expect(labelDecision([])).toBeNull();
		expect(labelDecision([{ verdict: "no-quote" }])).toBeNull();
	});
});

describe("labelFromLog", () => {
	it("writes labels only for mechanically checkable rows, keyed by ts", () => {
		const logPath = join(tmp, "lint.log");
		const labelsPath = join(tmp, "labels.jsonl");
		writeFileSync(
			logPath,
			`${[
				JSON.stringify({
					ts: "t1",
					source: "out.md",
					agent: "claim-verifier",
					id: "Q1",
					row: "lib/a.ts:1 | `export const max = 100;` | ok",
				}),
				JSON.stringify({
					ts: "t2",
					source: "out.md",
					agent: "claim-verifier",
					id: "Q2",
					row: "lib/a.ts:1 | `not the real line` | bad",
				}),
				JSON.stringify({
					ts: "t3",
					source: "out.md",
					agent: "claim-verifier",
					id: "Q3",
					row: "no citations here",
				}),
				JSON.stringify({
					ts: "t4",
					source: "out.md",
					agent: "slice-verifier",
					id: "Decisions",
					row: "lib/a.ts:1 | `not the real line` | bad",
				}),
				JSON.stringify({
					ts: "t5",
					source: "other.md",
					agent: "claim-verifier",
					id: "Q5",
					row: "lib/a.ts:1 | `export const max = 100;` | ok",
				}),
			].join("\n")}\n`,
		);
		const written = labelFromLog(logPath, labelsPath, "out.md", repo);
		expect(written).toBe(2);
		const labels = readFileSync(labelsPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(labels).toHaveLength(2);
		expect(labels.find((l) => l.ts === "t1").correct).toBe(true);
		expect(labels.find((l) => l.ts === "t2").correct).toBe(false);
	});

	it("writes nothing when the source has no entries", () => {
		const logPath = join(tmp, "empty.log");
		const labelsPath = join(tmp, "labels2.jsonl");
		writeFileSync(logPath, "");
		expect(labelFromLog(logPath, labelsPath, "nope.md", repo)).toBe(0);
	});
});
