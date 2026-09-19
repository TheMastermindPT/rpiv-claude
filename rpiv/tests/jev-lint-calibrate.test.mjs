// tests/jev-lint-calibrate.test.mjs — contract tests for
// scripts/jev-lint-calibrate.mjs. Pure data: synthetic logs and labels.
// Pins the three invariants:
//   - labels join to log entries by ts (+ optional id disambiguation)
//   - the bucket curve counts accuracy per decile
//   - band suggestions respect the accuracy/wrong-rate guards and the
//     minimum-data thresholds (never suggest from thin evidence)

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	appendLabel,
	bucketOf,
	buildReport,
	MIN_PER_BUCKET,
	MIN_TOTAL,
	readLabels,
	readLog,
	renderReport,
	suggestBands,
} from "../scripts/jev-lint-calibrate.mjs";

const tmp = mkdtempSync(join(tmpdir(), "jev-calibrate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const entry = (overrides) => ({
	ts: "2026-09-19T12:00:00.000Z",
	agent: "claim-verifier",
	id: "Q1",
	tag: "Verified",
	p: 0.9,
	verdict: "ok",
	row: "Q1 | tag=Verified | matches",
	...overrides,
});

describe("log and label IO", () => {
	it("readLog parses JSONL", () => {
		const path = join(tmp, "log.jsonl");
		writeFileSync(path, `${JSON.stringify(entry())}\n`);
		expect(readLog(path)).toHaveLength(1);
	});

	it("appendLabel + readLabels round-trip, skipping malformed lines", () => {
		const path = join(tmp, "labels.jsonl");
		appendLabel(path, { ts: "t1", correct: true });
		appendLabel(path, { ts: "t2", id: "Q2", correct: false });
		appendFileSync(path, "garbage line\n");
		const labels = readLabels(path);
		expect(labels.get("t1")[0].correct).toBe(true);
		expect(labels.get("t2")[0]).toMatchObject({ id: "Q2", correct: false });
		expect(labels.size).toBe(2);
	});
});

describe("bucketOf", () => {
	it("maps probabilities to deciles with clamped edges", () => {
		expect(bucketOf(0)).toBe(0);
		expect(bucketOf(0.05)).toBe(0);
		expect(bucketOf(0.19)).toBe(1);
		expect(bucketOf(0.99)).toBe(9);
		expect(bucketOf(1.2)).toBe(9);
	});
});

describe("buildReport", () => {
	it("joins labels by ts and id, and counts tiers", () => {
		const log = [
			entry({ ts: "t1", id: "Q1", verdict: "flag", p: 0.1 }),
			entry({ ts: "t1", id: "Q2", verdict: "flag", p: 0.2 }),
			entry({ ts: "t2", id: "Q3", verdict: "ok", p: 0.9 }),
		];
		const labelPath = join(tmp, "labels.jsonl");
		appendLabel(labelPath, { ts: "t1", id: "Q1", correct: true });
		appendLabel(labelPath, { ts: "t1", id: "Q2", correct: false });
		appendLabel(labelPath, { ts: "t2", correct: true });
		const report = buildReport(log, readLabels(labelPath));
		expect(report.labeled).toBe(3);
		expect(report.tiers.flag.actuallyWrong).toBe(1);
		expect(report.tiers.ok.actuallyWrong).toBe(0);
	});

	it("separates unlabeled warnings from silent rows for adjudication", () => {
		const log = [
			entry({ ts: "t1", verdict: "flag", p: 0.1 }),
			entry({ ts: "t2", verdict: "ok", p: 0.9 }),
		];
		const report = buildReport(log, readLabels(join(tmp, "none.jsonl")));
		expect(report.unlabeledWarnings).toHaveLength(1);
		expect(report.unlabeledSilent).toHaveLength(1);
	});

	it("filters by agent", () => {
		const log = [
			entry({ agent: "claim-verifier", ts: "t1", verdict: "flag", p: 0.1 }),
			entry({ agent: "slice-verifier", ts: "t2", verdict: "ok", p: 0.9 }),
		];
		const report = buildReport(log, new Map(), "slice-verifier");
		expect(report.total).toBe(1);
		expect(report.agents).toEqual(["slice-verifier"]);
	});
});

describe("suggestBands", () => {
	const flatBuckets = (overrides = {}) => {
		const { accuracy, ...rest } = overrides;
		return Array.from({ length: 10 }, (_v, b) => ({
			lo: b / 10,
			hi: (b + 1) / 10,
			n: 5,
			wrongRate: 1 - accuracy,
			...rest,
		}));
	};

	it("suggests an okBar at the lowest bucket where all above are accurate", () => {
		const buckets = flatBuckets({ accuracy: 0.99 });
		expect(suggestBands(buckets).okBar).toBe(0);
	});

	it("stops okBar at the first inaccurate high bucket", () => {
		const buckets = flatBuckets({ accuracy: 0.99, n: 20 });
		buckets[8].wrongRate = 0.5;
		expect(suggestBands(buckets).okBar).toBe(0.9);
	});

	it("suggests a flagBar only where low buckets are mostly wrong", () => {
		const buckets = flatBuckets({ accuracy: 0.99, n: 7 });
		for (let b = 0; b <= 2; b++) buckets[b].wrongRate = 0.7;
		expect(suggestBands(buckets).flagBar).toBe(0.3);
	});

	it("declines to suggest from thin evidence", () => {
		const buckets = flatBuckets({ n: 1 });
		const s = suggestBands(buckets);
		expect(s.okBar).toBeNull();
		expect(s.flagBar).toBeNull();
		expect(MIN_PER_BUCKET).toBeGreaterThan(1);
		expect(MIN_TOTAL).toBeGreaterThanOrEqual(20);
	});
});

describe("renderReport", () => {
	it("renders the section headings and marks insufficient data", () => {
		const report = buildReport([], new Map());
		const text = renderReport(report);
		expect(text).toContain("## Wrong-rate per probability bucket");
		expect(text).toContain("insufficient data");
		expect(text).toContain("## Suggested per-instance bands");
	});
});
