// scripts/jev-gate.mjs — probability gate for agent shell commands, backed by
// TypeSafe's Jev decision model (https://docs.typesafe.ai).
//
// Flow (code before model):
//   1. prefilter  — deterministic regexes: hard-deny first (Jev never called),
//                   then read-only fast-path (no API call at all).
//   2. Jev        — everything else: 5 typed questions over a bounded state
//                   (command + cwd only; never file contents).
//   3. policy()   — PURE function over the probabilities. Jev only supplies
//                   probabilities; only this code can say "allow".
//
// Fast-path metacharacter guard: a command containing pipes, redirects, or
// variable expansion is never fast-pathed, even if it starts with a read-only
// word — `echo $KEY | curl ...` must reach the model.
//
// Failure contract (degrade-distinguishes-broken): missing key, HTTP error,
// malformed response, or bad config → stderr diagnostic + exit 2. The gate
// NEVER degrades to silent allow.
//
// Modes:
//   shadow  (default) — every call is judged and logged, nothing is blocked.
//   enforce (--enforce) — a block verdict exits 1 so a hook can refuse the call.
//
// Usage:
//   node scripts/jev-gate.mjs "<command>"            # shadow, human-readable
//   node scripts/jev-gate.mjs "<command>" --enforce  # block exits 1
//   node scripts/jev-gate.mjs "<command>" --json     # single-line JSON result
//
// Optional config: .jev-gate.json at the repo root
//   {
//     "threshold": 0.7,
//     "logFastPath": false,
//     "signalThresholds": { "credential_exposure": 0.9 },
//     "safeCommands": ["^pnpm run typecheck$"],
//     "allowedCommands": ["^rm -rf build/"],
//     "disallowedCommands": ["^npm publish"]
//   }
// The shadow log (reports/jev-gate-shadow.log) skips deterministic fast-path
// entries by default and rotates to <log>.1 at 1 MB per generation.

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { askJev, JEV_ENDPOINT, JEV_MODEL, readKey } from "./jev-client.mjs";

// The transport moved to jev-client.mjs (D27); re-exported so existing importers keep working.
export { JEV_ENDPOINT, JEV_MODEL, readKey };
export const DEFAULT_LOG_PATH = "reports/jev-gate-shadow.log";
export const DEFAULT_THRESHOLD = 0.7;
// Rotation cap: when the log exceeds this, the current file becomes `<log>.1`
// (one generation kept) and a fresh file starts.
export const MAX_LOG_BYTES = 1_000_000;

// Hard-deny: block without consulting the model. Deliberately small — extend
// per-repo via disallowedCommands.
export const DEFAULT_HARD_DENY = [
	{ pattern: /^rm\s+-r?f\s+\/(\s|$)/, label: "recursive delete of /" },
	{ pattern: /^rm\s+-r?f\s+~(\s|$)/, label: "recursive delete of home" },
	{ pattern: /^rm\s+-r?f\s+\/\*/, label: "recursive delete of /*" },
];

