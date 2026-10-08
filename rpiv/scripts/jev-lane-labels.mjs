// scripts/jev-lane-labels.mjs — developer lane labels for the Jev lane shadow
// (S30-lane-labels, D40). When the developer approves a slice brief whose `Lane:`
// line came from `lane.mjs --paths`, the skill records the approved lane here; the
// label is joined, at label time, to the newest shadow row measured on the same
// paths (scripts/jev-lane.mjs writes those rows), so calibration can compare the
// rule lane, Jev's would-be lane and the developer's lane.
//
// CLI:
//   node jev-lane-labels.mjs label --slice <id> --lane <fast|normal|rigorous> -- <path>...
//     appends `{ ts, slice, label, branch, row }` to
//     `<repository top>/.rpiv/logs/jev-lane-labels.log`; `row` is the joined shadow
//     row's `{ ts, lane, status, jevLane, score }`, or null when none matches (a
//     label is written even when Jev made no call). Prints
//     `label: <lane> for <slice> (shadow row <ts>, rule <lane>, jev <lane|none>)`
//     or `label: <lane> for <slice> (no shadow row)`.
//   node jev-lane-labels.mjs report
//     counts the latest label per slice by developer lane and by score band, and
//     how far the labels are from FR4's 20 before any enforce mode.
// Both read the rotated `<log>.1` before the current file (jev-gate's
// readLogEntries). A label's paths go through the shadow row's own chain
// (lane.mjs laneInput, jev-lane.mjs repoRelative). A bad call, a directory outside
// a repository or a malformed log line (named by its own file and line) prints
// `jev-lane-labels: broken: <detail>` on stderr, exits 2 and writes nothing
// (degrade-distinguishes-broken).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isMain } from "../skills/_shared/is-main.mjs";
import { LANES, laneInput } from "../skills/_shared/lane.mjs";
import { appendLog, readLogEntries } from "./jev-gate.mjs";
import {
	LANE_LOG_PATH,
	laneOfScore,
	MAX_FILES,
	repoRelative,
} from "./jev-lane.mjs";

export const LABEL_LOG_PATH = ".rpiv/logs/jev-lane-labels.log";
// FR4: at least 20 labels before any enforce mode.
const ENFORCE_LABELS = 20;
// The score band of each would-be lane; laneOfScore owns the cut-offs (D38).
const BAND_OF_LANE = { fast: "0-0.5", normal: "0.5-1.5", rigorous: "1.5-2" };

/** git's trimmed stdout in `cwd`; a failure throws its first line. */
function git(cwd, args) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		windowsHide: true,
		env: { ...process.env, LC_ALL: "C" },
	});
	if (res.error)
		throw new Error(
			`git could not run (${res.error.code ?? res.error.message})`,
		);
	if (res.status !== 0)
		throw new Error(
			`git ${args[0]} failed: ${(res.stderr ?? "").trim().split("\n")[0]}`,
		);
	return (res.stdout ?? "").trim();
}

/** The parsed JSON lines of the log at `path` (rotated generation first); a
    malformed line throws, named by its own file and line (S30 revision 2). */
function readRows(path) {
	return readLogEntries(path).map(({ file, number, text }) => {
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`malformed line ${number} in ${file}`);
		}
	});
}

const LABEL_OPTIONS = new Set(["--slice", "--lane"]);

/** The `--slice` / `--lane` values before `--`; an unknown option throws. */
function readOptions(options) {
	const opts = {};
	for (let i = 0; i < options.length; i += 2) {
		if (!LABEL_OPTIONS.has(options[i]))
			throw new Error(`unknown option: ${options[i]}`);
		opts[options[i].slice(2)] = options[i + 1];
	}
	return opts;
}

// What a label call must hold, in order: [holds, why not].
const LABEL_CHECKS = [
	[
		(call) => LANES.includes(call.lane),
		"lane must be fast, normal or rigorous",
	],
	[(call) => Boolean(call.slice), "--slice needs an id"],
	[(call) => call.paths.length > 0, "label needs the measured paths after --"],
];

/** `{ slice, lane, paths }` of a `label` call; a bad call throws. */
function labelArgs(argv) {
	const split = argv.indexOf("--");
	const before = split === -1 ? argv : argv.slice(0, split);
	const paths = split === -1 ? [] : argv.slice(split + 1);
	const { slice, lane } = readOptions(before);
	const call = { slice, lane, paths };
	const failed = LABEL_CHECKS.find(([holds]) => !holds(call));
	if (failed) throw new Error(failed[1]);
	return call;
}

const sameSet = (a, b) => {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((p) => right.has(p));
};

/** The paths a shadow row measured for `paths` typed in `cwd`: the same chain the
    row uses — lane.mjs's laneInput (drops generated and media paths), then
    jev-lane.mjs's repoRelative (S30 revision 2). */
