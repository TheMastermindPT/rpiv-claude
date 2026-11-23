// python-graph.mjs — a Python root's import graph from grimp, written as madge-shaped
// JSON of files, so stability.mjs (--graph) and the likec4 conformance check read it
// unchanged (FR18; D46–D48, D50 of the Python-support design, S7-python-graph).
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/python-graph.mjs" \
//     "<target>" --out <scratchpad>/python-graph.json [--package <name>]...
//
// Read-only: it runs the root's own `.venv` python with `-I -B` and grimp's
// `build_graph(<packages>, cache_dir=None)` (no cache, no bytecode), with the source
// folder (`<root>/src` when it exists, else the root) first on `sys.path`. Packages are
// the `--package` values, else the folders holding `__init__.py` directly under the
// source folder, apart from `tests`, `test` and names starting with `.` or `_`. A module
// maps to its `.py` or `__init__.py` file; a module with no file (a namespace folder) is
// no node. It installs nothing; grimp does not feed lane.
//
// Output (always exit 0), one status line: `python-graph: ok modules=<n> edges=<m>` (the
// JSON written to --out), `python-graph: unavailable: <why>` (no .venv python, no
// package, grimp not installed) or `python-graph: broken: <why>` (grimp or python
// failed; nothing is written).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { venvTool } from "./import-contracts.mjs";
import { resolveTargets, toPosix } from "./target-context.mjs";

const GRAPH_SCRIPT = `
import json, os, sys
src, pkgs = sys.argv[1], sys.argv[2:]
sys.path.insert(0, src)
try:
    import grimp
except ImportError:
    print(json.dumps({"status": "unavailable", "why": "grimp not installed in the .venv"}))
    sys.exit(0)
from importlib.machinery import PathFinder

def bases_of(pkg):
    spec = PathFinder.find_spec(pkg, [src])
    return [os.path.dirname(loc) for loc in (spec.submodule_search_locations or [])] if spec else []

try:
    graph = grimp.build_graph(*pkgs, cache_dir=None)
    bases = {pkg: bases_of(pkg) for pkg in pkgs}

    def file_of(module):
        for base in bases.get(module.split(".")[0], []):
            stem = os.path.join(base, *module.split("."))
            for path in (stem + ".py", os.path.join(stem, "__init__.py")):
                if os.path.isfile(path):
                    return path
        return None

    modules = sorted(graph.modules)
    print(json.dumps({
        "status": "ok",
        "files": {m: file_of(m) for m in modules},
        "imports": {m: sorted(graph.find_modules_directly_imported_by(m)) for m in modules},
    }))
except Exception as error:
    print(json.dumps({"status": "broken", "why": type(error).__name__ + ": " + str(error)}))
`;

const SKIPPED = new Set(["tests", "test"]);

/** The package folders directly under `src` (D48). */
const packagesUnder = (src) =>
	readdirSync(src, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((name) => !SKIPPED.has(name) && !/^[._]/.test(name))
		.filter((name) => existsSync(join(src, name, "__init__.py")))
		.sort();

/** `--out` and the `--package` values; the rest are targets. */
const parseArgs = (argv) => {
	const options = { packages: [], targets: [], out: "" };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--out") options.out = argv[++i] ?? "";
		else if (argv[i] === "--package") options.packages.push(argv[++i] ?? "");
		else options.targets.push(argv[i]);
	}
	return options;
};

/** grimp's result as madge JSON of files, paths made relative by `relOf`. */
const madgeOf = ({ files, imports }, relOf) => {
	const fileOf = (module) => (files[module] ? relOf(toPosix(files[module])) : null);
	const graph = {};
	for (const module of Object.keys(files).sort()) {
		const from = fileOf(module);
		if (!from) continue;
		const targets = (imports[module] ?? []).map(fileOf).filter((to) => to && to !== from);
		graph[from] = [...new Set(targets)].sort();
	}
	return graph;
};

/** The last stdout line of the python run as JSON, or a broken result. */
const resultOf = (res) => {
	if (res.error) return { status: "broken", why: String(res.error.message).split("\n")[0] };
	const last = String(res.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
	try {
		return JSON.parse(last);
	} catch {
		const why = String(res.stderr ?? "").trim().split(/\r?\n/).at(-1) || `python exited ${res.status}`;
		return { status: "broken", why };
	}
};

/** The status line, writing the graph to `out` on success. */
const run = (argv) => {
	const options = parseArgs(argv);
	if (!options.out) return "python-graph: broken: --out <file> is required";
	const { projectRoot: root, relOf } = resolveTargets(options.targets);
	const python = venvTool(root, "python");
	if (!python) return `python-graph: unavailable: no .venv python in ${root}`;
	const src = existsSync(join(root, "src")) ? `${root}/src` : root;
	const packages = options.packages.length ? options.packages : packagesUnder(src);
	if (!packages.length) return `python-graph: unavailable: no Python package under ${src}`;
	const res = spawnSync(python, ["-I", "-B", "-c", GRAPH_SCRIPT, src, ...packages], {
		cwd: root,
		encoding: "utf-8",
		timeout: 120_000,
	});
	const result = resultOf(res);
	if (result.status !== "ok") return `python-graph: ${result.status}: ${result.why}`;
	const graph = madgeOf(result, relOf);
	mkdirSync(dirname(options.out), { recursive: true });
	writeFileSync(options.out, `${JSON.stringify(graph, null, 1)}\n`);
	const edges = Object.values(graph).reduce((sum, deps) => sum + deps.length, 0);
	return `python-graph: ok modules=${Object.keys(graph).length} edges=${edges}`;
};

process.stdout.write(`${run(process.argv.slice(2))}\n`);
