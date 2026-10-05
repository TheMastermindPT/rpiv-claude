// lane.mjs — the deterministic lane classifier (D16 of the risk-lanes design, S4).
// Routes a change into `fast`, `normal` or `rigorous` from its size (FR2) and its
// sensitive signals (FR3), reading the risk vocabulary from source-vocab.mjs.
// Pure apart from loadLaneThresholds, which reads the optional repo-root
// `.rpiv-lanes.json`. No Jev (D10) and no CLI (the CLI is S5).
//
// Importable-only: no CLI, no isMain.
// Importable: DEFAULT_LANE_THRESHOLDS, classifyLane, loadLaneThresholds, mergeLane.

import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	isCiConfig,
	isContainerFile,
	isEnvFile,
	isFixture,
	isManifest,
	isMigration,
	isTest,
	sensitiveWords,
} from "./source-vocab.mjs";

export const DEFAULT_LANE_THRESHOLDS = Object.freeze({
	fast: Object.freeze({ maxSlices: 1, maxLines: 150, maxFiles: 5 }),
	rigorous: Object.freeze({ minFiles: 61 }),
});

const LANES = ["fast", "normal", "rigorous"];
const higher = (a, b) => (LANES.indexOf(a) >= LANES.indexOf(b) ? a : b);

const CONFIG_FILE = ".rpiv-lanes.json";
/** A path with `\` read as `/` (Windows paths). */
const slashed = (p) => p.replace(/\\/g, "/");
const isPlainObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const isCount = (n) => Number.isInteger(n) && n >= 0;

const isCounted = (f) =>
	typeof f.added === "number" && typeof f.deleted === "number";

/** Size rules (FR2). Test and fixture files stay out of the fast limits but count
    toward the rigorous file limit (developer choice, D16). An unknown measure does
    not block fast; it is reported as a diagnostic instead. */
const sizeFindings = ({ files, slices }, { fast, rigorous }, diagnostics) => {
	const isSupport = (p) => isTest(slashed(p)) || isFixture(slashed(p));
	const sized = files.filter((f) => !isSupport(f.path));
	const findings = [];
	if (slices === undefined) diagnostics.push("slices unknown");
	else if (slices > fast.maxSlices)
		findings.push(["normal", `slices: ${slices} > ${fast.maxSlices}`]);
	if (!sized.every(isCounted)) diagnostics.push("lines unknown");
	else {
		const lines = sized.reduce((sum, f) => sum + f.added + f.deleted, 0);
		if (lines > fast.maxLines)
			findings.push(["normal", `lines: ${lines} > ${fast.maxLines}`]);
	}
	if (sized.length > fast.maxFiles)
		findings.push(["normal", `files: ${sized.length} > ${fast.maxFiles}`]);
	if (files.length >= rigorous.minFiles)
		findings.push([
			"rigorous",
			`files: ${files.length} >= ${rigorous.minFiles}`,
		]);
	return findings;
};

// File kinds that make a change rigorous, in reason order (FR3).
const RIGOROUS_KINDS = [
	["migration", isMigration],
	["ci config", isCiConfig],
	["container file", isContainerFile],
	["env file", isEnvFile],
];
// Words with known false positives (design tokens, schema definitions): normal only.
const WEAK_WORDS = new Set(["token", "schema"]);

/** Sensitive-signal rules (FR3), per file in input order. A manifest only blocks
    fast ("possible new dependency", developer choice, D16). */
const signalFindings = ({ files, hubs }, diagnostics) => {
	if (hubs === undefined) diagnostics.push("hub signal unavailable");
	const hubSet = new Set((hubs ?? []).map(slashed));
	return files.flatMap(({ path }) => [
		...(hubSet.has(slashed(path)) ? [["rigorous", `hub: ${path}`]] : []),
		...RIGOROUS_KINDS.filter(([, is]) => is(path)).map(([kind]) => [
			"rigorous",
			`${kind}: ${path}`,
		]),
		...(isManifest(path) ? [["normal", `manifest: ${path}`]] : []),
		...sensitiveWords(path).map((word) =>
			WEAK_WORDS.has(word)
				? ["normal", `weak sensitive word: ${word} (${path})`]
				: ["rigorous", `sensitive word: ${word} (${path})`],
		),
	]);
};

const check = (ok, message) => {
	if (!ok) throw new TypeError(message);
};
const optional = (value, test) => value === undefined || test(value);
const isNonEmptyString = (s) => typeof s === "string" && s !== "";
const isPositive = (n) => Number.isInteger(n) && n > 0;
const isStringList = (list) =>
	Array.isArray(list) && list.every((s) => typeof s === "string");

const assertFile = (file) => {
	check(isPlainObject(file), "files must hold objects");
	check(isNonEmptyString(file.path), "path must be a non-empty string");
	for (const key of ["added", "deleted"]) {
		check(
			optional(file[key], isCount),
			`${key} must be a non-negative integer (${file.path})`,
		);
	}
};

/** Throws a TypeError naming the first malformed field: a broken call never
    reports a lane (degrade-distinguishes-broken). */
