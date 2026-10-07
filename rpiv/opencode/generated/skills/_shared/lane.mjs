// lane.mjs — the deterministic lane classifier (D16 of the risk-lanes design, S4).
// Routes a change into `fast`, `normal` or `rigorous` from its size (FR2) and its
// sensitive signals (FR3), reading the risk vocabulary from source-vocab.mjs.
// Pure apart from loadLaneThresholds, which reads the optional repo-root
// `.rpiv-lanes.json`. No Jev (D10).
//
// CLI (D17, S5), run only as the entry point:
//   node lane.mjs (--range <revision-range> | --working | --paths <path>...)
//                 [--slices <n>] [--graph <depcruise-or-madge.json>]
// prints `lane: <lane>`, then `reason: …` and `diagnostic: …` lines, exit 0. Line
// counts come from `git diff --numstat -z`; generated and media paths are dropped;
// hubs come only from a graph file (no analysis tool is run). The limits are the
// stricter of the disk `.rpiv-lanes.json` and the base revision's (D33, S22). A broken call prints
// `lane: broken: <detail>` on stderr and exits 2, never a lane.
//
// Importable: DEFAULT_LANE_THRESHOLDS, LANES, classifyLane, loadLaneThresholds, mergeLane,
// laneInput (the files a CLI call judges, S8).

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import {
	isCiConfig,
	isContainerFile,
	isEnvFile,
	isFixture,
	isGenerated,
	isLaneConfig,
	isManifest,
	LANE_CONFIG_FILE,
	isMedia,
	isMigration,
	isTest,
	sensitiveWords,
} from "./source-vocab.mjs";

export const DEFAULT_LANE_THRESHOLDS = Object.freeze({
	fast: Object.freeze({ maxSlices: 1, maxLines: 150, maxFiles: 5 }),
	rigorous: Object.freeze({ minFiles: 61 }),
});

/** The lanes, lowest first — the one owner of the list (validate-artifact imports it). */
export const LANES = Object.freeze(["fast", "normal", "rigorous"]);
const higher = (a, b) => (LANES.indexOf(a) >= LANES.indexOf(b) ? a : b);

const CONFIG_FILE = LANE_CONFIG_FILE;
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
	["lane config", isLaneConfig],
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
	return thresholdsFromText(text);
};

/** Thresholds from the text of a `.rpiv-lanes.json`: the defaults overridden key
    by key, or the defaults plus a `broken` detail. */
const thresholdsFromText = (text) => {
	const defaults = structuredClone(DEFAULT_LANE_THRESHOLDS);
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

/** The stricter of two threshold sets, limit by limit (D33): every limit is an
    upper bound on what still counts as small, so the smaller one is stricter. */
const stricterThresholds = (a, b) => ({
	fast: Object.fromEntries(
		Object.entries(a.fast).map(([key, value]) => [key, Math.min(value, b.fast[key])]),
	),
	rigorous: { minFiles: Math.min(a.rigorous.minFiles, b.rigorous.minFiles) },
});

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

// ---- CLI (D17, S5) ----

/** A path as git and the vocabulary read it: `/` separators, no leading `./`. */
const cleanPath = (p) => p.replace(/^\.\//, "");

/** A `--quiet` git "no": exit status 1 with nothing on stderr. */
const isQuietNo = (error) => error.status === 1 && !String(error.stderr ?? "").trim();

/** git's stdout, run in `cwd`; a failure throws one line naming git. With
    `allowFailure`, a `--quiet` "no" returns "". */
const gitIn = (cwd, args, { allowFailure = false } = {}) => {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		if (allowFailure && isQuietNo(error)) return "";
		const why = String(error.stderr ?? error.message).trim().split("\n")[0];
		throw new Error(`git ${args[0]} failed: ${why}`);
	}
};

/** Files of `git diff --numstat -z` output: NUL-ended `added<TAB>deleted<TAB>path`
    records; a binary record (`-`/`-`) has no counts. */
const parseNumstat = (text) =>
	text
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const [added, deleted, path] = record.split("\t");
			return added === "-"
				? { path }
				: { path, added: Number(added), deleted: Number(deleted) };
		});

/** Changed files of a revision range (renames read as deletion plus addition). */
const rangeFiles = (root, range) =>
	parseNumstat(
		gitIn(root, ["diff", "--numstat", "-z", "--no-renames", "--end-of-options", range, "--"]),
	);

// git's empty tree: what an unborn HEAD is compared against.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const BINARY_PROBE_BYTES = 8000; // git's binary rule: a NUL in the first 8000 bytes

