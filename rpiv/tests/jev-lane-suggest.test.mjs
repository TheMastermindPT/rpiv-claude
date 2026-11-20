// scripts/jev-lane-suggest.mjs — Jev's fast/normal suggestion for a slice, shown with
// the question that confirms a fast slice. Jev reads the slice's behaviors (contract
// text, never code) and its paths; the developer decides.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { suggestLane } from "../scripts/jev-lane-suggest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts/jev-lane-suggest.mjs");

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const BRIEF = `# Design

### Test Contract: s1-refund

- **Behavior B1**: A refund deletes only the booking row it refunds.
  - Example: bookings [A, B], refund A -> bookings [B].
- **Behavior B2**: A refund of an unknown booking changes nothing.

### Test Contract: s2-other

- **Behavior B9**: Not this slice.
`;

/** A fetch stub that records the request and answers with `answers`. */
const jevAnswering = (answers) => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push(JSON.parse(init.body));
		return { ok: true, json: async () => ({ model: "jev-test", answers }) };
	};
	return { calls, fetchImpl };
};

const FACTORS_NO = {
	touches_security: { noul: 0 },
	handles_money: { noul: 0 },
	changes_stored_data: { noul: 0 },
	changes_build_or_startup: { noul: 0 },
	changes_shared_interface: { noul: 0 },
};

const suggest = (fetchImpl, extra = {}) =>
	suggestLane({
		briefText: BRIEF,
		slice: "s1-refund",
		paths: ["src/payments/refund.ts"],
		key: "k",
		fetchImpl,
		branch: "feat/x",
		...extra,
	});

describe("suggestLane", () => {
	it("sends the slice's behaviors and paths, never code, and reads a normal answer with its reasons", async () => {
		const jev = jevAnswering({
			...FACTORS_NO,
			lane_risk: { score: 0.97, confidence: 0.94 },
			handles_money: { noul: 0.9 },
			changes_stored_data: { noul: 0.7 },
		});
		const result = await suggest(jev.fetchImpl);
		expect(result).toMatchObject({
			status: "ok",
			lane: "normal",
			why: ["handles money", "changes stored data"],
			confidence: 0.94,
		});
		const [request] = jev.calls;
		expect(request.state).toEqual({
			branch: "feat/x",
			slice: "s1-refund",
			behaviors: [
				"B1: A refund deletes only the booking row it refunds.",
				"Example: bookings [A, B], refund A -> bookings [B].",
				"B2: A refund of an unknown booking changes nothing.",
			],
			files: ["src/payments/refund.ts"],
		});
		expect(request.questions.lane_risk.type).toBe("score");
		expect(request.questions.lane_risk.criteria).toHaveLength(2);
		expect(result.row).toMatchObject({
			kind: "suggest",
			slice: "s1-refund",
			paths: ["src/payments/refund.ts"],
			status: "ok",
			jevLane: "normal",
		});
	});

	it("reads a low score as fast with no risk factor", async () => {
		const jev = jevAnswering({
			...FACTORS_NO,
			lane_risk: { score: 0, confidence: 1 },
		});
		expect(await suggest(jev.fetchImpl)).toMatchObject({
			status: "ok",
			lane: "fast",
			why: [],
		});
	});

	it("is unavailable without a key, and never calls Jev", async () => {
		const jev = jevAnswering({});
		const result = await suggest(jev.fetchImpl, { key: null });
		expect(result.status).toBe("unavailable");
		expect(result.reason).toMatch(/TYPESAFE_API_KEY/);
		expect(jev.calls).toHaveLength(0);
		expect(result.row.status).toBe("unavailable");
	});

	it("is broken, never a lane, for a malformed answer or a slice the brief does not hold", async () => {
		const bad = jevAnswering({ ...FACTORS_NO, lane_risk: { score: 7 } });
		expect(await suggest(bad.fetchImpl)).toMatchObject({
			status: "broken",
			reason: "malformed answer: lane_risk",
		});
		const missing = await suggest(jevAnswering({}).fetchImpl, {
			slice: "s9-none",
		});
		expect(missing.status).toBe("broken");
		expect(missing.reason).toMatch(/s9-none/);
	});
});

describe("jev-lane-suggest CLI", () => {
	it("says unavailable, never silent, without a key, and logs the row", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-jev-suggest-"));
		dirs.push(dir);
		spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
		writeFileSync(join(dir, "brief.md"), BRIEF);
		const env = { ...process.env, TYPESAFE_API_KEY: "" };
		const res = spawnSync(
			process.execPath,
			[CLI, "--brief", "brief.md", "--slice", "s1-refund", "--", "src/payments/refund.ts"],
			{ cwd: dir, env, encoding: "utf-8" },
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/^jev-lane: unavailable: no TYPESAFE_API_KEY/);
		const log = readFileSync(join(dir, ".rpiv/logs/jev-lane-shadow.log"), "utf-8");
		expect(JSON.parse(log.trim().split("\n").at(-1))).toMatchObject({
			kind: "suggest",
			status: "unavailable",
			slice: "s1-refund",
		});
	});

	it("is broken for a bad call", () => {
		const res = spawnSync(process.execPath, [CLI, "--slice", "s1"], {
			encoding: "utf-8",
		});
		expect(res.status).toBe(2);
		expect(res.stderr).toMatch(/^jev-lane: broken: /);
	});
});