const assertInput = (input) => {
	check(isPlainObject(input), "input must be an object");
	const { files, slices, hubs } = input;
	check(Array.isArray(files), "files must be an array");
	files.forEach(assertFile);
	check(optional(slices, isPositive), "slices must be a positive integer");
	check(optional(hubs, isStringList), "hubs must be an array of strings");
};

/** Throws a TypeError naming the bad key unless every threshold is a
    non-negative integer (S4 revision 1; precedent 09be34d, a NaN threshold). */
const assertThresholds = (thresholds) => {
	check(isPlainObject(thresholds), "thresholds must be an object");
	check(
		optional(thresholds.broken, (b) => typeof b === "string"),
		"thresholds.broken must be a string",
	);
	for (const [group, keys] of Object.entries(DEFAULT_LANE_THRESHOLDS)) {
		const value = thresholds[group];
		check(isPlainObject(value), `thresholds.${group} must be an object`);
		for (const key of Object.keys(keys)) {
			check(
				isCount(value[key]),
				`thresholds.${group}.${key} must be a non-negative integer`,
			);
		}
	}
};

/** The lane of a change (D16): `{ lane, reasons, diagnostics }`. */
export const classifyLane = (input, thresholds = DEFAULT_LANE_THRESHOLDS) => {
	assertInput(input);
	assertThresholds(thresholds);
	const diagnostics = [];
	let lane;
	let reasons;
	if (input.files.length === 0) {
		// Unclassifiable is never the lowest lane.
		lane = "normal";
		reasons = ["no changed files"];
		diagnostics.push("no changed files");
	} else {
		const findings = [
			...sizeFindings(input, thresholds, diagnostics),
			...signalFindings(input, diagnostics),
		];
		lane = findings.reduce((acc, [l]) => higher(acc, l), "fast");
		reasons = findings.length
			? findings.map(([, r]) => r)
			: ["within fast limits"];
	}
	if (thresholds.broken !== undefined) {
		// One step as FR5 defines it: fast -> normal; normal and rigorous unchanged.
		diagnostics.unshift(`broken config: ${CONFIG_FILE}: ${thresholds.broken}`);
		if (lane === "fast") {
			lane = "normal";
			reasons.push("broken config: raised to normal");
		}
	}
	return { lane, reasons, diagnostics };
};

/** The first problem in one known group (`fast`/`rigorous`) of a config. */
const groupProblem = (group, value) => {
	if (!isPlainObject(value)) return `${group} is not an object`;
	for (const [key, n] of Object.entries(value)) {
		if (!Object.hasOwn(DEFAULT_LANE_THRESHOLDS[group], key))
			return `unknown key ${group}.${key}`;
		if (!isCount(n)) return `${group}.${key} is not a non-negative integer`;
	}
	return undefined;
};

/** The first problem in a parsed config, or undefined when it is valid. */
const configProblem = (config) => {
	if (!isPlainObject(config)) return "the top level is not an object";
	for (const [group, value] of Object.entries(config)) {
		if (!Object.hasOwn(DEFAULT_LANE_THRESHOLDS, group))
			return `unknown key ${group}`;
		const problem = groupProblem(group, value);
		if (problem) return problem;
	}
	return undefined;
};

/** Lane thresholds for a repository: the defaults, overridden key by key by
    `<repoRoot>/.rpiv-lanes.json` (D9). A broken file yields the defaults plus a
    `broken` detail, which classifyLane reports and acts on. */
export const loadLaneThresholds = (repoRoot) => {
	// A wrong root is a caller bug, not a missing file (S4 revision 1).
	check(
		typeof repoRoot === "string" &&
			statSync(repoRoot, { throwIfNoEntry: false })?.isDirectory(),
		`repoRoot must name an existing directory: ${String(repoRoot)}`,
	);
	const defaults = structuredClone(DEFAULT_LANE_THRESHOLDS);
	const configPath = join(repoRoot, CONFIG_FILE);
	let text;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		// A link to a missing target exists: broken, not "no file" (S5 carry-over).
		if (error.code === "ENOENT" && lstatSync(configPath, { throwIfNoEntry: false }))
			return { ...defaults, broken: "dangling link" };
		if (error.code === "ENOENT") return defaults;
		return {
			...defaults,
			broken: `cannot read (${error.code ?? error.message})`,
		};
	}
	let config;
	try {
		config = JSON.parse(text);
	} catch (error) {
		return { ...defaults, broken: `invalid JSON (${error.message})` };
	}
	const problem = configProblem(config);
	if (problem) return { ...defaults, broken: problem };
	return {
		fast: { ...defaults.fast, ...config.fast },
		rigorous: { ...defaults.rigorous, ...config.rigorous },
	};
};

const assertLane = (value, name) => {
	if (!LANES.includes(value))
		throw new TypeError(`${name} is not a lane: ${String(value)}`);
};

/** Raise-only merge (D8): the higher of an earlier lane (or undefined) and a new one. */
export const mergeLane = (previous, next) => {
	if (previous !== undefined) assertLane(previous, "previous");
	assertLane(next, "next");
	return previous === undefined ? next : higher(previous, next);
};
