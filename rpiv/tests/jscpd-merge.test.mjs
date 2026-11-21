// tests/jscpd-merge.test.mjs — contract tests for skills/_shared/jscpd-merge.mjs, the single
// owner of how two cpd reports of one tree (javascript reader + typescript reader) combine.
// Seams: mergeCpdReports imported directly; the CLI spawned on real report files.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mergeCpdReports } from "../skills/_shared/jscpd-merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "skills", "_shared", "jscpd-merge.mjs");

/** A cpd clone between two [file, startLine, endLine] sides. */
const clone = ([a, aStart, aEnd], [b, bStart, bEnd], tokens = 60) => ({
	firstFile: { name: a, start: aStart, end: aEnd },
	secondFile: { name: b, start: bStart, end: bEnd },
	lines: aEnd - aStart + 1,
	tokens,
});

describe("mergeCpdReports", () => {
	it("keeps the longer of two overlapping clones of the same file pair", () => {
		const js = clone(["a.ts", 10, 16], ["b.ts", 40, 46]); // 7 lines
		const ts = clone(["a.ts", 10, 20], ["b.ts", 40, 50]); // 11 lines, same copy
		expect(
			mergeCpdReports([{ duplicates: [js] }, { duplicates: [ts] }]),
		).toEqual({
			duplicates: [ts],
		});
	});

	it("treats a clone with its sides listed in the other order as the same clone", () => {
		const one = clone(["a.ts", 10, 20], ["b.ts", 40, 50]);
		const flipped = clone(["b.ts", 42, 48], ["a.ts", 12, 18]);
		expect(
			mergeCpdReports([{ duplicates: [one] }, { duplicates: [flipped] }])
				.duplicates,
		).toEqual([one]);
	});

	it("keeps clones that touch the same files at different lines, and clones only one report has", () => {
		const early = clone(["a.ts", 1, 8], ["b.ts", 1, 8]);
		const late = clone(["a.ts", 30, 38], ["b.ts", 30, 38]);
		const other = clone(["a.ts", 1, 8], ["c.ts", 1, 8]);
		const merged = mergeCpdReports([
			{ duplicates: [early, other] },
			{ duplicates: [late] },
		]);
		expect(merged.duplicates).toHaveLength(3);
		expect(merged.duplicates).toEqual(
			expect.arrayContaining([early, late, other]),
		);
	});

	it("does not merge when only one side overlaps", () => {
		const x = clone(["a.ts", 10, 20], ["b.ts", 40, 50]);
		const y = clone(["a.ts", 10, 20], ["b.ts", 90, 100]);
		expect(
			mergeCpdReports([{ duplicates: [x] }, { duplicates: [y] }]).duplicates,
		).toHaveLength(2);
	});

	it("never merges two clones of the SAME report, even when they touch or overlap", () => {
		// cpd reports adjacent blocks sharing a boundary line as separate clones — seen on a
		// real lib/: internal.ts:17-28 and internal.ts:28-39 against types.ts:213-224 / 224-235.
		const upper = clone(["a.ts", 17, 28], ["b.ts", 213, 224]);
		const lower = clone(["a.ts", 28, 39], ["b.ts", 224, 235]);
		expect(
			mergeCpdReports([{ duplicates: [upper, lower] }]).duplicates,
		).toHaveLength(2);
		expect(
			mergeCpdReports([{ duplicates: [upper, lower] }, { duplicates: [] }])
				.duplicates,
		).toHaveLength(2);
	});

	it("drops a later clone spanning two earlier ones instead of collapsing them", () => {
		const upper = clone(["a.ts", 17, 28], ["b.ts", 213, 224]);
		const lower = clone(["a.ts", 28, 39], ["b.ts", 224, 235]);
		const spanning = clone(["a.ts", 17, 39], ["b.ts", 213, 235]); // 23 lines, covers both
		const merged = mergeCpdReports([
			{ duplicates: [upper, lower] },
			{ duplicates: [spanning] },
		]);
		expect(merged.duplicates).toEqual([upper, lower]);
	});

	it("breaks a line-count tie by token count", () => {
		const fewer = clone(["a.ts", 1, 9], ["b.ts", 1, 9], 55);
		const more = clone(["a.ts", 1, 9], ["b.ts", 1, 9], 70);
		expect(
			mergeCpdReports([{ duplicates: [fewer] }, { duplicates: [more] }])
				.duplicates,
		).toEqual([more]);
	});
});

describe("jscpd-merge CLI", () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-jscpd-merge-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const file = (name, body) => {
		const p = join(dir, name);
		writeFileSync(p, body);
		return p;
	};
	const run = (...args) =>
		spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });

	it("prints the merged clones and each report's own count", () => {
		const a = file(
			"js.json",
			JSON.stringify({ duplicates: [clone(["a.ts", 1, 7], ["b.ts", 1, 7])] }),
		);
		const b = file(
			"ts.json",
			JSON.stringify({
				duplicates: [
					clone(["a.ts", 1, 11], ["b.ts", 1, 11]),
					clone(["c.ts", 1, 9], ["d.ts", 1, 9]),
				],
			}),
		);
		const r = run(a, b);
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.duplicates).toHaveLength(2);
		expect(out.passes).toEqual([
			{ report: a, clones: 1 },
			{ report: b, clones: 2 },
		]);
	});

	it.each([
		[
			"a missing report",
			() => join(dir, "nope.json"),
			/BROKEN .*nope\.json: no such file/,
		],
		[
			"malformed JSON",
			() => file("bad.json", "{not json"),
			/BROKEN .*bad\.json: unreadable/,
		],
		[
			"JSON that is not a cpd report",
			() => file("other.json", '{"clones": []}'),
			/BROKEN .*other\.json: not a jscpd report/,
		],
	])(
		"reports %s as BROKEN, never as an empty clone list",
		(_label, makePath, message) => {
			const good = file("good.json", JSON.stringify({ duplicates: [] }));
			const r = run(good, makePath());
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(message);
		},
	);

	it("rejects a call with no reports", () => {
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/usage/);
	});
});
