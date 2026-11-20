// scripts/jev-lane-suggest.mjs — Jev's fast/normal suggestion for one slice, shown to
// the developer with the question that confirms a fast slice (candidate-workflow.md
// **Lanes**). The developer decides; Jev only suggests.
//
// What Jev sees: the slice's behaviors as the contract states them (plain text, never
// source code), the slice's paths and the branch. One call (jev-client.mjs): a two-level
// Score `lane_risk` (fast, normal) plus atomic Nouls whose "yes" answers are the reasons.
//
// CLI, run only as the entry point:
//   node jev-lane-suggest.mjs --brief <brief.md> --slice <slice-id> -- <path>...
// Prints `jev-lane: fast|normal`, `why: <reasons>|no risk factor`, `confidence: <n>`
// (exit 0); `jev-lane: unavailable: <reason>` when there is no key (exit 0, said, never
// silent); a broken call or answer prints `jev-lane: broken: <detail>` on stderr and
// exits 2, never a lane. Every outcome is appended to the shadow log, joinable by
// jev-lane-labels.mjs on the same paths.
//
// Importable: suggestLane (Jev injectable through `fetchImpl`).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain } from "../skills/_shared/is-main.mjs";
import { contractSections } from "../skills/_shared/test-contract.mjs";
import { askJev, readKey } from "./jev-client.mjs";
import { LANE_LOG_PATH, MAX_FILES } from "./jev-lane.mjs";

const TIMEOUT_MS = 6_000;

// The two lanes, as situations (Jev scores each level on its own).
const LEVELS = [
	"A small, self-contained change: docs, tests, styling or a local edit whose mistakes stay visible and cheap to fix",
	"A change whose mistakes could reach users or data unnoticed: security, money, stored data, startup or configuration, shared interfaces, or behavior across several modules",
];

const ABOUT = "the change described by `behaviors` and `files`";
// Each factor's question and the reason it gives when Jev answers yes.
const FACTORS = {
	touches_security: ["touch authentication, permissions, secrets or other security code", "touches security"],
	handles_money: ["handle payments, prices, fees or refunds", "handles money"],
	changes_stored_data: ["change stored data, a database schema or a migration", "changes stored data"],
	changes_build_or_startup: ["change build, CI, release, packaging, app startup or configuration", "changes build, startup or configuration"],
	changes_shared_interface: ["change an interface or helper that many other modules use", "changes a shared interface"],
};

const QUESTIONS = {
	lane_risk: {
		type: "score",
		instructions: `How much review does ${ABOUT} need?`,
		criteria: LEVELS,
	},
	...Object.fromEntries(
		Object.entries(FACTORS).map(([id, [asks]]) => [
			id,
			{ type: "noul", instructions: `Does ${ABOUT} ${asks}?` },
		]),
	),
};

/** The slice's behavior and example lines, markdown emphasis removed; throws when the
    brief holds no Test Contract for `slice` or it has no behaviors. */
export function sliceBehaviors(briefText, slice) {
	const section = contractSections(briefText).find((s) => s.id === slice);
	if (!section) throw new Error(`no \`Test Contract: ${slice}\` section in the brief`);
	const lines = section.body
		.map(({ line }) => line)
		.filter((line) => /^- \*\*|^\s+- Example:/.test(line))
		.map((line) => line.replace(/^\s*- /, "").replaceAll("**", "").replace(/^Behavior /, "").trim());
	if (lines.length === 0) throw new Error(`\`Test Contract: ${slice}\` has no behaviors`);
	return lines;
}

const isBetween = (value, top) => typeof value === "number" && value >= 0 && value <= top;

const inRange = (value, top, id) => {
	if (isBetween(value, top)) return value;
	throw new Error(`malformed answer: ${id}`);
};

/** `{ lane, score, confidence, factors, why }` from Jev's answers; a malformed one throws. */
function readAnswers(body) {
	const answers = body?.answers ?? {};
	const score = inRange(answers.lane_risk?.score, LEVELS.length - 1, "lane_risk");
	const factors = Object.fromEntries(
		Object.keys(FACTORS).map((id) => [id, inRange(answers[id]?.noul, 1, id)]),
	);
	const why = Object.entries(factors)
		.filter(([, p]) => p >= 0.5)
		.map(([id]) => FACTORS[id][1]);
	return {
		lane: score < 0.5 ? "fast" : "normal",
		score,
		confidence: answers.lane_risk.confidence ?? null,
		factors,
		why,
	};
}

