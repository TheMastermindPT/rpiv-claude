// tests/jev-client.test.mjs — contract tests for the shared Jev transport client in
// scripts/jev-client.mjs (slice S7-jev-client, D27, B98–B102 and B104, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// No network: every call goes through an injected fetchImpl.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import * as client from "../scripts/jev-client.mjs";
import * as gate from "../scripts/jev-gate.mjs";
import { lintRow, ROW_LINTS } from "../scripts/jev-row-lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "jev-client-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const okJson = (body) => ({ ok: true, json: async () => body });
const http503 = async () => ({ ok: false, status: 503 });
const HTTP_503 = "HTTP 503 from Jev endpoint";

/** A fetchImpl that records its calls and answers with `answer`. */
const recording = (answer) => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return answer();
	};
	return { calls, fetchImpl };
};

const request = {
	state: { a: 1 },
	questions: { q: { type: "noul" } },
	timeoutMs: 1000,
};

describe("S7 Jev client (B98–B101)", () => {
	it("sends one Jev request and returns the parsed body", async () => {
		const answer = { answers: { q: { noul: 0.4 } } };
		const { calls, fetchImpl } = recording(() => okJson(answer));
		const r = await client.askJev({ key: "k", ...request, fetchImpl });
		expect(calls).toHaveLength(1);
		const [{ url, opts }] = calls;
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(opts.method).toBe("POST");
		expect(opts.headers).toEqual({
			Authorization: "Bearer k",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(opts.body)).toEqual({
			model: "jev-1.13.0",
			state: { a: 1 },
			questions: { q: { type: "noul" } },
		});
		expect(opts.signal).toBeInstanceOf(AbortSignal);
		expect(r.status).toBe("ok");
		expect(r.body).toEqual(answer);
		expect(Number.isInteger(r.latencyMs)).toBe(true);
		expect(r.latencyMs).toBeGreaterThanOrEqual(0);

		const other = recording(() => okJson({}));
		const o = await client.askJev({
			key: "k",
			...request,
			endpoint: "https://e/x",
			model: "m",
			fetchImpl: other.fetchImpl,
		});
		expect(other.calls[0].url).toBe("https://e/x");
		expect(JSON.parse(other.calls[0].opts.body).model).toBe("m");
		expect(o).toMatchObject({ status: "ok", body: {} });
	});

	it("reports a missing key as unavailable without calling fetch", async () => {
		for (const key of [null, undefined, "", "   "]) {
			const { calls, fetchImpl } = recording(() => okJson({}));
			expect(await client.askJev({ key, ...request, fetchImpl })).toEqual({
				status: "unavailable",
				reason: "no TYPESAFE_API_KEY in env or .env",
			});
			expect(calls).toHaveLength(0);
		}
	});

	it("reports failed calls as broken without throwing", async () => {
		const ask = (fetchImpl, timeoutMs = 1000) =>
			client.askJev({ key: "k", ...request, timeoutMs, fetchImpl });
		expect(await ask(http503)).toEqual({ status: "broken", reason: HTTP_503 });
		expect(
			await ask(async () => {
				throw new Error("boom");
			}),
		).toEqual({ status: "broken", reason: "boom" });
		expect(await ask(() => Promise.reject("x"))).toEqual({
			status: "broken",
			reason: "x",
		});
		expect(
			await ask(async () => ({
				ok: true,
				json: async () => {
					throw new SyntaxError("bad json");
				},
			})),
		).toEqual({ status: "broken", reason: "bad json" });

		const started = Date.now();
		const hung = await ask(
			(_url, opts) =>
				new Promise((_resolve, reject) => {
					opts.signal.addEventListener("abort", () =>
						reject(new Error("aborted after timeout")),
					);
				}),
			20,
		);
		expect(hung.status).toBe("broken");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("owns readKey, endpoint and model, re-exported by the gate", () => {
		expect(client.JEV_ENDPOINT).toBe("https://api.typesafe.ai/v1/systemone");
		expect(client.JEV_MODEL).toBe("jev-1.13.0");
		expect(typeof client.readKey).toBe("function");
		expect(gate.readKey).toBe(client.readKey);
		expect(gate.JEV_ENDPOINT).toBe(client.JEV_ENDPOINT);
		expect(gate.JEV_MODEL).toBe(client.JEV_MODEL);

		const missing = join(tmp, "missing.env");
		expect(
			client.readKey({ env: { TYPESAFE_API_KEY: " k " }, envFile: missing }),
		).toBe("k");
		const envFile = join(tmp, "key.env");
		writeFileSync(envFile, "X=1\nTYPESAFE_API_KEY=f \n");
		expect(client.readKey({ env: {}, envFile })).toBe("f");
		expect(client.readKey({ env: {}, envFile: missing })).toBe(null);
	});
});

// Grows by one file per S7 commit (D27): each listed caller sends through the client only.
const MIGRATED = ["scripts/jev-gate.mjs", "scripts/jev-row-lint.mjs"];

describe("S7 callers send through the client (B102)", () => {
	it.each(MIGRATED)(
		"sends Jev requests only through the client: %s",
		(file) => {
			const source = readFileSync(join(ROOT, file), "utf-8");
			expect(source).toContain("askJev(");
			expect(source).toMatch(
				/from "(?:\.\/|\.\.\/\.\.\/scripts\/)jev-client\.mjs"/,
			);
			expect(source).not.toContain("AbortSignal.timeout(");
			expect(source).not.toContain("Bearer ");
		},
	);
});

describe("S7 callers keep their broken shapes (B104)", () => {
	it("each caller reports an HTTP failure in its own broken shape: gate", async () => {
		const r = await gate.runGate({
			command: "curl https://example.com",
			key: "k",
			fetchImpl: http503,
			logPath: join(tmp, "gate.log"),
		});
		expect(r).toMatchObject({ verdict: "broken", exitCode: 2 });
		expect(r.reasons).toContain(HTTP_503);
	});

	it("each caller reports an HTTP failure in its own broken shape: row-lint", async () => {
		const r = await lintRow({
			row: { id: "Q1", tag: "Verified", text: "src/a.mjs:12 matches" },
			config: ROW_LINTS["claim-verifier"],
			contract: "quote matches at the cited file:line",
			key: "k",
			fetchImpl: http503,
		});
		expect(r).toMatchObject({ id: "Q1", tag: "Verified", broken: HTTP_503 });
	});
});
