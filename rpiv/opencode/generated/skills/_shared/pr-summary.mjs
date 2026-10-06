// pr-summary.mjs — the factual body of a feature's PR (S25-pr-summary, D25). The pr
// skill runs it in the feature's checkout and replaces only the two agent marker lines
// (Summary, Open decisions); every other line comes from git, the artifacts and the
// cycle log, never from the agent.
//
// CLI: `node pr-summary.mjs --base <rev> --design <path> [--review <path>]...
// [--validation <path>]... [--branch <name>]` prints the body on stdout. Sections, in
// order: Summary (marker), Lane, Slices, Fix commits, Reviews, Validation, Cycle
// metrics, Open decisions (marker). A bad call or broken input prints
// `pr-summary: broken: <detail>` on stderr, nothing on stdout, exit 2 — never a
// partial body (degrade-distinguishes-broken).
//
// Importable: runCli.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readCommonDir, runCli as cycleReader } from "./cycles.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
import { isMain } from "./is-main.mjs";
import { LANES } from "./lane.mjs";

// The evidence paragraphs a slice commit's message may carry (D25: S12/S13 commits
// use TDD:/Gates:, S14/S15 Red:/Green:).
const LABELS = ["Contract:", "Red:", "Green:", "TDD:", "Gates:", "Evidence:"];
// A fix commit names the review it fixes (D22).
const REVIEW_PATH = /\.rpiv\/artifacts\/reviews\/[^\s`'"()]+\.md/;
const SINGLE = new Set(["--base", "--design", "--branch"]);
const REPEATED = new Map([
	["--review", "reviews"],
	["--validation", "validations"],
]);

const isOption = (name) => SINGLE.has(name) || REPEATED.has(name);

/** True when `value` cannot be an option's value (absent, empty, an option). */
const missingValue = (value) =>
	value === undefined || value === "" || value.startsWith("--");

/** Stores one option's value: repeated options collect, others keep the last. */
function setOption(opts, name, value) {
	if (REPEATED.has(name)) opts[REPEATED.get(name)].push(value);
	else opts[name.slice(2)] = value;
}

/** The options from `argv`; throws on an unknown option or a missing value. */
function parseArgs(argv) {
	const opts = { reviews: [], validations: [] };
	for (let i = 0; i < argv.length; i += 2) {
		const [name, value] = [argv[i], argv[i + 1]];
		if (!isOption(name)) throw new Error(`unknown option: ${name}`);
		if (missingValue(value)) throw new Error(`${name} needs a value`);
		setOption(opts, name, value);
	}
	for (const required of ["base", "design"])
		if (opts[required] === undefined)
			throw new Error(`--${required} is required`);
	return opts;
}

/** git's `{ status, out, err }` in `cwd` (English messages); throws when git
    could not run. */
function git(cwd, args) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, LC_ALL: "C" },
		windowsHide: true,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.error) throw new Error(`git could not run (${res.error.message})`);
	return {
		status: res.status,
		out: (res.stdout ?? "").replaceAll("\r\n", "\n"),
		err: (res.stderr ?? "").trim(),
	};
}

function checkRepository(cwd) {
	const res = git(cwd, ["rev-parse", "--git-common-dir"]);
	const repo = readCommonDir({ ...res, out: res.out.trim() }, cwd);
	if (repo.problem) throw new Error(repo.problem);
	if (repo.outside) throw new Error(`not a git repository: ${cwd}`);
}

function checkBase(cwd, base) {
	const res = git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${base}^{commit}`,
	]);
	if (res.status !== 0) throw new Error(`base is not a commit: ${base}`);
}

/** `[{ short, message }]` for the non-merge commits of `base..HEAD`, oldest first. */
function commitsSince(cwd, base) {
	const res = git(cwd, [
		"log",
		"--reverse",
		"--no-merges",
		"--format=%h%x00%B%x1e",
		`${base}..HEAD`,
	]);
	if (res.status !== 0)
		throw new Error(`git log failed: ${res.err.split("\n")[0]}`);
	const commits = res.out
		.split("\x1e")
		.map((entry) => entry.replace(/^\n+/, ""))
		.filter(Boolean)
		.map((entry) => {
			const [short, message] = entry.split("\0");
			return { short, message: message.trim() };
		});
	if (commits.length === 0) throw new Error(`no commits in ${base}..HEAD`);
	return commits;
}

