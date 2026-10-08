// scripts/jev-lane.mjs — the Jev lane shadow (S8-jev-lane-shadow, D38). A
// PostToolUse hook (Bash, PowerShell, Claude Code only) that notices a successful
// `lane.mjs` run, asks Jev for a would-be lane of the same change, and appends both
// to `<repository top>/.rpiv/logs/jev-lane-shadow.log`. It never changes the lane:
// the printed lane is lane.mjs's alone (FR4 shadow mode). A call whose arguments the
// shell computes is logged `skipped`, never guessed. Each row keeps the paths it
// measured, so scripts/jev-lane-labels.mjs can join developer labels (S30).
//
// What Jev sees (FR4: never source code): the branch, the mode, the slice count
// and up to 200 repo-relative file paths. One call (jev-client.mjs, 6 s): a Score
// `lane_risk` with three levels described as situations, plus five atomic Nouls —
// the Jev docs advise a Score for an ordered scale (a Choice has no order and
// jev-1.13 leans to its first option) and atomic questions composed in code.
//
// Output: nothing on ok or unavailable (no key); on a broken call or a malformed
// answer, `hookSpecificOutput.additionalContext` `[jev-lane] BROKEN: <reason> —
// shadow lane not compared`. Every outcome is logged; the hook always exits 0.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isMain } from "../skills/_shared/is-main.mjs";

// The hook runs after every Bash and PowerShell call: the lane classifier, the Jev
// client and the log writer load only for a lane.mjs call (S8 revision 1).

// Under the project's `.rpiv/` (git-ignored by rpiv projects), so the log is never a
// changed file that `lane.mjs --working` counts (S8 revision 1).
export const LANE_LOG_PATH = ".rpiv/logs/jev-lane-shadow.log";
// The hook's own git reads share one budget, beside the 6 s Jev call inside the
// 10 s hook timeout (S8 revision 2; lane.mjs's file listing runs its own git).
const GIT_BUDGET_MS = 2_500;
const gitDeadline = Date.now() + GIT_BUDGET_MS;

/** git's `{ status, out }` in `cwd`; a git that cannot run, times out or has no
    budget left throws. */
function gitIn(cwd, args) {
	const left = gitDeadline - Date.now();
	if (left <= 0) throw new Error("git reads took too long");
	const res = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true, timeout: left });
	if (res.error) throw new Error(`git could not run (${res.error.code ?? res.error.message})`);
	return { status: res.status, out: (res.stdout ?? "").trim() };
}

/** The top level of the repository holding `cwd` (`cwd` itself outside one). */
function topOf(cwd) {
	const res = gitIn(cwd, ["rev-parse", "--show-toplevel"]);
	return res.status === 0 ? res.out : cwd;
}

/** The log of the repository holding `cwd`. */
const logPathFor = (cwd) => resolve(topOf(cwd), LANE_LOG_PATH);

/** `input` with absolute `--paths` values made repository-relative: Jev only
    ever sees paths inside the project (FR4, S8 revision 1). */
export function repoRelative(input, cwd) {
	// --range and --working list paths from git, already relative to the top;
	// --paths values are as typed, relative to the cwd (S8 revision 2).
	if (input.mode !== "paths") return input;
	const top = topOf(cwd);
	const rel = (p) => relative(top, resolve(cwd, p)).replaceAll("\\", "/");
	return { ...input, files: input.files.map(rel) };
}
const TIMEOUT_MS = 6_000;
export const MAX_FILES = 200;

// D38's ordered levels, as situations (Jev scores each level on its own).
export const LANE_LEVELS = [
	"Docs, tests, or a small edit inside one module; no shared interface, data, security, build or review-gate impact",
	"An ordinary feature or fix across a few modules or a shared helper; no security, data migration, CI or review-gate impact",
	"Touches authentication, permissions or secrets, data migrations, CI or release configuration, review gates, or a widely used interface",
];
// D38's atomic factors, each asked about the listed `files`.
const FACTORS = {
	touches_security: "Do the paths in `files` touch authentication, permissions, secrets or other security code?",
	changes_data_or_migration: "Do the paths in `files` change stored data, a database schema or a migration?",
	changes_build_or_ci: "Do the paths in `files` change build, CI, release or packaging configuration?",
	changes_shared_interface: "Do the paths in `files` change an interface or helper that many other modules use?",
	docs_or_tests_only: "Are the paths in `files` only documentation or tests?",
};