/** An untracked file as numstat would count it: all lines added. An entry that is
    not a regular file (a nested repository `<dir>/`, a symbolic link) has no counts
    (S5 revision 1). */
const untrackedFile = (root, path) => {
	if (!lstatSync(join(root, path)).isFile()) return { path };
	const bytes = readFileSync(join(root, path));
	if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { path };
	let added = bytes.filter((byte) => byte === 0x0a).length;
	if (bytes.length > 0 && bytes.at(-1) !== 0x0a) added++;
	return { path, added, deleted: 0 };
};

/** True when `ref` does not exist at all: git lists nothing and warns about nothing
    (a broken ref is listed, or warned about, so it never reads as absent). */
const isAbsentRef = (root, ref) => {
	const result = spawnSync("git", ["for-each-ref", "--format=%(refname)", ref], {
		cwd: root,
		encoding: "utf-8",
	});
	return result.status === 0 && !result.stdout.trim() && !result.stderr.trim();
};

/** What the working tree is compared against: HEAD, or the empty tree when HEAD
    names a branch with no commit yet. A HEAD that exists but does not resolve is a
    broken call, never "unborn" (S5 revision 1, degrade-distinguishes-broken). */
const headBase = (root) => {
	const quiet = { allowFailure: true };
	if (gitIn(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], quiet))
		return "HEAD";
	const branch = gitIn(root, ["symbolic-ref", "--quiet", "HEAD"], quiet).trim();
	if (branch && isAbsentRef(root, branch)) return EMPTY_TREE;
	throw new Error("git rev-parse failed: HEAD does not name a commit");
};

/** Tracked changes against HEAD (staged and unstaged) plus untracked files. */
const workingFiles = (root) => {
	const base = headBase(root);
	const untracked = gitIn(root, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean);
	return [...rangeFiles(root, base), ...untracked.map((path) => untrackedFile(root, path))];
};

// A hub is imported by at least this many other modules (deep-review's [hub] rule,
// references/discovery-map.md; D17).
const HUB_MIN_FAN_IN = 3;
/** A graph or changed path as compared: `/` separators, no leading `./`. */
const graphKey = (p) => cleanPath(slashed(p));

/** The counted [importer, imported] edges of a dependency-cruiser `modules` list,
    or the first problem. Core modules and unresolved imports do not count. */
const depcruiseEdges = (modules) => {
	if (!Array.isArray(modules)) return "modules is not an array";
	const edges = [];
	for (const [i, module] of modules.entries()) {
		const found = moduleEdges(module);
		if (typeof found === "string") return `modules[${i}] ${found}`;
		edges.push(...found);
	}
	return edges;
};

const isModuleShape = (module) =>
	isPlainObject(module) &&
	typeof module.source === "string" &&
	Array.isArray(module.dependencies);
const isDependencyShape = (dependency) =>
	isPlainObject(dependency) && typeof dependency.resolved === "string";
const isCountedDependency = (dependency) =>
	!dependency.coreModule && !dependency.couldNotResolve;

/** One dependency-cruiser module's counted edges, or its problem. */
const moduleEdges = (module) => {
	if (!isModuleShape(module)) return "has no string source and dependencies array";
	if (!module.dependencies.every(isDependencyShape))
		return "has a dependency without a string resolved";
	return module.dependencies
		.filter(isCountedDependency)
		.map((dependency) => [module.source, dependency.resolved]);
};

/** The [importer, imported] edges of a madge object map, or the first problem. */
const madgeEdges = (graph) => {
	const edges = [];
	for (const [from, imports] of Object.entries(graph)) {
		if (!isStringList(imports)) return `${from} does not map to an array of strings`;
		for (const to of imports) edges.push([from, to]);
	}
	return edges;
};