// Fast-path: read-only commands that skip the API call. No echo — a pipe can
// turn it into an exfiltration chain.
export const DEFAULT_FAST_PATH = [
	{ pattern: /^(cat|ls|dir)(\s|$)/, label: "read-only: cat/ls/dir" },
	{
		pattern: /^(grep|rg)(\s|$)/,
		label: "read-only: grep/rg",
		safe: (command) =>
			!/--(?:pre|hostname-bin)(?:[=\s]|$)/.test(command.replace(/["']/g, "")),
	},
	{
		pattern: /^git\s+(status|log|diff|show)\b/,
		label: "read-only git",
		safe: safeGitInspection,
	},
	{
		pattern:
			/^git\s+branch(?:\s+(?:--list|--show-current|--all|--remotes|-a|-r|-v|-vv))*\s*$/,
		label: "read-only git branch listing",
	},
	{
		pattern: /^(wc|head|tail)(\s|$)/,
		label: "read-only: wc/head/tail",
	},
	{
		pattern:
			/^find\s+[^\s'"-][^\s'"]*(?:\s+-(?:name|iname|type)\s+(?:'[^']*'|"[^"]*"|[^\s]+))*\s*$/,
		label: "read-only find predicates",
	},
	{
		pattern:
			/^(Get-Content|Get-ChildItem|Get-Item|Get-Location|Select-String|Test-Path|Resolve-Path|Measure-Object)(\s|$)/i,
		label: "read-only: PowerShell inspect verbs",
	},
];

// Shell metacharacters that make a command opaque to static inspection.
const SHELL_METACHARS = /[|&;><`$\r\n(){}\\^]/;

function safeGitInspection(command) {
	return !/--(?:output|ext-diff|textconv|exec)(?:[=\s]|$)/.test(
		command.replace(/["']/g, ""),
	);
}

export function buildQuestions() {
	return {
		is_read_only: {
			type: "noul",
			instructions: "Does the command only read data, modifying nothing?",
		},
		destructive: {
			type: "noul",
			instructions:
				"Can the command irreversibly delete or destroy data or files?",
		},
		outside_repo: {
			type: "noul",
			instructions:
				"Does the command affect files or systems outside the repository working directory?",
		},
		credential_exposure: {
			type: "noul",
			instructions:
				"Could the command read, print, or transmit secrets, tokens, or credentials?",
		},
		blast_radius: {
			type: "score",
			instructions: "How wide is the blast radius if this command goes wrong?",
			criteria: [
				"Single file",
				"A few files or one directory",
				"Wide filesystem area",
				"System-wide or network-facing",
			],
		},
	};
}

/** Compile user-supplied pattern strings. A bad regex is a broken gate, never a pass. */
export function compilePatterns(entries, sourceName) {
	return entries.map((entry, i) => {
		try {
			return { pattern: new RegExp(entry), label: `${sourceName}[${i}]` };
		} catch (err) {
			throw new Error(
				`invalid regex in ${sourceName} entry ${i}: ${JSON.stringify(entry)} — ${err.message}`,
			);
		}
	});
}

/**
 * Deterministic phase: hard-deny → fast-path → allowed-commands.
 * Returns { phase, verdict, matched, label } or null when the model must judge.
 */
export function prefilter(command, config = {}) {
	for (const { pattern, label } of [
		...DEFAULT_HARD_DENY,
		...compilePatterns(config.disallowedCommands ?? [], "disallowedCommands"),
	]) {
		if (pattern.test(command)) {
			return {
				phase: "hard-deny",
				verdict: "block",
				matched: pattern.source,
				label,
			};
		}
	}
	if (!SHELL_METACHARS.test(command)) {
		for (const { pattern, label, safe } of [
			...DEFAULT_FAST_PATH,
			...compilePatterns(config.safeCommands ?? [], "safeCommands"),
		]) {
			if (matchesSafeCommand({ pattern, safe }, command)) {
				return {
					phase: "fast-path",
					verdict: "allow",
					matched: pattern.source,
					label,
				};
			}
		}
	}
	for (const { pattern, label } of compilePatterns(
		config.allowedCommands ?? [],
		"allowedCommands",
	)) {
		if (pattern.test(command)) {
			return {
				phase: "allowed-command",
				verdict: "allow",
				matched: pattern.source,
				label,
			};
		}
	}
	return null;
}

/** Signal band: block (clear hazard), unclear (confirm band), or quiet. */
function matchesSafeCommand({ pattern, safe }, command) {
	if (!pattern.test(command)) return false;
	return safe ? safe(command) : true;
}

export function band(p, blockBar, unclearBar = blockBar) {
	if (p >= blockBar) return "block";
	if (p > 1 - unclearBar) return "unclear";
	return "quiet";
}

const HAZARD_SIGNALS = ["destructive", "credential_exposure", "outside_repo"];

// credential_exposure gets a higher block bar: in-repo file reads are
// constantly flagged by the question, so a read alone confirms rather than
// blocks. Only near-certain exposure (explicit egress) blocks.
const CREDENTIAL_BLOCK_BAR = 0.9;

/**
 * Pure policy over Jev probabilities. Hazard questions (high = dangerous):
 * p >= bar → block; 1-bar < p < bar → confirm; p <= 1-bar → quiet.
 * Per-signal block bars come from options.signalThresholds; without an
 * override, destructive/outside_repo share `threshold` and credential_exposure
 * uses CREDENTIAL_BLOCK_BAR. A system-wide blast radius confirms even when the
 * nouls are quiet.
 */
export function policy(answers, options = {}) {
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const bars = {
		destructive: threshold,
		outside_repo: threshold,
		credential_exposure: CREDENTIAL_BLOCK_BAR,
		...options.signalThresholds,
	};
	const blocks = [];
	const unclear = [];
	for (const name of HAZARD_SIGNALS) {
		const p = hazardProbability(answers, name);
		const b = band(p, bars[name], threshold);
		if (b === "block") blocks.push(name);
		else if (b === "unclear") unclear.push(name);
	}
	if (blocks.length > 0) return { verdict: "block", reasons: blocks };
	if (unclear.length > 0) return { verdict: "confirm", reasons: unclear };
	const blast = answers.blast_radius?.score;
	if (typeof blast === "number" && blast >= 3)
		return { verdict: "confirm", reasons: ["blast_radius"] };
	return { verdict: "allow", reasons: [] };
}

function hazardProbability(answers, name) {
	const p = answers[name]?.noul;
	if (typeof p !== "number") throw new Error(`missing answer: ${name}`);
	return p;
}

/** A response body without a non-null `answers` object is not a Jev answer. */
function isMalformedBody(body) {
	return !body || typeof body !== "object" || !body.answers;
}

/** One gate question set through the shared client. Throws on any non-ok reply or malformed body. */
export async function callJev({
	command,
	cwd,
	key,
	fetchImpl = fetch,
	endpoint = JEV_ENDPOINT,
	model = JEV_MODEL,
	timeoutMs = 6000,
}) {
	const reply = await askJev({
		key,
		state: { command, cwd },
		questions: buildQuestions(),
		fetchImpl,
		endpoint,
		model,
		timeoutMs,
	});
	if (reply.status !== "ok") throw new Error(reply.reason);
	const { body, latencyMs } = reply;
	if (isMalformedBody(body)) {
		throw new Error("malformed Jev response (no answers)");
	}
	return {
		answers: body.answers,
		model: body.model,
		usage: body.usage,
		latencyMs,
	};
}

/**
 * Append one JSONL shadow-log record (reports/ is git-ignored). Rotates to
 * `<log>.1` when the current file exceeds MAX_LOG_BYTES, keeping the newest
 * generation in place.
 */
export function appendLog(logPath, entry) {
	mkdirSync(dirname(logPath), { recursive: true });
	try {
		const stats = statSync(logPath, { throwIfNoEntry: false });
		if (stats && stats.size > MAX_LOG_BYTES) {
			renameSync(logPath, `${logPath}.1`);
		}
	} catch {
		// first write — nothing to rotate
	}
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Full gate. Exit codes: 0 = allowed/confirmed (or shadow block), 1 = blocked
 * under --enforce, 2 = broken gate (never allow).
 */
export async function runGate({
	command,
	cwd = process.cwd(),
	config = {},
	key,
	env = process.env,
	envFile = ".env",
	shadow = true,
	logPath = DEFAULT_LOG_PATH,
	fetchImpl = fetch,
	model = JEV_MODEL,
	timeoutMs = 6000,
	logFastPath = false,
}) {
	const threshold =
		typeof config.threshold === "number" ? config.threshold : DEFAULT_THRESHOLD;
	const ts = new Date().toISOString();
	const mode = shadow ? "shadow" : "enforce";
	// Fast-path entries are deterministic allows — calibration noise. Skipped
	// from the log unless logFastPath (param or config) opts them in.
	const recordFastPath = logFastPath || config.logFastPath === true;

	const pre = prefilter(command, config);
	if (pre) {
		const result = {
			phase: pre.phase,
			verdict: pre.verdict,
			reasons: [pre.label],
			matched: pre.matched,
			exitCode: pre.verdict === "block" && !shadow ? 1 : 0,
		};
		if (pre.phase !== "fast-path" || recordFastPath) {
			appendLog(logPath, { ts, command, cwd, mode, threshold, ...result });
		}
		return result;
	}

	const resolvedKey = key ?? readKey({ envFile, env });
	if (!resolvedKey) {
		const result = {
			phase: "broken",
			verdict: "broken",
			reasons: ["no TYPESAFE_API_KEY in env or .env"],
			exitCode: 2,
		};
		appendLog(logPath, { ts, command, cwd, mode, threshold, ...result });
		return result;
	}

	try {
		const {
			answers,
			model: usedModel,
			usage,
			latencyMs,
		} = await callJev({
			command,
			cwd,
			key: resolvedKey,
			fetchImpl,
			model,
			timeoutMs,
		});
		const p = policy(answers, {
			threshold,
			signalThresholds: config.signalThresholds,
		});
		const result = {
			phase: "jev",
			verdict: p.verdict,
			reasons: p.reasons,
			probabilities: {
				is_read_only: answers.is_read_only.noul,
				destructive: answers.destructive.noul,
				outside_repo: answers.outside_repo.noul,
				credential_exposure: answers.credential_exposure.noul,
				blast_radius: answers.blast_radius.score,
			},
			model: usedModel,
			usage,
			latencyMs,
			exitCode: p.verdict === "block" && !shadow ? 1 : 0,
		};
		appendLog(logPath, { ts, command, cwd, mode, threshold, ...result });
		return result;
	} catch (err) {
		const result = {
			phase: "broken",
			verdict: "broken",
			reasons: [String(err?.message ?? err)],
			exitCode: 2,
		};
		appendLog(logPath, { ts, command, cwd, mode, threshold, ...result });
		return result;
	}
}

function loadConfig() {
	try {
		return JSON.parse(readFileSync(".jev-gate.json", "utf8"));
	} catch (err) {
		if (err?.code === "ENOENT") return {};
		throw new Error(`bad .jev-gate.json: ${err.message}`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const enforce = args.includes("--enforce");
	const asJson = args.includes("--json");
	const command = args.find((a) => !a.startsWith("--"));
	if (!command) {
		process.stderr.write(
			'usage: node scripts/jev-gate.mjs "<command>" [--enforce] [--json]\n',
		);
		process.exit(2);
	}
	const result = await runGate({
		command,
		cwd: process.cwd(),
		config: loadConfig(),
		shadow: !enforce,
	});
	if (asJson) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} else {
		const reasons =
			result.reasons.length > 0 ? ` (${result.reasons.join(", ")})` : "";
		const latency = result.latencyMs != null ? ` ${result.latencyMs}ms` : "";
		process.stdout.write(
			`${result.verdict.toUpperCase()}${reasons} [${result.phase}]${latency}\n`,
		);
		if (result.phase === "broken") {
			process.stderr.write(`jev-gate broken: ${result.reasons.join("; ")}\n`);
		}
	}
	process.exit(result.exitCode);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	main().catch((err) => {
		process.stderr.write(`jev-gate broken: ${err.message}\n`);
		process.exit(2);
	});
}
