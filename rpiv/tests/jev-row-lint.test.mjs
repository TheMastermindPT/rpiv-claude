// tests/jev-row-lint.test.mjs — contract tests for scripts/jev-row-lint.mjs.
// No network: lintRow/lintAgentOutput run through injected fetch fakes.
// Pins the framework invariants:
//   - every ROW_LINTS entry extracts its rows and ignores prose
//   - bands: p >= 0.7 ok, 0.3-0.7 review, p <= 0.3 flag
//   - contracts resolve from the table OR from the reference file at runtime
//   - a broken gate is loud and per-row, never a silent pass

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	extractConstituentIds,
	FLAG_BAR,
	lintAgentOutput,
	lintRow,
	OK_BAR,
	parseConstituentFindings,
	parseRows,
	ROW_LINTS,
	readReferenceTable,
} from "../scripts/jev-row-lint.mjs";

const tmp = mkdtempSync(join(tmpdir(), "jev-row-lint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const okJson = (body) => ({ ok: true, json: async () => body });
const jevConsistent = (p) => ({ answers: { consistent: { noul: p } } });

describe("parseRows", () => {
	it("claim-verifier rows extract id, tag, justification", () => {
		const rows = parseRows(
			"prose\nFINDING Q1 | Verified | `src/a.mjs:12` matches.\nFINDING S2 | Falsified | no `danger` at src/c.mjs:9.\n",
			ROW_LINTS["claim-verifier"],
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: "Q1", tag: "Verified" });
		expect(rows[1].text).toContain("src/c.mjs:9");
	});

	it("slice-verifier rows extract category, verdict, detail", () => {
		const rows = parseRows(
			"- Decisions: VIOLATION: store.mjs export contract - missing `initStore` - design line 78\n- Cross-slice: OK\n- Research: WARNING: knip flags LoadClampEvent - never imported by name\n",
			ROW_LINTS["slice-verifier"],
		);
		expect(rows.map((r) => r.id)).toEqual([
			"Decisions",
			"Cross-slice",
			"Research",
		]);
		expect(rows.map((r) => r.tag)).toEqual(["VIOLATION", "OK", "WARNING"]);
		expect(rows[0].text).toContain("missing `initStore`");
	});

	it("diff-analyst rows extract file:line, surface number, note, and quote", () => {
		const rows = parseRows(
			"src/a.mjs:12 | `const x = 1;` | 3 | consumer at src/b.mjs:40 breaks\nother prose\n",
			ROW_LINTS["diff-analyst"],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: "src/a.mjs:12", tag: "3" });
		expect(rows[0].extra).toBe("`const x = 1;`");
		expect(rows[0].text).toContain("consumer");
	});

	it("interaction-sweeper IX blocks capture the body and derive the kind", () => {
		const text = `## Interaction Sweep — target

### IX-1 — The unit system has no owner

- **Kind:** shared-root
- **Constituents:** L2-04, L3-01
- **Evidence:**
  - \`lib/a.ts:12\` — \`const x = 1;\`
  - \`lib/b.ts:40\` — \`const y = 2;\`

### IX-2 — second compound

- **Kind:** masking
- **Constituents:** L1-01
`;
		const rows = parseRows(text, ROW_LINTS["interaction-sweeper"]);
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe("IX-1");
		expect(rows[0].tag).toBe("shared-root");
		expect(rows[0].text).toContain("lib/a.ts:12");
		expect(rows[1].id).toBe("IX-2");
		expect(rows[1].text).not.toContain("IX-1");
	});

	it("constituent ids ignore co-change suffixes", () => {
		const ids = extractConstituentIds(
			"- **Constituents:** X4, X1, M2 (via co-change `a.ts -> b.ts` conf 1.00)",
			/\*\*Constituents:\*\*\s*(.+)$/m,
		);
		expect(ids).toEqual(["X4", "X1", "M2"]);
	});

	it("parseConstituentFindings maps ids to stated defect rows", () => {
		const prompt =
			"X1 | Lc | lib/db/body-metrics.ts:16 | `type ExistingBodyMetricKey = Pick<` | Med | mutation-input assembly mixed with dedup-key derivation\nM3 | D | supabase/migrations/m.sql:5 | `SET search_path = public` | Med | trigger intent restated\n";
		const map = parseConstituentFindings(prompt);
		expect(map.get("X1")).toContain("body-metrics.ts:16");
		expect(map.get("M3")).toContain("search_path");
		expect(map.size).toBe(2);
	});

	it("six-column table rows extract severity as the tag, skipping headers", () => {
		const text = `| plan-loc | codebase-loc | severity | dimension | finding | recommendation |
| --- | --- | --- | --- | --- | --- |
| Slice 2 (Test Contract) | tests/config.test.ts:24 | concern | test-contract | The default-input test checks object presence | Assert the approved default values |
| Slice 2 | src/a.ts:1 | blocker | code-quality | missing import breaks the build | Import the shared type |
`;
		const rows = parseRows(text, ROW_LINTS["artifact-code-reviewer"]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			tag: "concern",
			id: "Slice 2 (Test Contract)",
		});
		expect(rows[1].tag).toBe("blocker");
		expect(rows[1].extra).toBe("src/a.ts:1");
	});
});