/** Graph paths imported by at least HUB_MIN_FAN_IN distinct other modules. */
const hubKeys = (edges) => {
	const importers = new Map();
	for (const [from, to] of edges.map(([f, t]) => [graphKey(f), graphKey(t)])) {
		if (from === to || /(^|\/)node_modules\//.test(to)) continue;
		if (!importers.has(to)) importers.set(to, new Set());
		importers.get(to).add(from);
	}
	return [...importers]
		.filter(([, from]) => from.size >= HUB_MIN_FAN_IN)
		.map(([to]) => to);
};

/** `{ hubs }` — the changed paths a graph file names as hubs — or `{ broken }`. A
    changed path matches a hub path equal to it or ending it after a `/` (a graph
    made in a sub-directory). */
const readHubs = (graphPath, paths) => {
	let graph;
	try {
		graph = JSON.parse(readFileSync(graphPath, "utf8"));
	} catch (error) {
		return {
			broken:
				error instanceof SyntaxError
					? `invalid JSON (${error.message})`
					: `cannot read (${error.code ?? error.message})`,
		};
	}
	if (!isPlainObject(graph)) return { broken: "the top level is not an object" };
	const edges = Object.hasOwn(graph, "modules")
		? depcruiseEdges(graph.modules)
		: madgeEdges(graph);
	if (typeof edges === "string") return { broken: edges };
	const hubs = hubKeys(edges);
	const isHub = (path) =>
		hubs.some((hub) => graphKey(path) === hub || graphKey(path).endsWith(`/${hub}`));
	return { hubs: paths.filter(isHub) };
};

/** A broken graph (D17): its diagnostic replaces `hub signal unavailable`, and fast
    rises one step (FR5 step); normal and rigorous are unchanged. */
const reportBrokenGraph = (result, graph, broken) => {
	const diagnostics = result.diagnostics.filter((d) => d !== "hub signal unavailable");
	diagnostics.push(`hub signal broken: ${graph}: ${broken}`);
	if (result.lane !== "fast") return { ...result, diagnostics };
	return {
		lane: "normal",
		reasons: [...result.reasons, "hub signal broken: raised to normal"],
		diagnostics,
	};
};

const USAGE =
	"usage: lane.mjs (--range <revision-range> | --working | --paths <path>...) [--slices <n>] [--graph <file>]";
const MODES = ["--range", "--working", "--paths"];

/** The value after option `argv[i]`; a missing one (or another option) is a broken call. */
const optionValue = (argv, i) => {
	const value = argv[i + 1];
	check(value !== undefined && !value.startsWith("--"), `${argv[i]} needs a value`);
	return value;
};

/** The words after `argv[i]` up to the next option. */
const wordsAfter = (argv, i) => {
	const end = argv.findIndex((word, j) => j > i && word.startsWith("--"));
	return argv.slice(i + 1, end === -1 ? argv.length : end);
};

// Each option reads its value(s) into `options` and returns how many words it took.
const OPTIONS = {
	"--working": () => 0,
	"--paths": (argv, i, options) => {
		const paths = wordsAfter(argv, i);
		check(paths.length > 0, "--paths needs at least one path");
		options.paths.push(...paths);
		return paths.length;
	},
	"--range": (argv, i, options) => {
		options.range = optionValue(argv, i);
		return 1;
	},
	"--graph": (argv, i, options) => {
		options.graph = optionValue(argv, i);
		return 1;
	},
	"--slices": (argv, i, options) => {
		options.slices = Number(optionValue(argv, i));
		check(isPositive(options.slices), "--slices must be a positive integer");
		return 1;
	},
};

/** The CLI options: the one mode and its argument, `--slices` and `--graph`.
    Throws a usage error naming the option, or `mode`. */
const parseArgs = (argv) => {
	const options = { paths: [] };
	for (let i = 0; i < argv.length; i++) {
		const read = OPTIONS[argv[i]];
		check(Object.hasOwn(OPTIONS, argv[i]), `unknown option ${argv[i]}; ${USAGE}`);
		i += read(argv, i, options);
	}
	const modes = argv.filter((arg) => MODES.includes(arg));
	check(modes.length === 1, `exactly one mode is needed (got ${modes.length}); ${USAGE}`);
	options.mode = modes[0].slice(2);
	return options;
};

const isDropped = (path) => isGenerated(slashed(path)) || isMedia(slashed(path));

/** The changed files the chosen mode names. */
const modeFiles = (options, root) => {
	if (options.mode === "range") return rangeFiles(root, options.range);
	if (options.mode === "working") return workingFiles(root);
	return options.paths.map((path) => ({ path: cleanPath(path) }));
};

/** The revision whose `.rpiv-lanes.json` also judges the change (D33), as
    `{ commit, label }`, or undefined when there is none. For a range it is the
    commit git excludes (the merge base of `a...b`), or a single revision itself;
    otherwise HEAD — none when HEAD is unborn, a broken call when it exists but
    names no commit (headBase). */
const baseRevision = (options, root) => {
	if (options.mode !== "range")
		return headBase(root) === "HEAD" ? { commit: "HEAD", label: "HEAD" } : undefined;
	// rev-parse echoes `--end-of-options` itself: keep only the object ids it prints.
	const revisions = gitIn(root, ["rev-parse", "--end-of-options", options.range])
		.split("\n")
		.filter((line) => /^\^?[0-9a-f]{40,64}$/.test(line.trim()))
		.map((line) => line.trim());
	const excluded = revisions.filter((rev) => rev.startsWith("^")).at(-1);
	const label = options.range.split(/\.\.\.?/)[0] || "HEAD";
	return { commit: excluded ? excluded.slice(1) : revisions[0], label };
};

/** Thresholds from `.rpiv-lanes.json` at `commit`; the defaults when it has none,
    so a new local file can tighten but never loosen (S22 revision 1). */
const thresholdsAt = (root, commit) => {
	const entry = gitIn(root, ["ls-tree", "-z", commit, "--", CONFIG_FILE]);
	if (!entry) return structuredClone(DEFAULT_LANE_THRESHOLDS);
	return thresholdsFromText(gitIn(root, ["cat-file", "blob", `${commit}:${CONFIG_FILE}`]));
};

/** The thresholds a change is judged by — the stricter of the disk file and the
    base revision's file (D33) — and, when the base file is broken, its
    `{ label, detail }`; a broken base file contributes the defaults, like a
    missing one (S22 revision 2). */
const judgingThresholds = (options, root) => {
	const disk = loadLaneThresholds(root);
	const base = baseRevision(options, root);
	const atBase = base && thresholdsAt(root, base.commit);
	if (!atBase) return { thresholds: disk };
	const merged = stricterThresholds(disk, atBase);
	return {
		thresholds: disk.broken === undefined ? merged : { ...merged, broken: disk.broken },
		...(atBase.broken !== undefined && {
			baseBroken: { label: base.label, detail: atBase.broken },
		}),
	};
};

/** A broken base-revision config: its diagnostic after any disk one, and the
    same one-step raise as a broken disk file (fast -> normal, once). */
const reportBrokenBase = (result, { label, detail }) => {
	const diagnostics = [...result.diagnostics];
	const at = diagnostics[0]?.startsWith("broken config: ") ? 1 : 0;
	diagnostics.splice(at, 0, `broken config: ${CONFIG_FILE} at ${label}: ${detail}`);
	if (result.lane !== "fast") return { ...result, diagnostics };
	return {
		lane: "normal",
		reasons: [...result.reasons, "broken config: raised to normal"],
		diagnostics,
	};
};

/** What a CLI call classifies: its parsed options, repository root, every listed
    file and the files kept after generated/media paths are dropped. Throws on a
    broken call. */
const cliInput = (argv, cwd) => {
	const options = parseArgs(argv);
	const root = gitIn(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const listed = modeFiles(options, root);
	return { options, root, listed, files: listed.filter((file) => !isDropped(file.path)) };
};

/** The changed files a CLI call judges, for callers that ask about the same
    change (S8's Jev shadow): `{ mode, files: [repo-relative paths], slices }`.
    Throws on a broken call, as the CLI would. */
export const laneInput = (argv, cwd) => {
	const { options, files } = cliInput(argv, cwd);
	return { mode: options.mode, files: files.map((file) => slashed(file.path)), slices: options.slices };
};

/** The CLI's stdout for `argv`, run in `cwd`; throws on a broken call. */
const runCli = (argv, cwd) => {
	const { options, root, listed, files } = cliInput(argv, cwd);
	const signal =
		options.graph === undefined
			? {}
			: readHubs(resolve(cwd, options.graph), files.map((file) => file.path));
	const judged = judgingThresholds(options, root);
	let result = classifyLane(
		{ files, slices: options.slices, hubs: signal.hubs },
		judged.thresholds,
	);
	if (judged.baseBroken !== undefined) result = reportBrokenBase(result, judged.baseBroken);
	if (signal.broken !== undefined)
		result = reportBrokenGraph(result, options.graph, signal.broken);
	const { lane, reasons, diagnostics } = result;
	const dropped = listed.length - files.length;
	if (dropped) diagnostics.push(`excluded generated/media files: ${dropped}`);
	return [
		`lane: ${lane}`,
		...reasons.map((reason) => `reason: ${reason}`),
		...diagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`),
	]
		.map((line) => `${line}\n`)
		.join("");
};

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (error) {
		// A broken call never prints a lane (degrade-distinguishes-broken).
		const detail = String(error?.message ?? error).split("\n")[0];
		process.stderr.write(`lane: broken: ${detail}\n`);
		process.exitCode = 2;
	}
}
