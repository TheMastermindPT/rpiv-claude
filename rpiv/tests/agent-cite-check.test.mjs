// tests/agent-cite-check.test.mjs — contract tests for the collapse-detector
// proxies (scripts/agent-cite-check.mjs). Pure fs against a synthetic repo.
// Pins the three invariants:
//   - metrics count citations, basename rate, resolvability, quote rate
//   - violations fire only for agents with a citation contract and only when
//     thresholds are crossed
//   - agents without a contract (e.g. slice-verifier) are never judged

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	CONTRACTS,
	citeMetrics,
	violations,
} from "../scripts/agent-cite-check.mjs";

const tmp = mkdtempSync(join(tmpdir(), "agent-cite-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const repo = join(tmp, "repo");
mkdirSync(join(repo, "lib"), { recursive: true });
writeFileSync(join(repo, "lib", "a.ts"), "export const x = 1;\n");

describe("citeMetrics", () => {
	it("computes basename and resolvability rates", () => {
		const text =
			"lib/a.ts:1 | `export const x = 1;`\n" +
			"a.ts:2 | quote\n" +
			"lib/missing.ts:3 | quote\n";
		const m = citeMetrics(text, repo);
		expect(m.cites).toBe(3);
		expect(m.basenameRate).toBeCloseTo(1 / 3);
		expect(m.resolvableRate).toBeCloseTo(1 / 3);
		expect(m.quoteRate).toBeCloseTo(1 / 3);
	});

	it("returns nulls when there are no citations", () => {
		const m = citeMetrics("no citations here", repo);
		expect(m.cites).toBe(0);
		expect(m.basenameRate).toBeNull();
		expect(m.resolvableRate).toBeNull();
	});
});

describe("violations", () => {
	it("flags bare-basename cites above the entity-mapper threshold", () => {
		const m = {
			cites: 10,
			basenameRate: 0.5,
			resolvableRate: 0.5,
			quoteRate: 2,
		};
		const v = violations("entity-mapper", m);
		expect(v.some((s) => s.includes("bare-basename"))).toBe(true);
		expect(v.some((s) => s.includes("resolvability"))).toBe(true);
	});

	it("passes clean metrics", () => {
		const m = {
			cites: 10,
			basenameRate: 0.05,
			resolvableRate: 0.95,
			quoteRate: 2,
		};
		expect(violations("entity-mapper", m)).toEqual([]);
	});

	it("never judges agents without a contract or without citations", () => {
		expect(violations("slice-verifier", { cites: 5, basenameRate: 1 })).toEqual(
			[],
		);
		expect(violations("entity-mapper", { cites: 0 })).toEqual([]);
	});

	it("interaction-sweeper checks the verbatim-quote rate", () => {
		const m = {
			cites: 10,
			basenameRate: 0.05,
			resolvableRate: 0.95,
			quoteRate: 0.5,
		};
		const v = violations("interaction-sweeper", m);
		expect(v.some((s) => s.includes("verbatim-quote"))).toBe(true);
		expect(CONTRACTS["interaction-sweeper"].minQuoteRate).toBe(1);
	});
});
