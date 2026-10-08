// tests/jev-uncertainty-join.test.mjs — contract tests for the
// uncertainty-routing join. Pure data: synthetic logs and store records.
// Pins the invariants:
//   - records read from arrays and { records: [...] } envelopes, dirs expanded
//   - outcomes join by finding id; died = Falsified or withdrawn
//   - the contingency report is honest: insufficient data below the guard,
//     predictive only when the flagged rate measurably exceeds the ok rate

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	contingency,
	died,
	expandStorePaths,
	joinOutcomes,
	MIN_ROWS,
	readLintRows,
	readStoreRecords,
	renderReport,
} from "../scripts/jev-uncertainty-join.mjs";

const tmp = mkdtempSync(join(tmpdir(), "jev-join-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const lintRow = (id, verdict) => ({
	agent: "claim-verifier",
	id,
	p: 0.5,
	verdict,
});

describe("inputs", () => {
	it("reads canonical findings envelopes with distinct review identities", () => {
		const path = join(tmp, "canonical.json");
		writeFileSync(
			path,
			JSON.stringify({
				review: { id: "review-a" },
				findings: [{ id: "Q1", verify: "Verified" }],
			}),
		);
		expect(readStoreRecords([path])).toEqual([
			{ id: "Q1", verify: "Verified", reviewId: "review-a" },
		]);
	});

	it("keeps valid JSONL rows and diagnoses corrupt input", () => {
		const path = join(tmp, "corrupt.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify(lintRow("Q1", "flag"))}\nBROKEN\n${JSON.stringify(lintRow("Q2", "ok"))}\n`,
		);
		const diagnostics = [];
		expect(
			readLintRows(path, (message) => diagnostics.push(message)).map(
				(r) => r.id,
			),
		).toEqual(["Q1", "Q2"]);
		expect(diagnostics.join("\n")).toMatch(/line 2/);
		const store = join(tmp, "unsupported.json");
		writeFileSync(store, "{}");
		readStoreRecords([store], (message) => diagnostics.push(message));
		expect(diagnostics.join("\n")).toMatch(/unsupported/i);
	});
	it("reads lint rows and filters to claim-verifier with a probability", () => {
		const path = join(tmp, "log.jsonl");
		writeFileSync(
			path,
			`${[
				JSON.stringify(lintRow("Q1", "flag")),
				JSON.stringify({ agent: "other", id: "Q2", p: 0.1, verdict: "flag" }),
				JSON.stringify(lintRow("Q3", "ok")),
			].join("\n")}\n`,
		);
		const rows = readLintRows(path);
		expect(rows.map((r) => r.id)).toEqual(["Q1", "Q3"]);
	});

	it("readLintRows reads the rotated generation first", () => {
		const dir = join(tmp, "rotated");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "lint.log");
		const read = (logPath) => {
			const diagnostics = [];
			const ids = readLintRows(logPath, (message) =>
				diagnostics.push(message),
			).map((r) => r.id);
			return { ids, diagnostics };
		};
		writeFileSync(
			`${path}.1`,
			`${JSON.stringify(lintRow("Q1", "flag"))}\nBROKEN\n${JSON.stringify(lintRow("Q2", "ok"))}\n`,
		);
		writeFileSync(path, `${JSON.stringify(lintRow("Q3", "review"))}\n`);
		expect(read(path)).toEqual({
			ids: ["Q1", "Q2", "Q3"],
			diagnostics: [`malformed lint JSON at line 2 in ${path}.1`],
		});

		const onlyRotated = join(dir, "only.log");
		writeFileSync(
			`${onlyRotated}.1`,
			`${JSON.stringify(lintRow("Q1", "flag"))}\n`,
		);
		expect(read(onlyRotated)).toEqual({ ids: ["Q1"], diagnostics: [] });

		const missing = join(dir, "missing.log");
		expect(read(missing)).toEqual({
			ids: [],
			diagnostics: [`cannot read lint log ${missing}: ENOENT`],
		});

		const folder = join(dir, "folder.log");
		mkdirSync(folder);
		const fromFolder = read(folder);
		expect(fromFolder.ids).toEqual([]);
		expect(fromFolder.diagnostics).toHaveLength(1);
		expect(
			fromFolder.diagnostics[0].startsWith(`cannot read lint log ${folder}: `),
		).toBe(true);
		expect(fromFolder.diagnostics[0]).toMatch(/: E[A-Z]+$/);
	});

	it("reads records from arrays, envelopes, and directories", () => {
		const dir = join(tmp, "stores");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "a.json"),
			JSON.stringify([
				{ id: "Q1", verify: "Falsified" },
				{ id: "Q2", verify: "Verified" },
			]),
		);
		writeFileSync(
			join(dir, "b.json"),
			JSON.stringify({ records: [{ id: "Q3", status: "withdrawn" }] }),
		);
		const files = expandStorePaths([dir]);
		expect(files).toHaveLength(2);
		const records = readStoreRecords(files);
		expect(records).toHaveLength(3);
	});

	it("died is Falsified or withdrawn", () => {
		expect(died({ verify: "Falsified" })).toBe(true);
		expect(died({ status: "withdrawn" })).toBe(true);
		expect(died({ verify: "Verified", status: "open" })).toBe(false);
	});
});

