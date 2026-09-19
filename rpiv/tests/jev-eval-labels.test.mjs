// tests/jev-eval-labels.test.mjs — contract tests for
// scripts/jev-eval-labels.mjs. No network: processEvalRoot runs through an
// injected fetch fake against a synthetic run tree.
// Pins the three invariants:
//   - only outputs whose agent has a ROW_LINTS entry are linted
//   - every linted row lands in the log with a `source` marker
//   - re-runs are idempotent (processed sources are skipped)

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	detectAgent,
	findOutputs,
	processEvalRoot,
	processedSources,
	resolveCasePrompt,
} from "../scripts/jev-eval-labels.mjs";

const tmp = mkdtempSync(join(require("node:os").tmpdir(), "jev-eval-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const okJson = (body) => ({ ok: true, json: async () => body });
const jevConsistent = (p) => ({ answers: { consistent: { noul: p } } });

function seedTree() {
	const svDir = join(tmp, "SV-1", "baseline", "outputs");
	mkdirSync(svDir, { recursive: true });
	writeFileSync(
		join(svDir, "agent-output.md"),
		"- Decisions: VIOLATION: export contract - `initStore` missing - line 78\n- Cross-slice: OK\n",
	);
	const drDir = join(tmp, "DR-1", "run-1", "outputs");
	mkdirSync(drDir, { recursive: true });
	writeFileSync(join(drDir, "agent-output.md"), "no rows here");
	return { svDir, drDir };
}

describe("detection and discovery", () => {
	it("detects agents from path markers", () => {
		expect(
			detectAgent("C:/x/skill-evals/SV-1/baseline/outputs/agent-output.md"),
		).toBe("slice-verifier");
		expect(
			detectAgent(
				"C:/x/skill-evals/eval-IS-2/with_skill/outputs/agent-output.md",
			),
		).toBe("interaction-sweeper");
		expect(
			detectAgent("C:/x/skill-evals/eval-EM-1/outputs/agent-output.md"),
		).toBe("entity-mapper");
		expect(
			detectAgent("C:/x/skill-evals/eval-AR-1/outputs/agent-output.md"),
		).toBeNull();
	});

	it("finds outputs recursively under the root", () => {
		seedTree();
		const files = findOutputs(tmp);
		expect(files).toHaveLength(2);
		expect(files.every((f) => f.endsWith("agent-output.md"))).toBe(true);
	});
});

describe("processEvalRoot", () => {
	const deps = () => ({
		key: "k",
		fetchImpl: async () => okJson(jevConsistent(0.9)),
	});

	it("lints only matching agents and tags every row with a source", async () => {
		const { svDir } = seedTree();
		const logPath = join(tmp, "lint.log");
		const summary = await processEvalRoot({
			root: tmp,
			logPath,
			...deps(),
		});
		expect(summary.scanned).toBe(2);
		expect(summary.linted).toBe(1);
		expect(summary.unmatched).toBe(1);
		expect(summary.rows).toBe(2);
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			const entry = JSON.parse(line);
			expect(entry.source).toContain(svDir);
			expect(entry.agent).toBe("slice-verifier");
			expect(typeof entry.p).toBe("number");
		}
	});

	it("is idempotent: processed sources are skipped on re-run", async () => {
		const logPath = join(tmp, "lint2.log");
		const first = await processEvalRoot({ root: tmp, logPath, ...deps() });
		const second = await processEvalRoot({ root: tmp, logPath, ...deps() });
		expect(first.linted).toBe(1);
		expect(second.linted).toBe(0);
		expect(second.skipped).toBe(1);
		expect(readFileSync(logPath, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("records broken calls per row instead of failing the scan", async () => {
		const logPath = join(tmp, "lint3.log");
		const summary = await processEvalRoot({
			root: tmp,
			logPath,
			key: "k",
			fetchImpl: async () => {
				throw new Error("down");
			},
		});
		expect(summary.linted).toBe(1);
		const entries = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(entries.every((e) => e.broken === "down")).toBe(true);
	});

	it("processedSources reads only entries carrying a source", () => {
		const sources = processedSources([
			{ source: "a" },
			{ verdict: "flag" },
			{ source: "b" },
		]);
		expect([...sources]).toEqual(["a", "b"]);
	});

	it("resolveCasePrompt maps IS case dirs to their prompt file", () => {
		const promptRoot = join(tmp, "prompts");
		mkdirSync(join(promptRoot, "evals", "cases", "interaction-sweeper"), {
			recursive: true,
		});
		writeFileSync(
			join(
				promptRoot,
				"evals",
				"cases",
				"interaction-sweeper",
				"IS-2.prompt.md",
			),
			"X1 | Lc | a.ts:1 | `x` | Med | one line\n",
		);
		for (const source of [
			"archive/IS-2-v1-overgrouping-evidence/with_skill/outputs/agent-output.md",
			"iteration-1/eval-IS-2/with_skill/run-1/outputs/agent-output.md",
		]) {
			expect(resolveCasePrompt(source, promptRoot)).toContain("one line");
		}
		expect(
			resolveCasePrompt(
				"iteration-1/eval-SV-1/outputs/agent-output.md",
				promptRoot,
			),
		).toBeNull();
	});
});
