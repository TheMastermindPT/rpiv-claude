// chain-handoff-restore.mjs — SessionStart hook (matcher `clear`) that shows the
// pending chain step after `/clear` (S17-chain-handoff, D37). A pipeline skill
// writes `<git-dir>/rpiv/handoff.json` with skills/_shared/handoff.mjs as it ends
// its stage; this hook reads the file of the event's worktree once, prints a short
// summary as `hookSpecificOutput.additionalContext`, and renames the file to
// `handoff.consumed.json`, so a later `/clear` shows nothing. A chain stage that
// starts first retires the file instead (chain-handoff-retire.mjs, S31).
//
// Absent is silent: no repository, or no handoff, prints nothing. Broken is
// distinct (degrade-distinguishes-broken): an unreadable handoff prints
// `[rpiv-hook] handoff unreadable: <why>` and moves to `handoff.broken.json`; a hook
// that cannot look prints `[rpiv-hook] handoff not checked: <why>`. Never blocks;
// always exits 0.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { contentHashOf } from "../../skills/_shared/validate-artifact.mjs";
import { sanitizeForContext } from "./_shared.mjs";
import { limitGitTime, runGit } from "./_git-branch.mjs";

const EVENT = "SessionStart";
// git's answer for a directory in no repository (LC_ALL=C).
const OUTSIDE = "not a git repository";

class Unreadable extends Error {}

/** The worktree's absolute git dir for `dir`, or null outside a repository;
    any other git failure throws. */
function gitDirOf(dir) {
	const res = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	if (res.error) throw new Error(`git could not run (${res.error})`);
	if (res.status === 0) return res.out;
	if (res.err.includes(OUTSIDE)) return null;
	throw new Error(`git refused ${dir}: ${res.err.split("\n")[0]}`);
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasText = (value) => typeof value === "string" && value !== "";
const textOrNull = (value) => value == null || typeof value === "string";
const isArtifact = (a) => a == null || (isRecord(a) && hasText(a.path) && typeof a.content_hash === "string");
const isDecisions = (d) => d === undefined || (Array.isArray(d) && d.every((x) => typeof x === "string"));
const malformed = (field) => [(rec) => textOrNull(rec[field]), () => `${field} is malformed`];

// What a record must hold before it is trusted, in order: [holds, why not]
// (S17 revision 1: every field the summary prints).
const RECORD_CHECKS = [
	[isRecord, () => "not an object"],
	[(rec) => rec.v === 1, (rec) => `unknown version ${rec.v}`],
	[(rec) => hasText(rec.next), () => "next is missing"],
	[(rec) => isArtifact(rec.artifact), () => "artifact is malformed"],
	[(rec) => isDecisions(rec.decisions), () => "decisions is malformed"],
	...["slice", "lane", "branch", "time"].map(malformed),
];

/** The handoff record in `text`; a shape this hook cannot trust throws Unreadable. */
function parseRecord(text) {
	let rec;
	try {
		rec = JSON.parse(text);
	} catch {
		throw new Unreadable("invalid JSON");
	}
	const failed = RECORD_CHECKS.find(([holds]) => !holds(rec));
	if (failed) throw new Unreadable(failed[1](rec));
	return rec;
}

/** How the handoff's artifact stands now: "changed", "missing", or null (as
    written, or no artifact). Paths are relative to the worktree's top level. */
function artifactDrift(rec, top) {
	if (!rec.artifact) return null;
	const path = join(top, rec.artifact.path);
	if (!existsSync(path)) return "missing";
	return contentHashOf(readFileSync(path, "utf-8")) === rec.artifact.content_hash ? null : "changed";
}

/** The context lines for a handoff record. */
function summary(rec, drift) {
	const safe = (value) => sanitizeForContext(value ?? "none");
	const artifact = rec.artifact
		? `${safe(rec.artifact.path)} (content_hash ${safe(rec.artifact.content_hash).slice(0, 12)})`
		: "none";
	const head =
		drift === null
			? `[rpiv] Pending step (handoff from ${safe(rec.time)}):`
			: `[rpiv] Stale handoff (artifact ${drift} since ${safe(rec.time)}):`;
	return [
		head,
		`next: ${safe(rec.next)}`,
		`artifact: ${artifact}`,
		`slice: ${safe(rec.slice)}`,
		`lane: ${safe(rec.lane)}`,
		`branch: ${safe(rec.branch)}`,
		...(Array.isArray(rec.decisions) ? rec.decisions : []).map((d) => `open decision: ${safe(d)}`),
	];
}

/** The context to show for `dir`'s worktree, or null when nothing is pending. */
function pending(dir) {
	const gitDir = gitDirOf(dir);
	if (gitDir === null) return null;
	const path = `${gitDir}/rpiv/handoff.json`;
	if (!existsSync(path)) return null;
	let rec;
	try {
		rec = parseRecord(readFileSync(path, "utf-8"));
	} catch (err) {
		renameSync(path, `${gitDir}/rpiv/handoff.broken.json`);
		const why = err instanceof Unreadable ? err.message : `cannot read (${err.code ?? err.message})`;
		return `[rpiv-hook] handoff unreadable: ${sanitizeForContext(why)}`;
	}
	// Build everything first: a handoff that cannot be shown is never consumed.
	const context = summary(rec, artifactDrift(rec, topOf(dir))).join("\n");
	renameSync(path, `${gitDir}/rpiv/handoff.consumed.json`);
	return context;
}

/** The worktree's top level; a failed read throws (never an empty path). */
function topOf(dir) {
	const res = runGit(dir, ["rev-parse", "--show-toplevel"]);
	if (res.error) throw new Error(`git could not run (${res.error})`);
	if (res.status !== 0) throw new Error(`git refused ${dir}: ${res.err.split("\n")[0]}`);
	return res.out;
}

/** The context for this event: pending, broken, or null. */
function contextFor(stdin) {
	let event;
	try {
		event = JSON.parse(stdin);
	} catch {
		return "[rpiv-hook] handoff not checked: the hook event is not valid JSON";
	}
	try {
		return pending(event?.cwd ?? process.cwd());
	} catch (err) {
		return `[rpiv-hook] handoff not checked: ${sanitizeForContext(err?.message ?? err)}`;
	}
}

/** The event text; an unreadable stdin is a "not checked" answer, never a crash. */
function readStdin() {
	try {
		return { text: readFileSync(0, "utf-8") };
	} catch (err) {
		const why = sanitizeForContext(err?.code ?? err?.message);
		return { problem: `[rpiv-hook] handoff not checked: cannot read the hook event (${why})` };
	}
}

function main() {
	limitGitTime(6_000);
	const stdin = readStdin();
	const context = stdin.problem ?? contextFor(stdin.text);
	if (context === null) return;
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT, additionalContext: context } }),
	);
}

main();
