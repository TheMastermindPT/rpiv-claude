// append-only.mjs — the owner of candidate-workflow.md's append-only check: does a later
// version of an approved document keep its approval? candidate-workflow.md
// (**Intent And Brief**) states the rule; this helper is the one place that runs it.
//
// CLI, run only as the entry point:
//   node append-only.mjs <approved-copy> <artifact>
// Compares the two with `git diff --no-index --ignore-cr-at-eol` and allows only:
//   - added lines inside `## Developer Context`, `## TDD Evidence (implement)` or
//     `## Follow-up` (a `## Follow-up <suffix>` heading counts as Follow-up);
//   - changed `status`, `last_updated`, `last_updated_by`, `last_updated_note` and
//     `content_hash` frontmatter lines;
//   - changed `lane` and `lane_reasons` lines that raise the lane (fast < normal <
//     rigorous; an absent approved lane is `normal`), with an added
//     `## Developer Context` line naming the lane and the raised value.
// An unchanged line must also stay in the same section: an added heading that moves
// approved lines into an allowed section reopens approval.
//
// Prints `append-only: keep` and exits 0, or `append-only: reopen` plus one line per
// offending change and exits 1. A missing approved copy is a reopen, never a keep.
// A broken call (usage, an unreadable artifact, git failing to run or to diff) prints
// `append-only: broken: <detail>` on stderr and exits 2, never a result.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { isMain } from "./is-main.mjs";

const BOOKKEEPING_KEYS = new Set([
	"status",
	"last_updated",
	"last_updated_by",
	"last_updated_note",
	"content_hash",
]);
const LANE_KEYS = new Set(["lane", "lane_reasons"]);
const LANE_RANK = { fast: 0, normal: 1, rigorous: 2 };
const DEVELOPER_CONTEXT = "Developer Context";
const FRONTMATTER = "frontmatter";

/** True for a section whose added lines keep approval. */
const isAllowedSection = (section) =>
	section === DEVELOPER_CONTEXT ||
	section === "TDD Evidence (implement)" ||
	section === "Follow-up" ||
	section.startsWith("Follow-up ");

/** A file's lines, CR-insensitive, as `--ignore-cr-at-eol` compares them. */
const readLines = (path) => {
	const lines = readFileSync(path, "utf-8").replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
};

/** Index of the closing `---` of a leading frontmatter block, or -1 without one. */
const frontmatterEnd = (lines) =>
	lines[0] === "---" ? lines.indexOf("---", 1) : -1;

/** The section label of every line: `frontmatter`, the enclosing `## ` heading's
    text, or "" before the first heading. Headings inside code fences do not count. */
const sectionsOf = (lines) => {
	const end = frontmatterEnd(lines);
	let section = "";
	let fenced = false;
	return lines.map((line, index) => {
		if (index <= end) return FRONTMATTER;
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		else if (!fenced && line.startsWith("## ")) section = line.slice(3).trim();
		return section;
	});
};

const keyOf = (line) => line.match(/^([A-Za-z0-9_-]+):/)?.[1];