describe("readReferenceTable", () => {
	it("parses numbered **Name** — description lines from a reference file", () => {
		const path = join(tmp, "surfaces.md");
		writeFileSync(
			path,
			"1. **Logic & flow** (always) — validation, error paths.\n3. **Blast radius** (hubs) — consumer changes.\n",
		);
		const table = readReferenceTable(path, tmp);
		expect(table.get("1")).toContain("Logic & flow");
		expect(table.get("3")).toContain("Blast radius");
	});

	it("returns null for missing or unparseable files", () => {
		expect(readReferenceTable(join(tmp, "nope.md"), tmp)).toBeNull();
		const empty = join(tmp, "empty.md");
		writeFileSync(empty, "no numbered surfaces here");
		expect(readReferenceTable(empty, tmp)).toBeNull();
	});

	it("key-bullets format parses severity-style contracts", () => {
		const path = join(tmp, "severity.md");
		writeFileSync(
			path,
			"- `blocker`: a concrete path prevents correct execution.\n- `concern`: a grounded weakness.\n",
		);
		const table = readReferenceTable(path, tmp, "key-bullets");
		expect(table.get("blocker")).toContain("correct execution");
		expect(table.get("concern")).toContain("grounded");
	});
});

describe("lintRow", () => {
	const config = ROW_LINTS["claim-verifier"];
	const base = {
		row: { id: "Q1", tag: "Verified", text: "src/a.mjs:12 matches" },
		config,
		contract: "quote matches at the cited file:line",
		key: "k",
	};

	it("high probability is ok", async () => {
		const r = await lintRow({
			...base,
			fetchImpl: async () => okJson(jevConsistent(0.9)),
		});
		expect(r).toMatchObject({ id: "Q1", verdict: "ok" });
		expect(r.p).toBeGreaterThanOrEqual(OK_BAR);
	});

	it("low probability is flagged", async () => {
		const r = await lintRow({
			...base,
			fetchImpl: async () => okJson(jevConsistent(0.2)),
		});
		expect(r).toMatchObject({ id: "Q1", verdict: "flag" });
		expect(r.p).toBeLessThanOrEqual(FLAG_BAR);
	});

	it("the middle band is review", async () => {
		const r = await lintRow({
			...base,
			fetchImpl: async () => okJson(jevConsistent(0.5)),
		});
		expect(r.verdict).toBe("review");
	});

	it("a broken call becomes a per-row broken result, not a throw", async () => {
		const r = await lintRow({
			...base,
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		expect(r).toMatchObject({ id: "Q1", broken: "network down" });
	});

	it("per-instance band overrides shift the verdicts", async () => {
		const cfg = { ...ROW_LINTS["claim-verifier"], okBar: 0.9, flagBar: 0.6 };
		const r = await lintRow({
			...base,
			config: cfg,
			fetchImpl: async () => okJson(jevConsistent(0.8)),
		});
		expect(r.verdict).toBe("review");
	});

	it("the state carries the row, its contract, and the config question", async () => {
		let captured;
		await lintRow({
			...base,
			fetchImpl: async (_url, opts) => {
				captured = JSON.parse(opts.body);
				return okJson(jevConsistent(0.8));
			},
		});
		expect(captured.state.contract).toContain("quote matches");
		expect(captured.state.row).toContain("tag=Verified");
		expect(captured.questions.consistent.type).toBe("noul");
	});

	it("optional code-in-state is included when supplied", async () => {
		let captured;
		await lintRow({
			...base,
			code: "const x = 1;",
			fetchImpl: async (_url, opts) => {
				captured = JSON.parse(opts.body);
				return okJson(jevConsistent(0.8));
			},
		});
		expect(captured.state.code).toBe("const x = 1;");
	});
});

describe("lintAgentOutput", () => {
	it("fans out one judgment per row", async () => {
		const seen = [];
		const text =
			"FINDING Q1 | Verified | src/a.mjs:12 matches.\nFINDING Q2 | Falsified | nothing found at src/b.mjs:9.\n";
		const { results, unavailable } = await lintAgentOutput(
			ROW_LINTS["claim-verifier"],
			text,
			{
				key: "k",
				fetchImpl: async (_url, opts) => {
					seen.push(JSON.parse(opts.body).state.row);
					return okJson(jevConsistent(0.9));
				},
			},
		);
		expect(unavailable).toBeNull();
		expect(seen).toHaveLength(2);
		expect(results.map((r) => r.id)).toEqual(["Q1", "Q2"]);
	});

	it("reports unavailable distinctly when no key is configured", async () => {
		const { results, unavailable } = await lintAgentOutput(
			ROW_LINTS["claim-verifier"],
			"FINDING Q1 | Verified | x",
			{
				envFile: "__nonexistent__.env",
				env: {},
			},
		);
		expect(results).toEqual([]);
		expect(unavailable).toMatch(/TYPESAFE_API_KEY/);
	});

	it("empty output is a clean no-op, not an unavailable gate", async () => {
		const { results, unavailable } = await lintAgentOutput(
			ROW_LINTS["claim-verifier"],
			"",
			{ envFile: "__nonexistent__.env", env: {} },
		);
		expect(results).toEqual([]);
		expect(unavailable).toBeNull();
	});

	it("rows whose contract cannot be resolved are per-row broken, not silent", async () => {
		const { results, unavailable } = await lintAgentOutput(
			ROW_LINTS["slice-verifier"],
			"- Decisions: OK\n- Cross-slice: MYSTERYVERDICT: something odd\n",
			{ key: "k", fetchImpl: async () => okJson(jevConsistent(0.9)) },
		);
		expect(unavailable).toBeNull();
		const odd = results.find((r) => r.tag === "MYSTERYVERDICT");
		expect(odd.broken).toMatch(/no contract/);
	});

	it("constituent-aware rows are skipped loudly when the prompt is absent", async () => {
		const text =
			"### IX-1 — headline\n\n- **Kind:** shared-root\n- **Constituents:** X4, X1\n";
		const { results, unavailable } = await lintAgentOutput(
			ROW_LINTS["interaction-sweeper"],
			text,
			{ key: "k", fetchImpl: async () => okJson(jevConsistent(0.9)) },
		);
		expect(unavailable).toBeNull();
		expect(results).toHaveLength(1);
		expect(results[0].broken).toMatch(/no dispatch prompt/);
	});

	it("constituent-aware rows judge with the stated defects in state", async () => {
		const text =
			"### IX-1 — headline\n\n- **Kind:** shared-root\n- **Constituents:** X4, X1\n";
		const constituents = new Map([
			[
				"X4",
				"X4 | D | supabase/migrations/m.sql:5 | `SET search_path = public` | trigger intent restated",
			],
			[
				"X1",
				"X1 | Lc | lib/db/body-metrics.ts:16 | `type ExistingBodyMetricKey = Pick<` | mutation-input assembly mixed with dedup-key derivation",
			],
		]);
		const captured = [];
		const { results } = await lintAgentOutput(
			ROW_LINTS["interaction-sweeper"],
			text,
			{
				key: "k",
				constituents,
				fetchImpl: async (_url, opts) => {
					const body = JSON.parse(opts.body);
					captured.push(body.state);
					return okJson(jevConsistent(0.9));
				},
			},
		);
		expect(results).toHaveLength(1);
		expect(results[0].verdict).toBe("ok");
		expect(captured[0].constituent_findings).toContain("body-metrics.ts:16");
		expect(captured[0].constituent_findings).toContain("search_path");
		expect(captured[0].compound_block).toContain("IX-1");
	});

	it("missing constituent ids mark the row broken", async () => {
		const text =
			"### IX-1 — headline\n\n- **Kind:** shared-root\n- **Constituents:** X4, ZZZ9\n";
		const constituents = new Map([
			["X4", "X4 | D | a.sql:5 | `SET` | restated"],
		]);
		const { results } = await lintAgentOutput(
			ROW_LINTS["interaction-sweeper"],
			text,
			{
				key: "k",
				constituents,
				fetchImpl: async () => okJson(jevConsistent(0.9)),
			},
		);
		expect(results[0].broken).toMatch(/ZZZ9/);
	});

	it("diff-analyst resolves surface definitions from the reference file", async () => {
		const surfaces = join(tmp, "quality-surfaces.md");
		writeFileSync(surfaces, "3. **Blast radius** (hubs) — consumer changes.\n");
		const config = {
			...ROW_LINTS["diff-analyst"],
			reference: {
				...ROW_LINTS["diff-analyst"].reference,
				path: "quality-surfaces.md",
			},
		};
		const captured = [];
		const { results } = await lintAgentOutput(
			config,
			"src/a.mjs:12 | `x` | 3 | consumer at src/b.mjs:40 breaks\n",
			{
				key: "k",
				cwd: tmp,
				fetchImpl: async (_url, opts) => {
					const body = JSON.parse(opts.body);
					captured.push(body.state.contract);
					return okJson(jevConsistent(0.9));
				},
			},
		);
		expect(results).toHaveLength(1);
		expect(captured[0]).toContain("Blast radius");
	});
});
