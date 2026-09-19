// tests/jev-rel-audit.test.mjs — contract tests for the relation auditor.
// No network: auditFindings runs through an injected fetch fake.
// Pins the invariants:
//   - the assembler parses depcruise and ast-grep outputs tolerantly
//   - the bundle curates the cited file's record (matches near the line only)
//   - ASYMMETRY OF EVIDENCE: findings with no record data get no-record,
//     never judged, never flagged
//   - bands: >= 0.7 ok, 0.3-0.7 uncertain, <= 0.3 flag
//   - broken calls are per-finding, never thrown

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	assembleRecord,
	auditFindings,
	bundleFor,
	fromAstGrep,
	fromDepcruise,
	judgeFinding,
} from "../scripts/jev-rel-audit.mjs";

const okJson = (body) => ({ ok: true, json: async () => body });
const jevP = (p) => ({ answers: { consistent: { noul: p } } });

const RECORD = {
	files: {
		"src/pages/api/checkout.ts": {
			inbound: ["src/lib/db/maintenance.ts"],
			outbound: ["src/lib/db/maintenance.ts", "src/lib/stripe.ts"],
			boundaries: ["src/lib/stripe.ts: not-in-allowed (depcruise)"],
			matches: [
				{
					line: 300,
					text: "await attachStripeSession(db, reference, session.sessionId, holdExpiresAt, now);",
				},
				{ line: 800, text: "unrelated far-away match" },
			],
			cochange: [],
			writers: 1,
		},
	},
};

const FINDINGS = [
	{
		id: "I1",
		text: "I1 — `await attachStripeSession(...)` — src/pages/api/checkout.ts:300 hold lifecycle race",
	},
	{ id: "Q9", text: "Q9 — `x` — src/elsewhere.ts:10 no record data" },
];

describe("assembler", () => {
	it("normalizes zero-based ast-grep locations before proximity selection", () => {
		const record = fromAstGrep([
			{ file: "src/a.ts", range: { start: { line: 0 } }, text: "near" },
			{ file: "src/a.ts", range: { start: { line: 100 } }, text: "far" },
		]);
		expect(record.files["src/a.ts"].matches.map((m) => m.line)).toEqual([
			1, 101,
		]);
		const bundle = bundleFor({ text: "src/a.ts:1" }, record);
		expect(bundle).toContain("1: near");
		expect(bundle).not.toContain("far");
	});
	it("parses depcruise modules into inbound/outbound/boundaries", () => {
		const input = {
			modules: [
				{
					source: "src/a.ts",
					dependencies: [
						{ resolved: "src/b.ts", valid: true },
						{
							resolved: "src/c.ts",
							valid: false,
							rules: [{ name: "not-in-allowed" }],
						},
					],
				},
			],
		};
		const { files } = fromDepcruise(input);
		expect(files["src/a.ts"].outbound).toEqual(["src/b.ts", "src/c.ts"]);
		expect(files["src/a.ts"].boundaries).toHaveLength(1);
		expect(files["src/b.ts"].inbound).toEqual(["src/a.ts"]);
	});

	it("parses ast-grep matches in array and envelope shapes", () => {
		expect(
			fromAstGrep([{ path: "src/x.ts", line: 5, text: "y" }]).files["src/x.ts"]
				.matches,
		).toHaveLength(1);
		expect(
			fromAstGrep({ matches: [{ file: "src/z.ts", line: 2, text: "w" }] })
				.files["src/z.ts"].matches,
		).toHaveLength(1);
	});

	it("assembles a combined record", () => {
		const record = assembleRecord({
			depcruise: { modules: [{ source: "src/a.ts", dependencies: [] }] },
			astgrep: [{ path: "src/b.ts", line: 1, text: "x" }],
		});
		expect(Object.keys(record.files)).toHaveLength(2);
	});
});