const QUESTIONS = {
	lane_risk: {
		type: "score",
		instructions: "How much review risk does a change to the paths in `files` carry?",
		criteria: LANE_LEVELS,
	},
	...Object.fromEntries(
		Object.entries(FACTORS).map(([id, instructions]) => [id, { type: "noul", instructions }]),
	),
};

/** The would-be lane for a `lane_risk` score (D38 cut-offs). */
export const laneOfScore = (score) => (score < 0.5 ? "fast" : score < 1.5 ? "normal" : "rigorous");

const SHELL_MODES = { Bash: "bash", PowerShell: "ps" };
const MODE_OPTIONS = new Set(["--range", "--working", "--paths"]);
const isLaneScript = (word) => /(^|[\\/])lane\.mjs$/.test(word);
// A redirection the tokenizer leaves among the words (`2>&1`, `>out`).
const isRedirect = (word) => /^\d?>/.test(word);

/** The argument words after a `lane.mjs` word in one segment's words when
    they hold a mode option anywhere (lane.mjs reads options in any order, S8
    revision 2), or null. */
function argsIn(words) {
	const at = words.findIndex((w) => isLaneScript(w.value));
	if (at < 0) return null;
	const rest = words.slice(at + 1);
	const end = rest.findIndex((w) => isRedirect(w.value));
	const args = end < 0 ? rest : rest.slice(0, end);
	return args.some((w) => MODE_OPTIONS.has(w.value)) ? args : null;
}

/** The `lane.mjs` call in `command`, read with the approval hook's shell
    tokenizer (segments end at `;`, `&&`, `|`, newlines): the last segment that
    runs lane.mjs with a mode, as `{ argv, computed }` — `computed` when the shell
    fills any argument in at run time, so its text is not what lane.mjs saw
    (S8 revision 2). Null when no segment runs lane.mjs. */
export async function laneArgs(command, toolName = "Bash") {
	const { isComputed, tokenize } = await import("../.claude/hooks/approve-outward-actions.mjs");
	const segments = tokenize(String(command), SHELL_MODES[toolName] ?? "bash");
	const words = segments.map((s) => argsIn(s.words)).filter((a) => a !== null).at(-1);
	if (words === undefined) return null;
	return { argv: words.map((w) => w.value), computed: words.some(isComputed) };
}

/** The branch checked out in `cwd`, or null when HEAD is detached (git's quiet
    exit 1); any other git failure throws, never reads as detached (S8 revision 1). */