/** The message's evidence paragraphs, in message order (the subject excluded). */
function evidenceOf(message) {
	return message
		.split(/\n[ \t]*\n/)
		.slice(1)
		.filter((para) => LABELS.some((label) => para.startsWith(label)));
}

function sliceLines({ short, message }) {
	const lines = [`- ${short} ${message.split("\n")[0]}`];
	const evidence = evidenceOf(message);
	if (evidence.length === 0) lines.push("  no evidence lines");
	for (const para of evidence)
		for (const line of para.split("\n")) lines.push(`  ${line}`);
	return lines;
}

function readText(kind, path) {
	try {
		return readFileSync(path, "utf-8");
	} catch (err) {
		throw new Error(`cannot read ${kind} ${path} (${err.code ?? err.message})`);
	}
}

/** The design's frontmatter. One that opens but never closes is broken, never
    "no feature lane" (the same closing rule parseFrontmatter applies). */
function designFrontmatter(path) {
	const text = readText("design", path);
	if (text.startsWith("---") && text.indexOf("\n---", 3) === -1)
		throw new Error(`design ${path} has an unterminated frontmatter`);
	return parseFrontmatter(text);
}

/** The two Lane lines; a missing or broken feature lane is `normal` (**Lanes**). */
function laneLines(fm) {
	if (!Object.hasOwn(fm, "lane"))
		return ["lane: normal", "why: no feature lane"];
	if (!LANES.includes(fm.lane))
		return ["lane: normal", `why: broken feature lane: ${fm.lane}`];
	const why = Object.hasOwn(fm, "lane_reasons")
		? fm.lane_reasons
		: "no lane reasons";
	return [`lane: ${fm.lane}`, `why: ${why}`];
}

/** `- <path>: <field> <value>` per file; throws when a file lacks the field. */
function outcomeLines(kind, paths, field) {
	return paths.map((path) => {
		const fm = parseFrontmatter(readText(kind, path));
		if (!Object.hasOwn(fm, field) || fm[field] === "")
			throw new Error(`${kind} ${path} has no ${field}`);
		return `- ${path}: ${field} ${fm[field]}`;
	});
}

function cycleLines(cwd, branch) {
	try {
		const out = cycleReader(
			branch === undefined ? [] : ["--branch", branch],
			cwd,
		);
		return out.split("\n").filter(Boolean);
	} catch (err) {
		throw new Error(`cycles: ${err?.message ?? err}`);
	}
}

/** The PR body for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const opts = parseArgs(argv);
	checkRepository(cwd);
	checkBase(cwd, opts.base);
	const commits = commitsSince(cwd, opts.base);
	const lane = laneLines(designFrontmatter(opts.design));
	const fixes = commits.filter((c) => REVIEW_PATH.test(c.message));
	const slices = commits.filter((c) => !REVIEW_PATH.test(c.message));
	const reviews = outcomeLines("review", opts.reviews, "merge_status");
	const validations = outcomeLines("validation", opts.validations, "verdict");
	const cycles = cycleLines(cwd, opts.branch);
	const sections = [
		["## Summary", "<!-- rpiv:agent summary -->"],
		["## Lane", ...lane],
		["## Slices", ...slices.flatMap(sliceLines)],
		[
			"## Fix commits",
			`fix rounds: ${fixes.length}`,
			...fixes.map(
				(c) =>
					`- ${c.short} ${c.message.split("\n")[0]} (review: ${c.message.match(REVIEW_PATH)[0]})`,
			),
		],
		["## Reviews", ...(reviews.length > 0 ? reviews : ["reviews: none"])],
		[
			"## Validation",
			...(validations.length > 0 ? validations : ["validation: none"]),
		],
		["## Cycle metrics", ...cycles],
		["## Open decisions", "<!-- rpiv:agent open-decisions -->"],
	];
	return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(`pr-summary: broken: ${err?.message ?? err}\n`);
		process.exitCode = 2;
	}
}
