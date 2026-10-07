// scripts/jev-client.mjs — the one Jev transport (D27 of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
//
// Owns the key lookup, endpoint, model and the bounded POST. Transport only: callers keep
// their own questions, timeouts, answer checks and result shapes. askJev never throws — every
// outcome is one of three, so a caller can never mistake a failed call for an answer
// (degrade-distinguishes-broken):
//   { status: "ok", body, latencyMs }      parsed body, unchecked
//   { status: "unavailable", reason }      no key; fetch never called
//   { status: "broken", reason }           fetch rejected or timed out, HTTP not ok, bad JSON

import { readFileSync } from "node:fs";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// Pinned deliberately: the bands and thresholds in this repo are tuned against
// jev-1.13.0. `jev-latest` moves when a release ships, which would silently
// shift every calibrated threshold. Move versions on our own schedule.
export const JEV_MODEL = "jev-1.13.0";

// The one owner of the no-key text (shared-vocab-union); callers keep their own no-key
// mapping (unavailable or broken) but quote this reason.
export const NO_KEY_REASON = "no TYPESAFE_API_KEY in env or .env";

/** Key resolution: TYPESAFE_API_KEY env var wins, then the .env file. Never prints. */
export function readKey({ envFile = ".env", env = process.env } = {}) {
	const fromEnv = env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const match = readFileSync(envFile, "utf8").match(
			/^TYPESAFE_API_KEY=(.+)$/m,
		);
		return match?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

/** One bounded Jev request. Never throws; see the header for the three outcomes. */
export async function askJev({
	key,
	state,
	questions,
	fetchImpl = fetch,
	endpoint = JEV_ENDPOINT,
	model = JEV_MODEL,
	timeoutMs,
}) {
	if (key != null && typeof key !== "string") {
		return {
			status: "broken",
			reason: `Jev key is not a string (${typeof key})`,
		};
	}
	if (!key?.trim()) return { status: "unavailable", reason: NO_KEY_REASON };
	try {
		const t0 = performance.now();
		const res = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model, state, questions }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const latencyMs = Math.round(performance.now() - t0);
		if (!res.ok)
			return {
				status: "broken",
				reason: `HTTP ${res.status} from Jev endpoint`,
			};
		return { status: "ok", body: await res.json(), latencyMs };
	} catch (err) {
		return { status: "broken", reason: String(err?.message ?? err) };
	}
}
