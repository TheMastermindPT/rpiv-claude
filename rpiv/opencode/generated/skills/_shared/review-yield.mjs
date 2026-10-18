// review-yield.mjs — how much of each reviewer's output the developer acts on. Reads the
// triaged review tables under one or more roots (any `*review*.md` with a `source`
// column, plus deep-review stores `*.json` with `kind: "dr"` findings) and prints, per
// reviewer source, the findings and how their resolutions split:
//   acted      fixed / fix / applied
//   not-acted  dismissed / rejected / residual / accepted risk
//   deferred   deferred / follow-up / carried
//   pending    no decision yet (blank, a question, a proposal-only table, `open`)
//   unknown    a resolution the closed vocabulary does not cover (never folded in)
// Yield = acted / (acted + not-acted + deferred); `n/a` when nothing was triaged.
// A multi-source row counts once per source. Withdrawn deep-review findings are left out.
//
// CLI, run only as the entry point:
//   node review-yield.mjs --root <dir> [--root <dir>]...
// Prints `review-yield: complete` (exit 0) or `review-yield: partial` (exit 1: some file
// could not be read; each is named on stderr as `review-yield: broken: <path>[:<line>]:
// <detail>`), then the table; `records: none` when no review file exists. A bad call or an
// unreadable root prints `review-yield: broken: <detail>` on stderr and exits 2.
//
// Importable: classifyResolution, normalizeSources, yieldOf (pure).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseFences } from "./fences.mjs";
import { isMain } from "./is-main.mjs";

const RESOLUTIONS = [
	["acted", /^(fixed|fix|applied|apply)\b/],
	[
		"not-acted",
		/^(dismissed|dismiss|rejected|reject|residual|developer-accepted residual|accepted risk|accept)\b/,
	],
	[
		"deferred",
		/^(deferred|defer|follow-up|follow up|possible follow-up|carried|carry)\b/,
	],
	["pending", /^(to the developer|pending|open\b|\*\*)/],
];

/** The bucket a resolution cell falls in. */
export const classifyResolution = (cell) => {
	const text = String(cell ?? "")
		.trim()
		.toLowerCase();
	if (!text) return "pending";
	return (
		RESOLUTIONS.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown"
	);
};

const SOURCE_NAMES = [
	["code", /^(code|cr|artifact-code-reviewer)$/],
	["coverage", /^(coverage|cov|artifact-coverage-reviewer)$/],
	["verifier", /^(verifier|sv|slice-verifier|slice(-[a-z0-9]+)?)$/],
];
// A finding ID or count after a source (`SV 8, 11`, `SV C-3, M-7`), not a source.
const FINDING_ID = /^([a-z]{0,2}-?\d+[a-z]?|×\d+)$/;

/** The reviewer sources a `source` cell names, each once. */
const ALL_THREE = /^\s*all\b|\ball three\b/;

/** The reviewer a single source word names, or `other`. */
const sourceName = (part) =>
	SOURCE_NAMES.find(([, re]) => re.test(part))?.[0] ?? "other";

export const normalizeSources = (cell) => {
	const raw = String(cell ?? "").toLowerCase();
	if (ALL_THREE.test(raw)) return ["code", "coverage", "verifier"];
	const parts = raw
		.replace(/\([^)]*\)/g, " ")
		.split(/[,;]|\band\b/)
		.map((part) => part.trim().split(/\s+/)[0] ?? "")
		.filter((part) => part && !FINDING_ID.test(part));
	const names = parts.map(sourceName);
	return [...new Set(names.length ? names : ["other"])];
};

/** `acted / (acted + not-acted + deferred)` as a whole percent, or `n/a`. */
export const yieldOf = (counts) => {
	const triaged = counts.acted + counts["not-acted"] + counts.deferred;
	return triaged ? `${Math.round((counts.acted / triaged) * 100)}%` : "n/a";
};

/** A table row's cells, honouring `\|` inside code spans. */
const cellsOf = (line) =>
	line
		.split(/(?<!\\)\|/)
		.slice(1, -1)
		.map((cell) => cell.trim());

const SEPARATOR = /^\|[\s:|-]+\|$/;

/** True when line `i` opens a table: a `|` row followed by a separator row. */
const opensTable = (lines, i) =>
	lines[i].startsWith("|") && SEPARATOR.test(lines[i + 1]?.trim() ?? "");

/** Findings of one table whose header is at line `i`; rows with the wrong cell count go to `broken`. */
const tableFindings = (path, lines, i, broken) => {
	const header = cellsOf(lines[i]).map((h) => h.toLowerCase());
	const source = header.indexOf("source");
	if (source === -1) return [];
	const resolution = header.indexOf("resolution");
	const findings = [];
	for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
		const cells = cellsOf(lines[j]);
		if (cells.length !== header.length) {
			broken.push(
				`${path}:${j + 1}: ${cells.length} cells, header has ${header.length}`,
			);
			continue;
		}
		const bucket =
			resolution === -1 ? "pending" : classifyResolution(cells[resolution]);
		findings.push({ sources: normalizeSources(cells[source]), bucket });
	}
	return findings;
};

/** The lines of `text`, trimmed so indented tables count, with fenced code blanked so
    example tables do not (fences.mjs owns fence parsing). Line numbers are kept. */
