// convergence.mjs — the deterministic "reopen approach" trigger at the slice review
// cap (candidate-workflow.md **Lanes**). Review rounds that keep finding new spellings
// of the same problems while the code keeps growing are a sign the approach is losing:
// the trigger fires when the slice source grew by more than half between the first and
// the last reviewed candidate and its blocker rows did not fall (and are not zero: a
// candidate with no blockers is not stuck).
//
// CLI, run only as the entry point, inside the repository:
//   node convergence.mjs --round <base>..<candidate>=<blockers> --round … (two or more,
//   in review order)
// Each round names the reviewed candidate's range from the slice base and its blocker
// rows (reviewer-pair `blocker` rows plus slice-verifier `VIOLATION` entries). Slice
// source size is lane.mjs's measure (rangeSourceLines), which leaves out the tool's own
// folder (committed evidence, odin#16); a `reason: tool-folder lines not counted:` line
// always says how many of its lines the first and last rounds left out. Both rounds at
// 0 lines read `keep` with a "growth not measured" reason, never a division by zero; 0
// lines growing to more is broken. Prints `convergence: reopen`
// (exit 1) or `convergence: keep` (exit 0), then `reason:` lines. A broken call prints
// `convergence: broken: <detail>` on stderr and exits 2, never a decision.
//
// Importable: convergence (the pure rule), GROWTH_LIMIT.

import { execFileSync } from "node:child_process";
import { isMain } from "./is-main.mjs";
import { rangeSourceLines } from "./lane.mjs";

/** Growth above this share of the first candidate's slice source trips the trigger. */
export const GROWTH_LIMIT = 0.5;

const isCount = (n) => Number.isInteger(n) && n >= 0;

/** Throws unless round `i` has a known size and a whole blocker count. */
const assertRound = ({ lines, blockers }, i) => {
	if (!isCount(lines)) throw new Error(`round ${i + 1}: size unknown`);
	if (!isCount(blockers))
		throw new Error(`round ${i + 1}: blocker count is not a whole number`);
};

/** Throws unless every round has a known size and a whole blocker count. */
const assertRounds = (rounds) => {
	if (!Array.isArray(rounds) || rounds.length < 2)
		throw new Error("needs at least two rounds");
	rounds.forEach(assertRound);
	if (rounds[0].lines === 0 && rounds.at(-1).lines > 0)
		throw new Error("round 1 has no slice source to compare against");
};

const signedPercent = (share) =>
	`${share >= 0 ? "+" : ""}${Math.round(share * 100)}%`;

/** The `lines:` reason and growth share; both rounds at 0 lines is no growth. */
const linesGrowth = (first, last) => {
	if (first.lines === 0)
		return {
			growth: 0,
			reason: "lines: 0 -> 0 (no counted slice source; growth not measured)",
		};
	const growth = (last.lines - first.lines) / first.lines;
	return {
		growth,
		reason: `lines: ${first.lines} -> ${last.lines} (${signedPercent(growth)})`,
	};
};

/** The decision for review rounds `[{ lines, blockers }]`, first to last:
    `{ decision: "reopen" | "keep", reasons }`. Throws when the rounds cannot
    support a decision (fewer than two, an unknown size or count, an empty first
    candidate followed by a non-empty last one) — an undecidable case is never
    read as `keep`. Zero blockers in the last round is never stuck. */
export const convergence = (rounds) => {
	assertRounds(rounds);
	const first = rounds[0];
	const last = rounds.at(-1);
	const { growth, reason } = linesGrowth(first, last);
	const stuck = last.blockers > 0 && last.blockers >= first.blockers;
	return {
		decision: growth > GROWTH_LIMIT && stuck ? "reopen" : "keep",
		reasons: [reason, `blockers: ${first.blockers} -> ${last.blockers}`],
	};
};

/** `<range>=<blockers>` → `{ range, blockers }`. */
const parseRound = (value) => {
	const match = /^(.+\.\..+)=(\d+)$/.exec(value ?? "");
	if (!match)
		throw new Error(
			`round must be <base>..<candidate>=<blockers> (got: ${value ?? "nothing"})`,
		);
	return { range: match[1], blockers: Number(match[2]) };
};

const parseArgs = (argv) => {
	const rounds = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--round") throw new Error(`unknown option: ${argv[i]}`);
		rounds.push(parseRound(argv[++i]));
	}
	return rounds;
};

/** The CLI's stdout and exit code for `argv`, run in `cwd`; throws on a broken call. */
const runCli = (argv, cwd) => {
	const specs = parseArgs(argv);
	if (specs.length < 2) throw new Error("needs at least two rounds");
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf-8",
	}).trim();
	const measured = specs.map(({ range }) => rangeSourceLines(root, range));
	const rounds = specs.map(({ blockers }, i) => ({
		lines: measured[i].lines,
		blockers,
	}));
	const { decision, reasons } = convergence(rounds);
	// The measure leaves the tool's folder out; say so, so it is never silently smaller.
	const skipped = `tool-folder lines not counted: ${measured[0].toolHomeLines} -> ${measured.at(-1).toolHomeLines}`;
	const text = [
		`convergence: ${decision}`,
		...[...reasons, skipped].map((r) => `reason: ${r}`),
	]
		.map((l) => `${l}\n`)
		.join("");
	return { text, exitCode: decision === "reopen" ? 1 : 0 };
};

if (isMain(import.meta.url)) {
	try {
		const { text, exitCode } = runCli(process.argv.slice(2), process.cwd());
		process.stdout.write(text);
		process.exitCode = exitCode;
	} catch (error) {
		// A broken call never prints a decision (degrade-distinguishes-broken).
		const detail = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`convergence: broken: ${detail}\n`);
		process.exitCode = 2;
	}
}
