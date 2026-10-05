// tests/lane.test.mjs — contract tests for the lane classifier core
// skills/_shared/lane.mjs (slice S4-classify-core, D16, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyLane,
	DEFAULT_LANE_THRESHOLDS,
	loadLaneThresholds,
	mergeLane,
} from "../skills/_shared/lane.mjs";

const CONFIG = ".rpiv-lanes.json";
const roots = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** Thresholds loaded from a throwaway repo root holding `config` (omit = no file). */
const loadWith = (config) => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-lanes-"));
	roots.push(root);
	if (config === DIRECTORY) mkdirSync(join(root, CONFIG));
	else if (config !== undefined) writeFileSync(join(root, CONFIG), config);
	return loadLaneThresholds(root);
};
const DIRECTORY = Symbol("a directory named .rpiv-lanes.json");

/** `count` plain source files `src/f1.ts`… at `+1/-0`. */
const srcFiles = (count, name = (i) => `src/f${i}.ts`) =>
	Array.from({ length: count }, (_, i) => ({
		path: name(i + 1),
		added: 1,
		deleted: 0,
	}));

/** The lane and reasons of a measured change (one slice, hubs measured). */
const classify = (files, extra = {}) => {
	const { lane, reasons } = classifyLane({
		files,
		slices: 1,
		hubs: [],
		...extra,
	});
	return { lane, reasons };
};