/** Jev's suggestion for one slice: `{ status: "ok", lane, why, confidence, row }`,
    `{ status: "unavailable" | "broken", reason, row }`. Never throws. `paths` are
    repository-relative; `row` is the shadow-log entry. */
export async function suggestLane({ briefText, slice, paths, key, fetchImpl = fetch, branch = null }) {
	const kept = paths.slice(0, MAX_FILES);
	const base = {
		ts: new Date().toISOString(),
		kind: "suggest",
		branch,
		mode: "paths",
		slice,
		files: paths.length,
		paths: kept,
		lane: null,
	};
	const fail = (status, reason) => ({ status, reason, row: { ...base, status, reason } });
	let behaviors;
	try {
		behaviors = sliceBehaviors(briefText, slice);
	} catch (err) {
		return fail("broken", err.message);
	}
	const state = { branch, slice, behaviors, files: kept };
	const reply = await askJev({ key, state, questions: QUESTIONS, fetchImpl, timeoutMs: TIMEOUT_MS });
	if (reply.status !== "ok") return fail(reply.status, reply.reason);
	let read;
	try {
		read = readAnswers(reply.body);
	} catch (err) {
		return fail("broken", err.message);
	}
	const { lane, why, confidence } = read;
	return {
		status: "ok",
		lane,
		why,
		confidence,
		row: { ...base, status: "ok", jevLane: lane, ...read, model: reply.body?.model ?? null, latencyMs: reply.latencyMs },
	};
}

// ---- CLI -----------------------------------------------------------------------------

const USAGE = "usage: jev-lane-suggest.mjs --brief <brief.md> --slice <slice-id> -- <path>...";
const OPTIONS = new Set(["--brief", "--slice"]);

/** The options before `--`, as `{ brief, slice }`; an unknown or valueless one throws. */
function optionsOf(head) {
	const opts = {};
	for (let i = 0; i < head.length; i += 2) {
		const [flag, value] = [head[i], head[i + 1]];
		if (!OPTIONS.has(flag) || !value) throw new Error(`unexpected argument: ${flag}`);
		opts[flag.slice(2)] = value;
	}
	return opts;
}

/** `{ brief, slice, paths }` of a call; a bad call throws. */
function parseArgs(argv) {
	const split = argv.indexOf("--");
	if (split === -1) throw new Error(USAGE);
	const { brief, slice } = optionsOf(argv.slice(0, split));
	const paths = argv.slice(split + 1);
	if (![brief, slice].every(Boolean) || paths.length === 0) throw new Error(USAGE);
	return { brief, slice, paths };
}

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });

/** The repository top of `cwd` (`cwd` itself outside one) and its branch, or null. */
function repoOf(cwd) {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.status !== 0) return { top: cwd, branch: null };
	const branch = git(cwd, ["branch", "--show-current"]).stdout.trim() || null;
	return { top: top.stdout.trim(), branch };
}

function outputOf(result) {
	if (result.status === "unavailable") return `jev-lane: unavailable: ${result.reason}\n`;
	const why = result.why.length ? result.why.join("; ") : "no risk factor";
	return `jev-lane: ${result.lane}\nwhy: ${why}\nconfidence: ${result.confidence}\n`;
}

async function main() {
	const cwd = process.cwd();
	const { brief, slice, paths: typed } = parseArgs(process.argv.slice(2));
	const briefText = readFileSync(resolve(cwd, brief), "utf-8");
	const { laneInput } = await import("../skills/_shared/lane.mjs");
	const { repoRelative } = await import("./jev-lane.mjs");
	// The same measuring chain as a label, so jev-lane-labels joins this row.
	const paths = repoRelative(laneInput(["--paths", ...typed], cwd), cwd).files;
	const { top, branch } = repoOf(cwd);
	const result = await suggestLane({ briefText, slice, paths, key: readKey(), branch });
	const { appendLog } = await import("./jev-gate.mjs");
	appendLog(resolve(top, LANE_LOG_PATH), result.row);
	if (result.status === "broken") throw new Error(result.reason);
	process.stdout.write(outputOf(result));
}

if (isMain(import.meta.url)) {
	main().catch((err) => {
		process.stderr.write(`jev-lane: broken: ${String(err?.message ?? err).split("\n")[0]}\n`);
		process.exitCode = 2;
	});
}