function branchOf(cwd) {
	const res = gitIn(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (res.status === 0) return res.out;
	if (res.status === 1) return null;
	throw new Error(`git symbolic-ref failed (exit ${res.status})`);
}

const isBetween = (value, top) => typeof value === "number" && value >= 0 && value <= top;

/** `value` when it is a number in [0, top]; otherwise a malformed answer `id` throws. */
function inRange(value, top, id) {
	if (isBetween(value, top)) return value;
	throw new Error(`malformed answer: ${id}`);
}

/** Jev's answers checked against the questions; a malformed one throws. */
function readAnswers(body) {
	const answers = body?.answers ?? {};
	const risk = answers.lane_risk;
	const score = inRange(risk?.score, LANE_LEVELS.length - 1, "lane_risk");
	const factors = Object.fromEntries(
		Object.keys(FACTORS).map((id) => [id, inRange(answers[id]?.noul, 1, id)]),
	);
	return { score, confidence: risk.confidence, probabilities: risk.probabilities, factors };
}

/** The lane lane.mjs printed: its first stdout line, or undefined. */
const printedLane = (event) =>
	String(event?.tool_response?.stdout ?? "")
		.split(/\r?\n/)[0]
		.match(/^lane: (fast|normal|rigorous)$/)?.[1];

/** `{ lane, argv, computed }` of a successful lane.mjs run in `event`, or null
    for any other command. Only the first stdout line is lane.mjs's answer (S8
    revision 1). */
async function laneCall(event) {
	const lane = printedLane(event);
	const command = String(event.tool_input?.command ?? "");
	if (!lane || !command.includes("lane.mjs")) return null;
	const call = await laneArgs(command, event.tool_name);
	return call === null ? null : { lane, ...call };
}

/** The log row fields for Jev's reply; a malformed answer keeps the change's
    `base` fields (S8 revision 1). */
function replyRow(base, reply) {
	if (reply.status !== "ok") return { ...base, status: reply.status, reason: reply.reason };
	let read;
	try {
		read = readAnswers(reply.body);
	} catch (err) {
		return { ...base, status: "broken", reason: err.message };
	}
	return {
		...base,
		status: "ok",
		jevLane: laneOfScore(read.score),
		...read,
		model: reply.body?.model ?? null,
		latencyMs: reply.latencyMs,
	};
}

/** The log row for one lane.mjs run, or null when `event` is not one. */
async function shadow(event) {
	const cwd = event.cwd ?? process.cwd();
	const call = await laneCall(event);
	if (call === null) return null;
	const { lane, argv, computed } = call;
	// The shell's values are not the command's text: never shadow a guess (S8 rev. 2).
	if (computed)
		return { row: { ts: new Date().toISOString(), lane, status: "skipped", reason: "computed lane.mjs arguments" } };
	const { laneInput } = await import("../skills/_shared/lane.mjs");
	const { askJev, readKey } = await import("./jev-client.mjs");
	const input = repoRelative(laneInput(argv, cwd), cwd);
	const base = {
		ts: new Date().toISOString(),
		branch: branchOf(cwd),
		mode: input.mode,
		slices: input.slices ?? null,
		files: input.files.length,
		// The paths Jev is sent, so a developer label can join this row (S30 rev. 1).
		paths: input.files.slice(0, MAX_FILES),
		lane,
	};
	const state = {
		branch: base.branch,
		mode: input.mode,
		slices: input.slices ?? null,
		files: input.files.slice(0, MAX_FILES),
		files_total: input.files.length,
	};
	const reply = await askJev({ key: readKey(), state, questions: QUESTIONS, timeoutMs: TIMEOUT_MS });
	return { row: replyRow(base, reply) };
}

const context = (text) =>
	JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
const brokenLine = (reason) => `[jev-lane] BROKEN: ${reason} — shadow lane not compared`;
const broken = (reason) => context(brokenLine(reason));

/** The hook event, or `{ problem }` naming why it cannot be used: an unreadable
    stdin and invalid JSON are told apart (S8 revision 1). */
function readEvent() {
	let text;
	try {
		text = readFileSync(0, "utf-8");
	} catch (err) {
		return { problem: `the hook event cannot be read (${err?.code ?? err?.message})` };
	}
	try {
		return { event: JSON.parse(text) };
	} catch {
		return { problem: "the hook event is not valid JSON" };
	}
}

async function main() {
	const { event, problem } = readEvent();
	if (problem) {
		process.stdout.write(broken(problem));
		return;
	}
	let outcome;
	try {
		outcome = await shadow(event);
	} catch (err) {
		// Every row keeps the lane lane.mjs printed (S8 revision 2).
		const lane = printedLane(event) ?? null;
		outcome = { row: { ts: new Date().toISOString(), lane, status: "broken", reason: String(err?.message ?? err) } };
	}
	if (outcome === null) return;
	const lines = [];
	if (outcome.row.status === "broken") lines.push(brokenLine(outcome.row.reason));
	try {
		const { appendLog } = await import("./jev-gate.mjs");
		appendLog(logPathFor(event.cwd ?? process.cwd()), outcome.row);
	} catch (err) {
		// A row that could not be written is said, never a silent ok (S8 revision 1);
		// a broken reason stays visible beside it (S8 revision 2).
		lines.push(`[jev-lane] LOG UNAVAILABLE: ${err?.code ?? err?.message} — shadow lane not logged`);
	}
	if (lines.length > 0) process.stdout.write(context(lines.join("\n")));
}

if (isMain(import.meta.url)) {
	main().catch(() => {});
}