describe("lane classifier (S4)", () => {
	it("applies the default size limits at their edges", () => {
		expect(
			classifyLane({
				files: [{ path: "src/a.ts", added: 100, deleted: 50 }],
				slices: 1,
				hubs: [],
			}),
		).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
			diagnostics: [],
		});
		expect(classify([{ path: "src/a.ts", added: 100, deleted: 51 }])).toEqual({
			lane: "normal",
			reasons: ["lines: 151 > 150"],
		});
		expect(
			classify([{ path: "src/a.ts", added: 1, deleted: 0 }], { slices: 2 }),
		).toEqual({
			lane: "normal",
			reasons: ["slices: 2 > 1"],
		});
		expect(classify(srcFiles(5))).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
		});
		expect(classify(srcFiles(6))).toEqual({
			lane: "normal",
			reasons: ["files: 6 > 5"],
		});
		expect(classify(srcFiles(60))).toEqual({
			lane: "normal",
			reasons: ["files: 60 > 5"],
		});
		expect(classify(srcFiles(61))).toEqual({
			lane: "rigorous",
			reasons: ["files: 61 > 5", "files: 61 >= 61"],
		});
		expect(
			classify([{ path: "src/a.ts", added: 200, deleted: 0 }, ...srcFiles(5)], {
				slices: 2,
			}),
		).toEqual({
			lane: "normal",
			reasons: ["slices: 2 > 1", "lines: 205 > 150", "files: 6 > 5"],
		});
	});

	it("leaves test files out of the fast limits only", () => {
		const file = (path, added, deleted = 0) => ({ path, added, deleted });
		expect(
			classify([file("src/a.ts", 100), file("tests/a.test.ts", 200)]),
		).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
		});
		expect(
			classify([file("src/a.ts", 151), file("tests/a.test.ts", 1)]),
		).toEqual({
			lane: "normal",
			reasons: ["lines: 151 > 150"],
		});
		expect(
			classify([...srcFiles(5), ...srcFiles(3, (i) => `src/f${i}.test.ts`)])
				.lane,
		).toBe("fast");
		expect(
			classify([file("tests/fixtures/big.json", 5000), file("src/a.ts", 1)])
				.lane,
		).toBe("fast");
		expect(
			classify([...srcFiles(30), ...srcFiles(31, (i) => `src/f${i}.test.ts`)]),
		).toEqual({
			lane: "rigorous",
			reasons: ["files: 30 > 5", "files: 61 >= 61"],
		});

		expect(
			classifyLane({ files: [{ path: "src/a.ts" }], slices: 1, hubs: [] }),
		).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
			diagnostics: ["lines unknown"],
		});
		expect(
			classifyLane({
				files: [file("src/a.ts", 1), { path: "tests/a.test.ts" }],
				slices: 1,
				hubs: [],
			}),
		).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
			diagnostics: [],
		});
		expect(classifyLane({ files: [file("src/a.ts", 1)], hubs: [] })).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
			diagnostics: ["slices unknown"],
		});
		// A counted file needs both counts; one uncounted file makes lines unknown.
		for (const files of [
			[{ path: "src/a.ts", added: 200 }],
			[{ path: "src/a.ts", deleted: 200 }],
			[file("src/a.ts", 200), { path: "src/b.ts" }],
		]) {
			expect
				.soft(classifyLane({ files, slices: 1, hubs: [] }).diagnostics)
				.toEqual(["lines unknown"]);
		}
		// S4 revision 1: backslash test and fixture paths stay out of the fast limits.
		for (const path of [
			"tests\\fixtures\\big.json",
			"src\\test\\resources\\data.json",
		]) {
			expect
				.soft(classify([file(path, 5000), file("src/a.ts", 1)]).lane, path)
				.toBe("fast");
		}
	});

	it("raises the lane on each sensitive-signal family", () => {
		const one = (path, extra) =>
			classify([{ path, added: 1, deleted: 0 }], extra);
		const cases = [
			[
				"src/auth/login.ts",
				"rigorous",
				["sensitive word: auth (src/auth/login.ts)"],
			],
			[
				"db/migrations/001.sql",
				"rigorous",
				[
					"migration: db/migrations/001.sql",
					"sensitive word: migration (db/migrations/001.sql)",
				],
			],
			[
				".github/workflows/ci.yml",
				"rigorous",
				["ci config: .github/workflows/ci.yml"],
			],
			["Dockerfile", "rigorous", ["container file: Dockerfile"]],
			[".env", "rigorous", ["env file: .env"]],
			["package.json", "normal", ["manifest: package.json"]],
			["pnpm-lock.yaml", "normal", ["manifest: pnpm-lock.yaml"]],
			[
				"theme/design-tokens.json",
				"normal",
				["weak sensitive word: token (theme/design-tokens.json)"],
			],
			[
				"prisma/schema.prisma",
				"normal",
				["weak sensitive word: schema (prisma/schema.prisma)"],
			],
			[
				"src/authToken.ts",
				"rigorous",
				[
					"sensitive word: auth (src/authToken.ts)",
					"weak sensitive word: token (src/authToken.ts)",
				],
			],
			[
				"tests/auth.test.ts",
				"rigorous",
				["sensitive word: auth (tests/auth.test.ts)"],
			],
		];
		for (const [path, lane, reasons] of cases) {
			expect.soft(one(path), path).toEqual({ lane, reasons });
		}

		expect(one("src/core.ts", { hubs: ["src/core.ts"] })).toEqual({
			lane: "rigorous",
			reasons: ["hub: src/core.ts"],
		});
		expect(one("src\\core.ts", { hubs: ["src/core.ts"] }).lane).toBe(
			"rigorous",
		);
		expect(one("src/a.ts", { hubs: ["src/core.ts"] }).lane).toBe("fast");
		const plain = {
			files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
			slices: 1,
		};
		expect(classifyLane(plain)).toEqual({
			lane: "fast",
			reasons: ["within fast limits"],
			diagnostics: ["hub signal unavailable"],
		});
		expect(classifyLane({ ...plain, hubs: [] }).diagnostics).toEqual([]);
		expect(
			classify([
				{ path: "src/a.ts", added: 200, deleted: 0 },
				{ path: "package.json", added: 1, deleted: 0 },
			]),
		).toEqual({
			lane: "normal",
			reasons: ["lines: 201 > 150", "manifest: package.json"],
		});

		// S4 revision 1 pins: reason order across files and kinds, and diagnostics order.
		const f1 = (path) => ({ path, added: 1, deleted: 0 });
		expect(classify([f1("src/auth/x.ts"), f1(".env")])).toEqual({
			lane: "rigorous",
			reasons: ["sensitive word: auth (src/auth/x.ts)", "env file: .env"],
		});
		expect(classify([f1("auth/package.json")])).toEqual({
			lane: "rigorous",
			reasons: [
				"manifest: auth/package.json",
				"sensitive word: auth (auth/package.json)",
			],
		});
		expect(
			classify([f1("db/migrations/x.sql")], { hubs: ["db/migrations/x.sql"] })
				.reasons,
		).toEqual([
			"hub: db/migrations/x.sql",
			"migration: db/migrations/x.sql",
			"sensitive word: migration (db/migrations/x.sql)",
		]);
		const { diagnostics } = classifyLane(
			{ files: [{ path: "src/a.ts" }] },
			loadWith("{not json"),
		);
		expect(diagnostics).toHaveLength(4);
		expect(diagnostics[0]).toMatch(/^broken config: \.rpiv-lanes\.json: \S/);
		expect(diagnostics.slice(1)).toEqual([
			"slices unknown",
			"lines unknown",
			"hub signal unavailable",
		]);
	});

	it("loads lane thresholds and flags a broken config", () => {
		const missing = loadWith(undefined);
		expect(missing).toEqual(DEFAULT_LANE_THRESHOLDS);
		expect(missing).not.toHaveProperty("broken");
		missing.fast.maxLines = 1;
		expect(DEFAULT_LANE_THRESHOLDS.fast.maxLines).toBe(150);

		const longer = loadWith('{"fast":{"maxLines":300}}');
		expect(longer).toEqual({
			fast: { maxSlices: 1, maxLines: 300, maxFiles: 5 },
			rigorous: { minFiles: 61 },
		});
		const big = {
			files: [{ path: "src/a.ts", added: 200, deleted: 0 }],
			slices: 1,
			hubs: [],
		};
		expect(classifyLane(big, longer).lane).toBe("fast");
		expect(classify(srcFiles(3)).lane).toBe("fast");
		const three = { files: srcFiles(3), slices: 1, hubs: [] };
		expect(
			classifyLane(three, loadWith('{"rigorous":{"minFiles":3}}')).lane,
		).toBe("rigorous");

		const broken = [
			["{not json", "JSON"],
			["[]", ""],
			['{"fast":5}', "fast"],
			['{"fast":{"maxLine":300}}', "fast.maxLine"],
			['{"speed":{}}', "speed"],
			['{"fast":{"maxLines":-1}}', "fast.maxLines"],
			['{"fast":{"maxLines":1.5}}', "fast.maxLines"],
			['{"fast":{"maxLines":"300"}}', "fast.maxLines"],
			[
				'{"fast":{"maxLines":300},"rigorous":{"minFile":3}}',
				"rigorous.minFile",
			],
			[DIRECTORY, "cannot read"],
			// S4 revision 1 pins.
			["null", ""],
			['{"fast":null}', "fast"],
		];
		for (const [config, named] of broken) {
			const { broken: detail, ...thresholds } = loadWith(config);
			const label = String(config);
			expect.soft(thresholds, label).toEqual(DEFAULT_LANE_THRESHOLDS);
			expect.soft(typeof detail, label).toBe("string");
			expect.soft(detail, label).toContain(named);
		}

		// S4 revision 1: a wrong repository root is a caller bug, not a missing file.
		const root = mkdtempSync(join(tmpdir(), "rpiv-lanes-"));
		roots.push(root);
		writeFileSync(join(root, "plain.txt"), "x");
		for (const repoRoot of [
			join(root, "does-not-exist"),
			join(root, "plain.txt"),
			undefined,
		]) {
			expect
				.soft(() => loadLaneThresholds(repoRoot), String(repoRoot))
				.toThrow(TypeError);
			expect
				.soft(() => loadLaneThresholds(repoRoot), String(repoRoot))
				.toThrow("repoRoot");
		}

		const bad = loadWith("{not json");
		const fastSized = classifyLane(
			{
				files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
				slices: 1,
				hubs: [],
			},
			bad,
		);
		expect(fastSized.lane).toBe("normal");
		expect(fastSized.reasons).toEqual([
			"within fast limits",
			"broken config: raised to normal",
		]);
		expect(fastSized.diagnostics).toHaveLength(1);
		expect(fastSized.diagnostics[0]).toMatch(
			/^broken config: \.rpiv-lanes\.json: \S/,
		);
		const six = classifyLane({ files: srcFiles(6), slices: 1, hubs: [] }, bad);
		expect(six).toEqual({
			lane: "normal",
			reasons: ["files: 6 > 5"],
			diagnostics: fastSized.diagnostics,
		});
		const auth = {
			files: [{ path: "src/auth/x.ts", added: 1, deleted: 0 }],
			slices: 1,
			hubs: [],
		};
		expect(classifyLane(auth, bad)).toEqual({
			lane: "rigorous",
			reasons: ["sensitive word: auth (src/auth/x.ts)"],
			diagnostics: fastSized.diagnostics,
		});
	});

	it("merges lanes without ever lowering", () => {
		const lanes = ["fast", "normal", "rigorous"];
		for (const [i, previous] of lanes.entries()) {
			for (const [j, next] of lanes.entries()) {
				expect
					.soft(mergeLane(previous, next), `${previous}+${next}`)
					.toBe(lanes[Math.max(i, j)]);
			}
		}
		expect(mergeLane(undefined, "fast")).toBe("fast");
		for (const [previous, next] of [
			["fast", "slow"],
			["slow", "fast"],
			[null, "fast"],
			["normal", undefined],
		]) {
			expect
				.soft(() => mergeLane(previous, next), `${previous}+${next}`)
				.toThrow(TypeError);
		}
	});

	it("rejects malformed input and never calls an empty change fast", () => {
		const empty = {
			lane: "normal",
			reasons: ["no changed files"],
			diagnostics: ["no changed files"],
		};
		expect
			.soft(classifyLane({ files: [], slices: 1, hubs: [] }))
			.toEqual(empty);
		expect.soft(classifyLane({ files: [] })).toEqual(empty);

		const file = (fields) => ({ files: [{ path: "src/a.ts", ...fields }] });
		const malformed = [
			[undefined, "input"],
			[null, "input"],
			[{}, "files"],
			[{ files: "a.ts" }, "files"],
			[{ files: [{}] }, "path"],
			[{ files: [{ path: "" }] }, "path"],
			[file({ added: -1 }), "added"],
			[file({ added: 1.5 }), "added"],
			[file({ deleted: "2" }), "deleted"],
			[{ ...file({}), slices: 0 }, "slices"],
			[{ ...file({}), hubs: "src/a.ts" }, "hubs"],
			[{ ...file({}), hubs: [1] }, "hubs"],
			// S4 revision 1 pins.
			[{ files: ["a.ts"] }, "files"],
			[{ files: [null] }, "files"],
			[{ ...file({}), slices: 1.5 }, "slices"],
		];
		for (const [input, field] of malformed) {
			const label = JSON.stringify(input) ?? "undefined";
			expect.soft(() => classifyLane(input), label).toThrow(TypeError);
			expect.soft(() => classifyLane(input), label).toThrow(field);
		}

		// S4 revision 1 pin: an empty change still reports a broken config.
		const emptyBroken = classifyLane({ files: [] }, loadWith("{not json"));
		expect(emptyBroken.lane).toBe("normal");
		expect(emptyBroken.reasons).toEqual(["no changed files"]);
		expect(emptyBroken.diagnostics).toHaveLength(2);
		expect(emptyBroken.diagnostics[0]).toMatch(/^broken config: /);
		expect(emptyBroken.diagnostics[1]).toBe("no changed files");

		// S4 revision 1: thresholds are validated.
		const valid = {
			files: [{ path: "src/a.ts", added: 10000, deleted: 0 }],
			slices: 1,
			hubs: [],
		};
		const nan = structuredClone(DEFAULT_LANE_THRESHOLDS);
		nan.fast.maxLines = Number.NaN;
		for (const [thresholds, named] of [
			[null, "thresholds"],
			[{}, "thresholds"],
			[{ fast: { maxLines: 300 }, rigorous: { minFiles: 61 } }, "thresholds"],
			[nan, "thresholds.fast.maxLines"],
		]) {
			const label = JSON.stringify(thresholds);
			expect
				.soft(() => classifyLane(valid, thresholds), label)
				.toThrow(TypeError);
			expect.soft(() => classifyLane(valid, thresholds), label).toThrow(named);
		}
	});
// S5 B41 (D17): the two S4 carry-overs.
	it("treats a dangling config link as broken and rejects a non-string broken", () => {
		const root = mkdtempSync(join(tmpdir(), "rpiv-lanes-"));
		roots.push(root);
		// A junction needs no privilege on Windows; Node ignores the type elsewhere.
		symlinkSync(join(root, "missing"), join(root, CONFIG), "junction");
		expect.soft(loadLaneThresholds(root)).toEqual({
			...structuredClone(DEFAULT_LANE_THRESHOLDS),
			broken: "dangling link",
		});

		const fastInput = {
			files: [{ path: "src/a.ts", added: 1, deleted: 0 }],
			slices: 1,
			hubs: [],
		};
		const withBroken = (broken) => ({ ...DEFAULT_LANE_THRESHOLDS, broken });
		expect.soft(() => classifyLane(fastInput, withBroken(5))).toThrow(TypeError);
		expect
			.soft(() => classifyLane(fastInput, withBroken(5)))
			.toThrow("thresholds.broken");
		expect.soft(classifyLane(fastInput, withBroken("x")).lane).toBe("normal");
	});
});