describe("join and report", () => {
	it("does not attribute identity-free historical rows to a namespaced store", () => {
		const tiers = joinOutcomes(
			[lintRow("Q1", "flag")],
			[{ id: "Q1", reviewId: "another-review", verify: "Falsified" }],
		);
		expect(tiers.flag.unknown).toBe(1);
	});
	it("joins namespaced IDs and leaves ambiguous legacy rows unknown", () => {
		const records = [
			{ id: "Q1", reviewId: "a", verify: "Falsified" },
			{ id: "Q1", reviewId: "b", verify: "Verified" },
		];
		const rows = [
			{ ...lintRow("Q1", "flag"), reviewId: "a" },
			{ ...lintRow("Q1", "ok"), reviewId: "b" },
			lintRow("Q1", "review"),
		];
		const tiers = joinOutcomes(rows, records);
		expect(tiers.flag.died).toBe(1);
		expect(tiers.ok.survived).toBe(1);
		expect(tiers.review.unknown).toBe(1);
	});

	it("does not infer predictive power from a single comparison tier", () => {
		const rows = Array.from({ length: 25 }, (_, i) => lintRow(`Q${i}`, "ok"));
		const records = rows.map((r) => ({ id: r.id, verify: "Verified" }));
		expect(renderReport(joinOutcomes(rows, records))).toContain(
			"INSUFFICIENT DATA",
		);
	});
	it("joins outcomes by id and computes the contingency", () => {
		const rows = [
			lintRow("Q1", "flag"),
			lintRow("Q2", "review"),
			lintRow("Q3", "ok"),
			lintRow("Q4", "ok"),
		];
		const records = [
			{ id: "Q1", verify: "Falsified" },
			{ id: "Q2", verify: "Verified" },
			{ id: "Q3", verify: "Verified" },
		];
		const tiers = joinOutcomes(rows, records);
		expect(tiers.flag).toMatchObject({ n: 1, died: 1 });
		expect(tiers.review).toMatchObject({ n: 1, survived: 1 });
		expect(tiers.ok).toMatchObject({ n: 2, survived: 1, unknown: 1 });
		const c = contingency(tiers);
		expect(c.flaggedRate).toBe(0.5);
		expect(c.okRate).toBe(0);
	});

	it("reports insufficient data below the guard, even when seemingly predictive", () => {
		const rows = [lintRow("Q1", "flag")];
		const records = [{ id: "Q1", verify: "Falsified" }];
		const text = renderReport(joinOutcomes(rows, records));
		expect(text).toContain("INSUFFICIENT DATA");
		expect(MIN_ROWS).toBe(20);
	});

	it("reports predictive only when the flagged rate exceeds the ok rate", () => {
		const rows = [];
		const records = [];
		for (let i = 0; i < 30; i++) {
			rows.push(lintRow(`F${i}`, "flag"));
			records.push({ id: `F${i}`, verify: i < 20 ? "Falsified" : "Verified" });
		}
		for (let i = 0; i < 30; i++) {
			rows.push(lintRow(`O${i}`, "ok"));
			records.push({ id: `O${i}`, verify: i < 5 ? "Falsified" : "Verified" });
		}
		const text = renderReport(joinOutcomes(rows, records));
		expect(text).toContain("PREDICTIVE");
		expect(text).toContain("flag+review died rate: 67%");
	});
});