const measuredPaths = (paths, cwd) =>
	repoRelative(laneInput(["--paths", ...paths], cwd), cwd).files;

/** Whether row `r`'s file count fits `paths`: a row that kept a MAX_FILES prefix
    joins only a label of its own length; any other row joins a label that was not
    cut, where order and repeats do not matter (S30 review 2, D-1). */
const countFits = (r, paths) =>
	r.files > MAX_FILES ? r.files === paths.length : paths.length <= MAX_FILES;

/** The newest `paths` shadow row measured on `paths`, or null. */
function joinedRow(rows, paths) {
	const kept = paths.slice(0, MAX_FILES);
	const match = rows.findLast(
		(r) =>
			r?.mode === "paths" &&
			Array.isArray(r.paths) &&
			countFits(r, paths) &&
			sameSet(r.paths, kept),
	);
	if (!match) return null;
	return {
		ts: match.ts,
		lane: match.lane,
		status: match.status,
		jevLane: match.jevLane ?? null,
		score: match.score ?? null,
	};
}

function label(argv, cwd) {
	const { slice, lane, paths } = labelArgs(argv);
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	const measured = measuredPaths(paths, cwd);
	const row = joinedRow(readRows(resolve(top, LANE_LOG_PATH)), measured);
	const branch = git(cwd, ["branch", "--show-current"]) || null;
	appendLog(resolve(top, LABEL_LOG_PATH), {
		ts: new Date().toISOString(),
		slice,
		label: lane,
		branch,
		row,
	});
	const joined = row
		? `shadow row ${row.ts}, rule ${row.lane}, jev ${row.jevLane ?? "none"}`
		: "no shadow row";
	return `label: ${lane} for ${slice} (${joined})\n`;
}

/** How `other` stands against the developer's `lane`: lower, same, higher or none. */
function compare(lane, other) {
	if (!LANES.includes(other)) return "none";
	const diff = LANES.indexOf(other) - LANES.indexOf(lane);
	return diff < 0 ? "lower" : diff === 0 ? "same" : "higher";
}

const counts = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const SIDES = ["lower", "same", "higher", "none"];
const sides = (c) => SIDES.map((k) => `${k} ${c[k]}`).join(", ");

/** Each slice's last label in read order; the latest approval counts once (S30
    revision 2), so repeated labels never inflate FR4's readiness. */
function latestPerSlice(labels) {
	const bySlice = new Map();
	for (const entry of labels) {
		bySlice.delete(entry.slice);
		bySlice.set(entry.slice, entry);
	}
	return [...bySlice.values()];
}

function report(cwd) {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	const labels = latestPerSlice(readRows(resolve(top, LABEL_LOG_PATH)));
	const byLane = Object.fromEntries(
		LANES.map((l) => [l, { n: 0, rule: counts(SIDES), jev: counts(SIDES) }]),
	);
	const bands = Object.fromEntries(
		[...LANES.map((l) => BAND_OF_LANE[l]), "none"].map((b) => [
			b,
			{ n: 0, ...counts(LANES) },
		]),
	);
	for (const entry of labels) {
		const stat = byLane[entry.label];
		if (!stat)
			throw new Error(`malformed label: ${JSON.stringify(entry.label)}`);
		stat.n += 1;
		stat.rule[compare(entry.label, entry.row?.lane)] += 1;
		stat.jev[compare(entry.label, entry.row?.jevLane)] += 1;
		const score = entry.row?.score;
		const band =
			typeof score === "number" ? BAND_OF_LANE[laneOfScore(score)] : "none";
		bands[band].n += 1;
		bands[band][entry.label] += 1;
	}
	const n = labels.length;
	return [
		`labels: ${n}`,
		n >= ENFORCE_LABELS
			? `enforce: enough labels (${n} of ${ENFORCE_LABELS})`
			: `enforce: not ready (${n} of ${ENFORCE_LABELS} labels)`,
		...LANES.map(
			(l) =>
				`label ${l}: ${byLane[l].n} (rule ${sides(byLane[l].rule)}; jev ${sides(byLane[l].jev)})`,
		),
		...Object.entries(bands).map(
			([b, c]) =>
				`band ${b}: ${c.n} (${LANES.map((l) => `${l} ${c[l]}`).join(", ")})`,
		),
		"",
	].join("\n");
}

/** The CLI's stdout for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const [command, ...rest] = argv;
	if (command === "label") return label(rest, cwd);
	if (command === "report") return report(cwd);
	throw new Error(`unknown command: ${command ?? "(none)"}`);
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(
			`jev-lane-labels: broken: ${String(err?.message ?? err).split("\n")[0]}\n`,
		);
		process.exitCode = 2;
	}
}
