// cosmic-ray.mjs — read a Cosmic Ray session for mutation.mjs (FR14; D52–D55 of the
// Python-support design, S8-cosmic-ray). The session is read only through `cosmic-ray
// dump <session>`, run from the project root's own `.venv` (its stable output, never its
// SQLite schema); rpiv never runs `cosmic-ray exec`, which rewrites source files on disk.
//
// One dump line per job: `[{job_id, mutations: [{module_path, …}]}, result | null]`, where
// a result's `test_outcome` is `killed`, `survived` or `incompetent`. `killed` and
// `survived` count as in Stryker; `incompetent` is counted apart and never in the score;
// a job with a null result is not run. A session that cannot show survivors is never read
// as zero survivors: all jobs incompetent, any job not run, or no job at all each have
// their own state, and none prints rows (degrade-distinguishes-broken).
//
// Importable-only: no CLI, no isMain.
// Importable: COSMIC_SESSIONS, cosmicSession, dumpSession, readCosmicDump, cosmicLines.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { COSMIC_SESSIONS } from "../../_shared/source-vocab.mjs";
import { venvTool } from "./import-contracts.mjs";

// The session file names are owned by source-vocab.mjs (shared-vocab-union).
export { COSMIC_SESSIONS };

/** The first session file at `root`, by name, or "". */
export const cosmicSession = (root) =>
	COSMIC_SESSIONS.find((name) => existsSync(join(root, name))) ?? "";

/** `cosmic-ray dump` of the session through the root's `.venv`: `{ text }`, or
    `{ broken }` with the reason (no cosmic-ray, or the dump failed). */
export const dumpSession = (root, session) => {
	const tool = venvTool(root, "cosmic-ray");
	if (!tool) return { broken: `cosmic-ray not installed in ${root}/.venv (session ${session})` };
	const res = spawnSync(tool, ["dump", session], {
		cwd: root,
		encoding: "utf-8",
		timeout: 120_000,
		maxBuffer: 256 * 1024 * 1024,
	});
	if (res.error) return { parseError: String(res.error.message).split("\n")[0] };
	if (res.status !== 0) {
		const why = String(res.stderr ?? "").trim().split(/\r?\n/).at(-1);
		return { parseError: `dump exited ${res.status}${why ? `: ${why}` : ""}` };
	}
	return { text: res.stdout };
};

const toPosix = (path) => path.replaceAll("\\", "/");

/** A job's file, relative to the run folder: `module_path` read against the root. */
const fileOf = (job, { root, relOf }) => {
	const path = toPosix(String(job?.mutations?.[0]?.module_path ?? ""));
	if (!path) return "";
	return relOf(toPosix(isAbsolute(path) ? path : join(root, path)));
};

const OUTCOMES = new Set(["killed", "survived", "incompetent"]);

/** Count one job into `files` (by path) and `totals`. */
const countJob = (result, file, files, totals) => {
	if (result === null) {
		totals.pending += 1;
		return;
	}
	const outcome = OUTCOMES.has(result?.test_outcome) ? result.test_outcome : "incompetent";
	totals[outcome] += 1;
	if (!file) return;
	const row = files.get(file) ?? { f: file, killed: 0, survived: 0, incompetent: 0 };
	row[outcome] += 1;
	files.set(file, row);
};

/** One dump's state, totals and rows under the target. `ctx` holds `root`, `relOf` and
    `underAny`. State: ok, all-incompetent, incomplete, empty or parse-error. */
export const readCosmicDump = (text, ctx) => {
	const totals = { jobs: 0, killed: 0, survived: 0, incompetent: 0, pending: 0 };
	const files = new Map();
	for (const line of String(text ?? "").split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			return { state: "parse-error", why: `dump line ${totals.jobs + 1} is not JSON`, totals };
		}
		if (!Array.isArray(entry)) return { state: "parse-error", why: `dump line ${totals.jobs + 1} is not a job`, totals };
		totals.jobs += 1;
		const file = fileOf(entry[0], ctx);
		countJob(entry[1] ?? null, ctx.underAny(file) ? file : "", files, totals);
	}
	const rows = [...files.values()].map((row) => ({ ...row, score: scoreOf(row.killed, row.survived) }));
	rows.sort((a, b) => a.score - b.score || b.survived - a.survived);
	return { state: stateOf(totals), totals, rows };
};

const scoreOf = (killed, survived) => (killed + survived > 0 ? Math.round((killed / (killed + survived)) * 100) : 0);

const stateOf = ({ jobs, killed, survived, pending }) => {
	if (jobs === 0) return "empty";
	if (pending > 0) return "incomplete";
	if (killed + survived === 0) return "all-incompetent";
	return "ok";
};

/** The report line's note for a state that prints no rows. */
const NOTES = {
	empty: () => "empty",
	incomplete: ({ totals }) => `incomplete — ${totals.pending} of ${totals.jobs} jobs not run`,
	"all-incompetent": ({ totals }) => `all-incompetent — ${totals.jobs} jobs; the test command never ran`,
	"parse-error": ({ why }) => `parse-error: ${why}`,
};

/** mutation.mjs's `mutation_report:` and `mutation_overall:` lines for a read session,
    and its rows; a state other than ok has the report line only. */
export const cosmicLines = (result, session) => {
	if (result.state !== "ok")
		return { head: [`mutation_report: cosmic-ray ${session} (${NOTES[result.state](result)})`], rows: [] };
	const { killed, survived, incompetent } = result.totals;
	return {
		head: [
			`mutation_report: cosmic-ray ${session}`,
			`mutation_overall: killed=${killed} survived=${survived} score=${scoreOf(killed, survived)}% incompetent=${incompetent}`,
		],
		rows: result.rows.map(
			(r) =>
				`${r.f}\tkilled=${r.killed}\tsurvived=${r.survived}\tnoCoverage=0\ttimeout=0\tscore=${r.score}%\tincompetent=${r.incompetent}`,
		),
	};
};