/** The hunks of a zero-context diff as `{ oldStart, oldCount, newStart, newCount }`. */
const parseHunks = (diff) =>
	[...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(
		([, oldStart, oldCount, newStart, newCount]) => ({
			oldStart: Number(oldStart),
			oldCount: oldCount === undefined ? 1 : Number(oldCount),
			newStart: Number(newStart),
			newCount: newCount === undefined ? 1 : Number(newCount),
		}),
	);

/** The zero-context diff of the two files; git failing to run or to diff throws. */
const gitDiff = (approved, artifact) => {
	const run = spawnSync(
		"git",
		[
			"diff",
			"--no-index",
			"--ignore-cr-at-eol",
			"--no-color",
			"--no-ext-diff",
			"--unified=0",
			"--",
			approved,
			artifact,
		],
		{ encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (run.error)
		throw new Error(
			`git could not run: ${run.error.code ?? run.error.message}`,
		);
	if (run.status !== 0 && run.status !== 1) {
		const why =
			String(run.stderr).trim().split("\n")[0] || `exit ${run.status}`;
		throw new Error(`git diff failed: ${why}`);
	}
	return run.stdout;
};

/** Removed, added and unchanged line numbers (1-based) implied by the hunks. */
const alignment = (hunks, oldLength) => {
	const removed = [];
	const added = [];
	const unchanged = [];
	let oldPos = 1;
	let newPos = 1;
	const keep = (untilOld) => {
		for (; oldPos <= untilOld; oldPos++, newPos++)
			unchanged.push([oldPos, newPos]);
	};
	for (const { oldStart, oldCount, newStart, newCount } of hunks) {
		keep(oldCount === 0 ? oldStart : oldStart - 1);
		for (let i = 0; i < oldCount; i++) removed.push(oldStart + i);
		for (let i = 0; i < newCount; i++) added.push(newStart + i);
		oldPos += oldCount;
		newPos += newCount;
	}
	keep(oldLength);
	return { removed, added, unchanged };
};

/** A lane's rank, or `unknown` for a value that is no lane. */
const rankOf = (lane, unknown) =>
	Object.hasOwn(LANE_RANK, lane) ? LANE_RANK[lane] : unknown;

/** True when `after` is a lane above `before`; an unknown value on either side never is. */
const isRaise = (before, after) =>
	rankOf(after, Number.NEGATIVE_INFINITY) >
	rankOf(before, Number.POSITIVE_INFINITY);

/** The lane problem of a document whose lane lines changed, or null for a recorded raise. */
const laneProblem = (oldLines, newLines, contextAdditions) => {
	const before = parseFrontmatter(`${oldLines.join("\n")}\n`).lane || "normal";
	const after = parseFrontmatter(`${newLines.join("\n")}\n`).lane;
	if (!isRaise(before, after))
		return `lane ${before} -> ${after ?? "(none)"} is not a raise`;
	const recorded = contextAdditions.some(
		(line) => /\blane\b/i.test(line) && line.toLowerCase().includes(after),
	);
	return recorded
		? null
		: `lane raise ${before} -> ${after} has no \`## Developer Context\` entry recording it`;
};

/** What a changed frontmatter line means: `keep`, `lane` or `offend`. */
const frontmatterVerdict = (key) => {
	if (BOOKKEEPING_KEYS.has(key)) return "keep";
	return LANE_KEYS.has(key) ? "lane" : "offend";
};

/** What one changed line means: `keep`, `lane`, `context` (a kept Developer Context
    addition) or `offend`. */
const verdictOf = (line, section, kind) => {
	if (section === FRONTMATTER) return frontmatterVerdict(keyOf(line));
	if (kind !== "added" || !isAllowedSection(section)) return "offend";
	return section === DEVELOPER_CONTEXT ? "context" : "keep";
};

/** One side's changed lines, judged into `state`. A side is `{ lines, sections, where }`. */
const judgeChanged = (numbers, side, kind, state) => {
	for (const number of numbers) {
		const line = side.lines[number - 1];
		const verdict = verdictOf(line, side.sections[number - 1], kind);
		if (verdict === "lane") state.laneTouched = true;
		else if (verdict === "context") state.contextAdditions.push(line);
		else if (verdict === "offend")
			state.problems.push(`${kind} ${side.where}:${number}: ${line}`);
	}
};

/** Unchanged lines whose section differs between the two sides. */
const movedProblems = (unchanged, before, after) =>
	unchanged
		.filter(([o, n]) => before.sections[o - 1] !== after.sections[n - 1])
		.map(
			([o, n]) =>
				`moved approved:${o} -> artifact:${n} from \`${before.sections[o - 1]}\` into \`${after.sections[n - 1]}\`: ${before.lines[o - 1]}`,
		);

/** One file's lines and section labels, named for the report. */
const sideOf = (path, where) => {
	const lines = readLines(path);
	return { lines, sections: sectionsOf(lines), where };
};

/** The offending changes from the approved copy to the artifact; empty means keep. */
const appendOnlyProblems = (approvedPath, artifactPath) => {
	const before = sideOf(approvedPath, "approved");
	const after = sideOf(artifactPath, "artifact");
	const hunks = parseHunks(gitDiff(approvedPath, artifactPath));
	const { removed, added, unchanged } = alignment(hunks, before.lines.length);
	const state = { problems: [], contextAdditions: [], laneTouched: false };
	judgeChanged(removed, before, "removed", state);
	judgeChanged(added, after, "added", state);
	state.problems.push(...movedProblems(unchanged, before, after));
	const lane = state.laneTouched
		? laneProblem(before.lines, after.lines, state.contextAdditions)
		: null;
	return lane ? [...state.problems, lane] : state.problems;
};

/** A path that must name a readable file; anything else is broken. */
const requireFile = (path, role) => {
	if (!existsSync(path) || !statSync(path).isFile())
		throw new Error(`${role} is not a readable file: ${path}`);
};

/** The verdict text and exit code for one call. */
const run = (argv) => {
	if (argv.length !== 2)
		throw new Error("usage: append-only.mjs <approved-copy> <artifact>");
	const [approved, artifact] = argv;
	requireFile(artifact, "artifact");
	if (!existsSync(approved))
		return {
			code: 1,
			text: `append-only: reopen\napproved copy missing: ${approved}\n`,
		};
	requireFile(approved, "approved copy");
	const problems = appendOnlyProblems(approved, artifact);
	if (problems.length === 0) return { code: 0, text: "append-only: keep\n" };
	return { code: 1, text: `append-only: reopen\n${problems.join("\n")}\n` };
};

if (isMain(import.meta.url)) {
	try {
		const { code, text } = run(process.argv.slice(2));
		process.stdout.write(text);
		process.exitCode = code;
	} catch (error) {
		process.stderr.write(`append-only: broken: ${error.message}\n`);
		process.exitCode = 2;
	}
}