describe("bundleFor", () => {
	it("curates the cited file's record, near-line matches only", () => {
		const bundle = bundleFor(FINDINGS[0], RECORD);
		expect(bundle).toContain("inbound: src/lib/db/maintenance.ts");
		expect(bundle).toContain("boundary violations");
		expect(bundle).toContain("300: await attachStripeSession");
		expect(bundle).not.toContain("unrelated far-away match");
	});

	it("matches cited files by suffix", () => {
		const bundle = bundleFor(
			{ id: "X", text: "X — `y` — pages/api/checkout.ts:301 something" },
			RECORD,
		);
		expect(bundle).toContain("src/pages/api/checkout.ts");
	});

	it("returns null when no cited file has record data", () => {
		expect(bundleFor(FINDINGS[1], RECORD)).toBeNull();
	});
});

describe("auditFindings", () => {
	it("production CLI retains structured locations without citations in notes", () => {
		const dir = mkdtempSync(join(tmpdir(), "jev-rel-cli-"));
		try {
			writeFileSync(
				join(dir, "findings.json"),
				JSON.stringify([
					{
						id: "Q1",
						file: "src/pages/api/checkout.ts",
						line: 300,
						verbatim: "attachStripeSession",
						note: "hold lifecycle race",
					},
				]),
			);
			writeFileSync(join(dir, "record.json"), JSON.stringify(RECORD));
			const preload = `globalThis.fetch = async (_url, options) => { const body = JSON.parse(options.body); if (!body.state.record.includes('300: await attachStripeSession')) throw Error('missing location evidence'); return { ok: true, json: async () => ({answers:{consistent:{noul:0.9}}}) }; };`;
			const run = spawnSync(
				process.execPath,
				[
					"--import",
					`data:text/javascript,${encodeURIComponent(preload)}`,
					fileURLToPath(
						new URL("../scripts/jev-rel-audit.mjs", import.meta.url),
					),
					"--findings",
					"findings.json",
					"--record",
					"record.json",
					"--out",
					"out.json",
				],
				{
					cwd: dir,
					env: { ...process.env, TYPESAFE_API_KEY: "test-only" },
					encoding: "utf8",
				},
			);
			expect(run.status, run.stderr).toBe(0);
			expect(
				JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).results,
			).toEqual([{ id: "Q1", p: 0.9, verdict: "ok" }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("enforces the asymmetry rule: no-record findings are never judged", async () => {
		let called = false;
		const results = await auditFindings({
			findings: FINDINGS,
			record: RECORD,
			key: "k",
			fetchImpl: async () => {
				called = true;
				return okJson(jevP(0.9));
			},
		});
		expect(called).toBe(true); // one judged, one skipped
		expect(results.find((r) => r.id === "I1").verdict).toBe("ok");
		expect(results.find((r) => r.id === "Q9").verdict).toBe("no-record");
	});

	it("bands mid and low probabilities", async () => {
		let calls = 0;
		const results = await auditFindings({
			findings: [FINDINGS[0]],
			record: RECORD,
			key: "k",
			fetchImpl: async () => okJson(jevP(calls++ === 0 ? 0.5 : 0.2)),
		});
		// single finding -> single call; check judgeFinding directly for bands
		const mid = await judgeFinding({
			finding: FINDINGS[0],
			bundle: "record",
			key: "k",
			fetchImpl: async () => okJson(jevP(0.5)),
		});
		const low = await judgeFinding({
			finding: FINDINGS[0],
			bundle: "record",
			key: "k",
			fetchImpl: async () => okJson(jevP(0.2)),
		});
		expect(mid.verdict).toBe("uncertain");
		expect(low.verdict).toBe("flag");
		expect(results).toHaveLength(1);
	});

	it("broken calls are per-finding, never thrown", async () => {
		const results = await auditFindings({
			findings: [FINDINGS[0]],
			record: RECORD,
			key: "k",
			fetchImpl: async () => {
				throw new Error("down");
			},
		});
		expect(results[0].broken).toBe("down");
	});
});