const tableLines = (path, text, broken) => {
	// Left-trimmed so a fence nested in a list item is still a fence.
	const { fences, unterminated } = parseFences(
		text
			.split(/\r?\n/)
			.map((line) => line.trimStart())
			.join("\n"),
	);
	const spans = fences.map((f) => [f.start, f.end]);
	if (unterminated) {
		broken.push(`${path}:${unterminated.start}: unterminated code fence`);
		spans.push([unterminated.start, Number.POSITIVE_INFINITY]);
	}
	const fenced = (no) => spans.some(([start, end]) => no >= start && no <= end);
	return text
		.split(/\r?\n/)
		.map((line, i) => (fenced(i + 1) ? "" : line.trim()));
};

/** Findings `[{ sources, bucket }]` of a review markdown file; broken rows go to `broken`. */
const markdownFindings = (path, text, broken) => {
	const lines = tableLines(path, text, broken);
	return lines.flatMap((_, i) =>
		opensTable(lines, i) ? tableFindings(path, lines, i, broken) : [],
	);
};

const STORE_BUCKETS = {
	accepted: "acted",
	rejected: "not-acted",
	deferred: "deferred",
	open: "pending",
};

/** Findings of a deep-review store: one source per lens; withdrawn findings left out. */
const storeFindings = (text) => {
	const store = JSON.parse(text);
	return (store.findings ?? [])
		.filter((f) => f.kind === "dr" && f.status !== "withdrawn")
		.map((f) => ({
			sources: [`deep-review:${f.lens}`],
			bucket: STORE_BUCKETS[f.status] ?? "unknown",
		}));
};

/** Review files under `root`: `*review*.md` anywhere, `*.json` under a `reviews` folder. */
const isReviewFile = (dir, name) =>
	(/review/i.test(name) && name.endsWith(".md")) ||
	(name.endsWith(".json") && basename(resolve(dir)) === "reviews");

const reviewFiles = (root) => {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (isReviewFile(dir, entry.name)) out.push(path);
		}
	};
	walk(root);
	return out.sort();
};

const BUCKETS = ["acted", "not-acted", "deferred", "pending", "unknown"];

/** The root after `--root`; throws on any other flag or a missing value. */
const rootAt = (argv, i) => {
	if (argv[i] !== "--root") throw new Error(`unknown option: ${argv[i]}`);
	if (argv[i + 1] === undefined) throw new Error("--root needs a value");
	return argv[i + 1];
};

const parseArgs = (argv) => {
	const roots = [];
	for (let i = 0; i < argv.length; i += 2) roots.push(rootAt(argv, i));
	if (!roots.length) throw new Error("--root is required");
	return roots;
};

/** Findings of every review file; a file that cannot be read goes to `broken`. */
const collect = (files, broken) =>
	files.flatMap((path) => {
		try {
			const text = readFileSync(path, "utf-8");
			return path.endsWith(".json")
				? storeFindings(text)
				: markdownFindings(path, text, broken);
		} catch (error) {
			broken.push(`${path}: ${String(error?.message ?? error).split("\n")[0]}`);
			return [];
		}
	});

/** Bucket counts per source; a multi-source finding counts once per source. */
const countBySource = (findings) => {
	const bySource = new Map();
	for (const { sources, bucket } of findings)
		for (const source of sources) {
			if (!bySource.has(source))
				bySource.set(source, Object.fromEntries(BUCKETS.map((b) => [b, 0])));
			bySource.get(source)[bucket]++;
		}
	return bySource;
};

const tableRow = ([source, c]) => {
	const total = BUCKETS.reduce((sum, b) => sum + c[b], 0);
	return `${source} | ${total} | ${BUCKETS.map((b) => c[b]).join(" | ")} | ${yieldOf(c)}`;
};

const assertRoots = (roots) => {
	for (const root of roots)
		if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
			throw new Error(`root is not a readable folder: ${root}`);
};

/** The CLI's stdout, stderr lines and exit code for `argv`; throws on a broken call. */
const runCli = (argv) => {
	const roots = parseArgs(argv);
	assertRoots(roots);
	const files = roots.flatMap(reviewFiles);
	if (!files.length)
		return { text: "records: none\n", errors: [], exitCode: 0 };
	const broken = [];
	const findings = collect(files, broken);
	const rows = [...countBySource(findings)]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(tableRow);
	const lines = [
		`review-yield: ${broken.length ? "partial" : "complete"}`,
		"source | findings | acted | not-acted | deferred | pending | unknown | yield",
		...rows,
	];
	return {
		text: lines.map((l) => `${l}\n`).join(""),
		errors: broken,
		exitCode: broken.length ? 1 : 0,
	};
};

if (isMain(import.meta.url)) {
	try {
		const { text, errors, exitCode } = runCli(process.argv.slice(2));
		process.stdout.write(text);
		for (const error of errors)
			process.stderr.write(`review-yield: broken: ${error}\n`);
		process.exitCode = exitCode;
	} catch (error) {
		// A broken call never prints a result (degrade-distinguishes-broken).
		const detail = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`review-yield: broken: ${detail}\n`);
		process.exitCode = 2;
	}
}
