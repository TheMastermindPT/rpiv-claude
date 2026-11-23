// tool-probe.mjs — read-only capability probe for the architectural-review skill.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/tool-probe.mjs" "<target>"...
//
// Detects which external analysis tools are available and which review LENS each one
// sharpens, classifying each as:
//   configured              — has a config file or a dedicated npm script
//   installed               — the binary is present; the tool needs no config to run
//                             (jscpd, madge, ast-grep, opengrep, rg emit this)
//   installed-unconfigured  — the binary/dep is present but nothing configures it
//   absent                  — not installed
//
// It NEVER runs the heavy analysis tools and NEVER installs anything — it only reads
// the manifest + checks for config files / installed binaries (note: binary detection
// version-checks candidate executables, including repo-local ones like bin/atlas — a
// probe of an untrusted repo does execute that repo's binary). Python tools are read
// from the root's `.venv` (`*.dist-info` folders), never run, and `uv` is never called.
// The skill (Step 2) decides what to RUN (with consent) and what to SUGGEST.
// execFileSync-only; always exit 0.
//
// Output:
//   root:      <the first project root>
//   ecosystem: <js-ts | rust | go | python | unknown>
//   also_root: <path> \t ecosystem=<eco>      (one line per further project root)
//   ---tool-coverage---  tool \t lens=L \t status=... \t <key=val ...>
//                        (a further root's ecosystem rows end with \t root=<path>)
//
// Each target's project root is its nearest package.json or pyproject.toml (D33 of the
// Python-support design, S4-probe-roots); every distinct root is probed (D34). The
// language-agnostic rows and ---report-status--- come from the first root. Registry is
// ecosystem-keyed: JS/TS and Python are wired; other ecosystems are descriptive stubs.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { findProjectRoot } from "./project-root.mjs";

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch {
		return fb;
	}
};
const toPosix = (p) => p.replaceAll("\\", "/");
const gitTop = toPosix(safe(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
const targetArgs = process.argv
	.slice(2)
	.map((a) => toPosix(String(a).replace(/^['"]|['"]$/g, "")))
	.filter((a) => a && !a.startsWith("--"));
const targetsAbs = (targetArgs.length ? targetArgs : ["."]).map((t) =>
	isAbsolute(t) ? toPosix(t) : toPosix(resolve(process.cwd(), t)),
);
// Project root = nearest package.json or pyproject.toml at/above the target, bounded by
// the git toplevel (findProjectRoot, _shared/project-root.mjs). Assuming the manifest
// sits AT the git root is wrong whenever the project is nested under the repo (our
// rpiv/, or a monorepo package): the probe then reads no manifest and reports every
// tool "absent".
const projectRoots = [...new Set(targetsAbs.map((t) => findProjectRoot(t, gitTop)))];

/** The ecosystem a root's manifests name. */
const ecosystemOf = (pkg, has) => {
	if (pkg) return "js-ts";
	if (has("Cargo.toml")) return "rust";
	if (has("go.mod")) return "go";
	if (has("pyproject.toml") || has("requirements.txt")) return "python";
	return "unknown";
};

/** The root-bound readers of one project root, its package.json and its ecosystem. */
const rootContext = (root) => {
	const has = (rel) => existsSync(join(root, rel));
	const ctx = { root, has, manifestError: "" };
	ctx.firstFile = (rels) => rels.find((r) => has(r)) ?? "";
	const readJson = (rel) => {
		const p = join(root, rel);
		if (!existsSync(p)) return null; // absent — the clean no-manifest path
		try {
			return JSON.parse(readFileSync(p, "utf-8"));
		} catch {
			ctx.manifestError = `${rel} failed to parse`; // broken != absent — surfaced in the header
			return null;
		}
	};
	const pkg = readJson("package.json");
	const deps = pkg ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
	const scripts = pkg?.scripts ?? {};
	ctx.pkg = pkg;
	ctx.hasBin = (bin) => has(`node_modules/.bin/${bin}`) || has(`node_modules/.bin/${bin}.cmd`);
	ctx.installed = (dep, bin = dep) => Boolean(deps[dep]) || ctx.hasBin(bin);
	ctx.scriptMatching = (re) =>
		Object.keys(scripts).find((k) => re.test(k) || re.test(String(scripts[k]))) ?? "";
	ctx.ecosystem = ecosystemOf(pkg, has);
	return ctx;
};

const roots = projectRoots.map(rootContext);
const first = roots[0];
const root = first.root;
const firstFile = first.firstFile;

// Detect a Python package via pip (for tools like sqlfluff that aren't on PATH
// but are installed as pip packages). Checks pip show <pkg> via python/pip binary,
// without a shell (D36).
const pipAvailable = (pkg) => {
	for (const exe of ["python", "python3"]) {
		try {
			execFileSync(exe, ["-m", "pip", "show", pkg], { stdio: "pipe", timeout: 8000 });
			return exe;
		} catch {
			/* not installed */
		}
	}
	try {
		execFileSync("pip", ["show", pkg], { stdio: "pipe", timeout: 8000 });
		return "pip";
	} catch {
		/* not installed */
	}
	return "";
};

// Detect a self-contained binary. Checks PATH first, then project-local directories.
// Accepts: binAvailable(["name"]) or binAvailable(["name"], { args: ["version"], local: ["bin/name"] }).
// For tools with non-standard version flags (e.g. atlas uses "version" not "--version").
const binAvailable = (names, opts = {}) => {
	const args = opts.args || ["--version"];
	const local = opts.local || [];
	const candidates = [...names.map((n) => ({ n, abs: n })), ...local.map((p) => ({ n: p, abs: join(root, p) }))];
	for (const { n, abs } of candidates) {
		try {
			execFileSync(abs, args, { stdio: "pipe", timeout: 8000, shell: process.platform === "win32" });
			return n;
		} catch {
			/* not found at this location */
		}
	}
	return "";
};

// --- JS/TS rows -------------------------------------------------------------

// depcruise -> L (boundary erosion). Full graph + --metrics work even without rules.
const dependencyCruiserRow = ({ firstFile, installed }, row) => {
	const dcCfg = firstFile([
		".dependency-cruiser.cjs", ".dependency-cruiser.js", ".dependency-cruiser.json",
		".dependency-cruiser.mjs", ".dependency-cruiser.ts",
	]);
	const dcInst = installed("dependency-cruiser", "depcruise");
	row("dependency-cruiser", "L",
		dcCfg ? "configured" : dcInst ? "installed-unconfigured" : "absent",
		dcCfg ? [`config=${dcCfg}`]
			: dcInst ? ["hint=depcruise --init to add boundary rules"]
			: ["hint=npm i -D dependency-cruiser && npx depcruise --init"]);
	return Boolean(dcCfg) || dcInst;
};

// knip -> A (dead abstraction).
const knipRow = ({ firstFile, installed, pkg, scriptMatching }, row) => {
	const knipCfg = firstFile(["knip.json", "knip.jsonc", "knip.ts", "knip.config.ts", "knip.config.js"])
		|| (pkg?.knip ? "package.json#knip" : "")
		|| (scriptMatching(/knip/) ? `script:${scriptMatching(/knip/)}` : "");
	const knipInst = installed("knip");
	row("knip", "A",
		knipCfg ? "configured" : knipInst ? "installed-unconfigured" : "absent",
		knipCfg ? [`config=${knipCfg}`]
			: knipInst ? ["hint=add a knip config/script"]
			: ["hint=npm i -D knip"]);
};

const COVERAGE_CMDS = {
	vitest: "npx vitest run --coverage",
	jest: "npx jest --coverage",
	c8: "npx c8 node --test",
	nyc: "npx nyc --reporter=lcov node --test",
};

// Framework-aware detection: the specific binary whose coverage invocation the skill
// can run without relying on an npm script.
const coverageToolOf = ({ installed }) =>
	["vitest", "jest", "c8", "nyc"].find((tool) => installed(tool)) ?? "";

// Vitest delegates coverage to a separate provider package it does NOT depend on —
// `npx vitest run --coverage` without one dies asking for the provider (dogfooding
// #8). Pre-detect so the "Generate (~30s)" checkpoint can warn BEFORE offering it.
const coverageProviderOf = ({ installed, has }, covTool) => {
	if (covTool !== "vitest") return "";
	for (const provider of ["@vitest/coverage-v8", "@vitest/coverage-istanbul"]) {
		if (installed(provider) || has(`node_modules/${provider}`)) return provider;
	}
	return "absent";
};

// The installed-unconfigured hint prints `${covCmd}` literally (a plain string, kept
// as it was so single-root output stays unchanged; the cmd= field holds the command).
const coverageHints = (covStatus, covScript) => {
	if (covStatus === "absent") return ["hint=npm i -D vitest (or jest) + add a coverage script"];
	if (covStatus === "installed-unconfigured") return ["hint=add a `test:coverage` script or run `${covCmd}`"];
	return covScript ? [`script:${covScript}`] : [];
};

// coverage -> T (test theater). Report presence drives the checkpoint.
const coverageRow = (ctx, row) => {
	const covTool = coverageToolOf(ctx);
	const covScript = ctx.scriptMatching(/coverage/);
	const covReport = ctx.firstFile([
		"coverage/coverage-final.json", "coverage/coverage-summary.json", "coverage/lcov.info",
	]);
	const covStatus = !covTool ? "absent" : covScript ? "configured" : "installed-unconfigured";
	// The framework-specific coverage command (used by the skill checkpoint when a
	// report is absent but the framework is detected).
	const covCmd = COVERAGE_CMDS[covTool] ?? "";
	const covProvider = coverageProviderOf(ctx, covTool);
	row("coverage", "T", covStatus, [
		`tool=${covTool || "none"}`,
		`report=${covReport || "none"}`,
		...(covProvider ? [`provider=${covProvider}`] : []),
		...(covCmd ? [`cmd=${covCmd}`] : []),
		...(covProvider === "absent" ? ["hint=npm i -D @vitest/coverage-v8 first — vitest cannot generate coverage without a provider"] : []),
		...coverageHints(covStatus, covScript),
	]);
	return covReport;
};

// Broken != absent (M2 / dogfooding B): an HTML-only report means mutation RAN but
// is not machine-ingestable — distinct from no report at all, with a sharper remedy.
const strykerHtmlOnlyOf = (root) => {
	try {
		const html = readdirSync(join(root, "reports", "mutation")).find((f) => f.endsWith(".html"));
		return html ? `reports/mutation/${html}` : "";
	} catch {
		return ""; // no reports/mutation dir — plain absent
	}
};

// Stale != present (dogfooding #2): with an html-only reporter config the last json
// survives untouched, so "present" could be weeks old while the html is fresh. A
// sibling html markedly newer than the json (60s slack covers same-run reporter
// ordering) flags stale-json so the checkpoint re-offers the run instead of parsing it.
const strykerStaleOf = (root, strykerReport) => {
	try {
		const dir = join(root, "reports", "mutation");
		const jsonM = statSync(join(root, strykerReport)).mtimeMs;
		let newestHtml = 0;
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".html")) newestHtml = Math.max(newestHtml, statSync(join(dir, f)).mtimeMs);
		}
		return newestHtml - jsonM > 60_000 ? "stale" : "";
	} catch {
		return ""; // no html sibling — nothing to cross-check
	}
};

const strykerReportField = ({ strykerReport, strykerHtmlOnly, strykerStale }) => {
	if (strykerStale) return `stale-json:${strykerReport}`;
	if (strykerReport) return strykerReport;
	return strykerHtmlOnly ? `html-only:${strykerHtmlOnly}` : "none";
};

const strykerStatusHints = (strykerStatus) => {
	if (strykerStatus === "absent") return ["hint=npm i -D @stryker-mutator/core (mutation testing — catches covered-but-unverified code)"];
	if (strykerStatus === "installed-unconfigured") return ["hint=run `npx stryker init` to create a config"];
	return [];
};

// stryker -> T (mutation testing). Detects @stryker-mutator/core in deps or
// stryker.config.* file. Mutation score distinguishes genuine test coverage
// from test theater: high coverage + low mutation score = THEATER.
const strykerRow = ({ root, firstFile, installed }, row) => {
	const strykerInst = installed("@stryker-mutator/core", "stryker");
	const strykerCfg = firstFile([
		"stryker.config.mjs", "stryker.config.js", "stryker.config.json",
		"stryker.config.cjs", ".stryker.conf.json",
	]);
	const strykerReport = firstFile([
		"reports/mutation/mutation.json", "reports/mutation.json",
		"stryker-output/mutation.json",
	]);
	const state = {
		strykerReport,
		strykerHtmlOnly: strykerReport ? "" : strykerHtmlOnlyOf(root),
		strykerStale: strykerReport ? strykerStaleOf(root, strykerReport) : "",
	};
	const strykerStatus = !strykerInst ? "absent"
		: strykerCfg ? "configured"
		: "installed-unconfigured";
	row("stryker", "T", strykerStatus, [
		`report=${strykerReportField(state)}`,
		...(strykerCfg ? [`config=${strykerCfg}`] : []),
		...(state.strykerStale ? ['hint=mutation.json predates the html report — add "json" to stryker reporters and re-run'] : []),
		...(state.strykerHtmlOnly ? ['hint=add "json" to stryker reporters for machine ingest'] : []),
		...strykerStatusHints(strykerStatus),
	]);
	return state;
};

// ts-morph -> S/Fe/A. Resolved relative to THIS helper: ts-morph is a plugin
// runtime dependency (the plugin's package.json), NOT a dependency of the reviewed repo. Needs a
// tsconfig for semantic.mjs to load a Project.
const tsMorphRow = ({ firstFile }, row) => {
	let tsMorphPath = "";
	try {
		tsMorphPath = createRequire(import.meta.url).resolve("ts-morph");
	} catch {
		tsMorphPath = "";
	}
	const tsCfg = firstFile(["tsconfig.json", "tsconfig.base.json"]);
	const tsmStatus = !tsMorphPath ? "absent" : tsCfg ? "configured" : "installed-unconfigured";
	row("ts-morph", "S/Fe/A", tsmStatus, [
		...(tsMorphPath ? [`path=${toPosix(tsMorphPath)}`] : []),
		...(tsCfg ? [`tsconfig=${tsCfg}`] : []),
		...(tsmStatus === "absent" ? ["hint=run pnpm install in the rpiv plugin (ts-morph is a plugin dependency; sharpens write-site ownership, feature-envy, dead-exports)"]
			: tsmStatus === "installed-unconfigured" ? ["hint=add a tsconfig.json so semantic.mjs can load a Project"]
			: []),
	]);
};

// jscpd -> D (duplication). v5 is a self-contained Rust binary on PATH (also `cpd`),
// NOT a node module — detect via the CLI, not require-resolve. Works without a config.
const jscpdRow = ({ firstFile, pkg }, row) => {
	const jscpdBin = binAvailable(["jscpd", "cpd"]);
	// jscpd does NOT auto-load any of these: a configured repo's file must be passed with -c.
	const jscpdCfg = firstFile([".jscpd.json", ".jscpd.jsonc", "jscpd.json"]) || (pkg?.jscpd ? "package.json#jscpd" : "");
	row("jscpd", "D",
		jscpdBin ? (jscpdCfg ? "configured" : "installed") : "absent",
		[
			...(jscpdBin ? [`bin=${jscpdBin}`] : []),
			...(jscpdCfg ? [`config=${jscpdCfg}`] : []),
			...(jscpdBin ? [] : ["hint=npm i -g jscpd@5 (Rust engine) — dedicated copy/paste detector for D"]),
		]);
};

// madge -> cycles. dependency-cruiser's `circular` already covers cycles, so madge
// overlaps it — only worth suggesting when depcruise is ABSENT (run the better tool, no overlap).
const madgeRow = ({ installed }, row, depcruisePresent) => {
	const madgeInst = installed("madge");
	row("madge", "cycles", madgeInst ? "installed" : "absent",
		madgeInst
			? (depcruisePresent ? ["note=redundant: dependency-cruiser already reports circular"] : [])
			: depcruisePresent
				? ["note=not needed: dependency-cruiser covers cycles"]
				: ["hint=npm i -D madge (fallback module graph for L — cycles + stability.mjs SDP/instability derivations; or prefer depcruise)"]);
};

/** The JS/TS rows of a root; returns its coverage and mutation report state. */
const jsRows = (ctx, row) => {
	const depcruisePresent = dependencyCruiserRow(ctx, row);
	knipRow(ctx, row);
	const covReport = coverageRow(ctx, row);
	const stryker = strykerRow(ctx, row);
	tsMorphRow(ctx, row);
	jscpdRow(ctx, row);
	madgeRow(ctx, row, depcruisePresent);
	return { covReport, ...stryker };
};

// --- Python rows (FR2, FR3, D35) ----------------------------------------------

// Each tool: its row name, lens, `*.dist-info` name, `uv add --dev` package, the
// pyproject sections and files that configure it, and whether it needs a config to run.
const PYTHON_TOOLS = [
	{ tool: "pytest", lens: "T", dist: "pytest", pkg: "pytest", sections: ["tool.pytest.ini_options"], files: ["pytest.ini"] },
	{ tool: "coverage.py", lens: "T", dist: "coverage", pkg: "coverage", sections: ["tool.coverage"], files: [".coveragerc"] },
	{ tool: "cosmic-ray", lens: "T", dist: "cosmic_ray", pkg: "cosmic-ray", sections: [], files: ["cosmic-ray.toml"], needsConfig: true },
	{ tool: "ruff", lens: "lint", dist: "ruff", pkg: "ruff", sections: ["tool.ruff"], files: ["ruff.toml", ".ruff.toml"] },
	{ tool: "vulture", lens: "A", dist: "vulture", pkg: "vulture", sections: ["tool.vulture"], files: [] },
	{ tool: "import-linter", lens: "L", dist: "import_linter", pkg: "import-linter", sections: ["tool.importlinter"], files: [".importlinter"], needsConfig: true },
	{ tool: "grimp", lens: "L", dist: "grimp", pkg: "grimp", sections: [], files: [] },
	{ tool: "pyright", lens: "S/Fe/A", dist: "pyright", pkg: "pyright", sections: ["tool.pyright"], files: ["pyrightconfig.json"] },
];

const listDir = (dir) => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

/** The site-packages folders of a root's `.venv`: Windows `Lib/`, else `lib/python*`. */
const sitePackagesOf = (root) => [
	join(root, ".venv", "Lib", "site-packages"),
	...listDir(join(root, ".venv", "lib"))
		.filter((name) => name.startsWith("python"))
		.map((name) => join(root, ".venv", "lib", name, "site-packages")),
];

/** The installed distributions of a root's `.venv`, by normalized name; nothing is run. */
const installedDists = (root) =>
	new Set(
		sitePackagesOf(root)
			.flatMap(listDir)
			.filter((name) => name.endsWith(".dist-info") && name.includes("-"))
			.map((name) => name.slice(0, name.indexOf("-")).toLowerCase().replace(/[-.]/g, "_")),
	);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The file that configures `tool` in a root: one of its own files, else pyproject.toml
    when it holds one of the tool's sections (`[tool.ruff]`, `[tool.ruff.lint]`). */
const pythonConfigOf = ({ firstFile }, tool, pyproject) => {
	const own = firstFile(tool.files);
	if (own) return own;
	const inPyproject = tool.sections.some((section) =>
		new RegExp(`^\\[${escapeRegExp(section)}(?:\\]|\\.)`, "m").test(pyproject),
	);
	return inPyproject ? "pyproject.toml" : "";
};

const pythonStatus = (tool, installed, config) => {
	if (!installed) return "absent";
	if (config) return "configured";
	return tool.needsConfig ? "installed-unconfigured" : "installed";
};

const pythonExtras = (tool, status, config) => {
	if (status === "absent") return [`hint=uv add --dev ${tool.pkg}`];
	if (config) return [`config=${config}`];
	return tool.needsConfig ? [`hint=add a ${tool.tool} config`] : [];
};

/** The Python rows of a root, read from its `.venv` and config files. */
const pythonRows = (ctx, row) => {
	const dists = installedDists(ctx.root);
	const pyprojectPath = join(ctx.root, "pyproject.toml");
	const pyproject = existsSync(pyprojectPath) ? readFileSync(pyprojectPath, "utf-8") : "";
	for (const tool of PYTHON_TOOLS) {
		const config = pythonConfigOf(ctx, tool, pyproject);
		const status = pythonStatus(tool, dists.has(tool.dist), config);
		row(tool.tool, tool.lens, status, pythonExtras(tool, status, config));
	}
	return {};
};

/** One root's ecosystem rows into `out`; `suffix` fields end each row (a further root's
    `root=`). Returns the root's report state (empty outside JS/TS). */
const ecosystemRows = (ctx, out, suffix = []) => {
	const row = (tool, lens, status, extras = []) =>
		out.push([tool, `lens=${lens}`, `status=${status}`, ...extras, ...suffix].join("\t"));
	if (ctx.ecosystem === "js-ts") return jsRows(ctx, row);
	if (ctx.ecosystem === "python") return pythonRows(ctx, row);
	if (ctx.ecosystem === "unknown") {
		out.push("(no recognized manifest — no tool registry to probe)");
		return {};
	}
	out.push(`(ecosystem=${ctx.ecosystem}: registry rows not yet wired — JS/TS and Python detection only)`);
	out.push("(what WOULD sharpen each lens here: L=import-linter/staticcheck/clippy, A=vulture/deadcode/cargo-udeps, T=coverage.py/go test -cover/cargo llvm-cov)");
	return {};
};

const out = [];
const {
	covReport = "",
	strykerReport = "",
	strykerHtmlOnly = "",
	strykerStale = "",
} = ecosystemRows(first, out);
for (const other of roots.slice(1)) ecosystemRows(other, out, [`root=${other.root}`]);
const row = (tool, lens, status, extras = []) =>
	out.push([tool, `lens=${lens}`, `status=${status}`, ...extras].join("\t"));

// Language-agnostic structural tools — ecosystem-independent, so they emit regardless of the
// manifest-keyed registry above. All are self-contained PATH binaries (binAvailable, NOT
// createRequire). Run read-only via _shared/structural.mjs, which never passes the mutate
// flags (rewrite / update-all / interactive / autofix).

// ast-grep -> D/M (AST-structural patterns). Prefer `ast-grep` over `sg` (sg collides with
// setgid on some systems). Config: sgconfig.yml -> configured.
const astgrepBin = binAvailable(["ast-grep", "sg"]);
const astgrepCfg = firstFile(["sgconfig.yml", "sgconfig.yaml"]);
row("ast-grep", "D/M",
	astgrepBin ? (astgrepCfg ? "configured" : "installed") : "absent",
	[
		...(astgrepBin ? [`bin=${astgrepBin}`] : []),
		...(astgrepCfg ? [`config=${astgrepCfg}`] : []),
		...(astgrepBin ? [] : ["hint=install ast-grep (sharpens D/M structural patterns)"]),
	]);

// opengrep -> L/M (Semgrep-fork rules). Config files -> configured; registry configs (auto,
// p/...) need network (used live by deep-review Security).
const opengrepBin = binAvailable(["opengrep", "semgrep"]);
const opengrepCfg = firstFile([".opengrep.yml", ".semgrep.yml", "semgrep.yml", ".semgrep.yaml"]);
row("opengrep", "L/M",
	opengrepBin ? (opengrepCfg ? "configured" : "installed") : "absent",
	[
		...(opengrepBin ? [`bin=${opengrepBin}`] : []),
		...(opengrepCfg ? [`config=${opengrepCfg}`] : []),
		...(opengrepBin ? [] : ["hint=install opengrep (sharpens deep-review Security via stock rules)"]),
	]);

// ast-grep arch-lint pack -> G/Lc/D/C/M/S/Fe/A. Scans the target with curated
// architectural rules (missing abstractions, duplicate shapes, code smells).
// Config: tools/arch-lint/sgconfig.yml
const astgrepArchCfg = firstFile(["tools/arch-lint/sgconfig.yml"]);
const astgrepArch = astgrepBin && astgrepArchCfg ? "configured" : "absent";
row("ast-grep/arch-lint", "G/Lc/D/C/M/S/Fe/A", astgrepArch,
	astgrepArch === "configured"
		? [`config=${astgrepArchCfg}`]
		: ["hint=create tools/arch-lint/sgconfig.yml with curated arch rules"]);

// opengrep arch-lint pack -> Sec/M. Taint-aware security and missing-abstraction
// rules. Config: tools/arch-lint/opengrep/ directory with .yml rules.
const opengrepArchDir = firstFile(["tools/arch-lint/opengrep"]);
const opengrepArch = opengrepBin && opengrepArchDir ? "configured" : "absent";
row("opengrep/arch-lint", "Sec/M", opengrepArch,
	opengrepArch === "configured"
		? [`dir=${opengrepArchDir}`]
		: ["hint=create tools/arch-lint/opengrep/ with taint and security rules"]);

// SQLFluff → Db/P (SQL migration linting). Detects pip-installed sqlfluff + migration
// directory or ORM config. Project-agnostic: works for Supabase, Prisma, Drizzle, Knex.
const sqlfluffBin = binAvailable(["sqlfluff"]) || pipAvailable("sqlfluff");
const migrationDir = firstFile(["supabase/migrations/", "prisma/", "migrations/"]);
const ormConfig = firstFile(["prisma/schema.prisma", "drizzle.config.ts", "drizzle.config.js", "knexfile.ts", "knexfile.js"]);
const hasDbSurface = Boolean(migrationDir || ormConfig);
const sqlfluffStatus = sqlfluffBin && hasDbSurface ? "configured" : (sqlfluffBin ? "installed" : "absent");
row("sqlfluff", "Db/P", sqlfluffStatus,
	sqlfluffStatus === "configured" ? [`bin=${sqlfluffBin}`, `migrations=${migrationDir || ormConfig}`] :
	sqlfluffStatus === "installed" ? [`bin=${sqlfluffBin}`, "hint=add migrations/ directory or ORM config"] :
	["hint=pip install sqlfluff (SQL linting for migration files)"]);

// Atlas → Db/P (schema management). Detects standalone binary + DB surface.
// Atlas uses `atlas version` (subcommand), not `--version` (flag). Also checks
// project-local install (common for standalone binaries downloaded manually).
const atlasBin = binAvailable(["atlas"], { args: ["version"], local: ["bin/atlas", "bin/atlas.exe"] });
const atlasStatus = atlasBin && hasDbSurface ? "configured" : (atlasBin ? "installed" : "absent");
row("atlas", "Db/P", atlasStatus,
	atlasStatus === "configured" ? [`bin=${atlasBin}`] :
	atlasStatus === "installed" ? [`bin=${atlasBin}`, "hint=add migrations/ directory or ORM config"] :
	["hint=install atlas (atlasgo.io — schema migration management)"]);

// likec4 -> L/A + drift (declared architecture-as-code model). Detection is the MODEL's
// presence, not the CLI's: tracked *.c4/*.likec4 files via git ls-files (respects
// .gitignore, so untracked sandbox copies — e.g. .stryker-tmp mirrors — never count).
// The CLI itself is npx-resolvable on demand, so no install detection is needed.
const c4Files = safe(["ls-files", "*.c4", "*.likec4"]).split("\n").filter(Boolean);
const c4Cfg = firstFile(["likec4.config.json", "likec4.config.ts", "likec4.config.js", "likec4.config.mjs", ".likec4rc"]);
row("likec4", "L/A/drift", c4Files.length > 0 ? "configured" : "absent",
	c4Files.length > 0
		? [`files=${c4Files.length}`, `first=${toPosix(c4Files[0])}`, ...(c4Cfg ? [`config=${c4Cfg}`] : [])]
		: ["hint=declare the architecture in a .c4 model (likec4.dev) to enable declared-vs-actual conformance"]);

// rg (ripgrep) -> search. No project config by convention (config is the RIPGREP_CONFIG_PATH
// env var, not a tracked file) -> installed | absent only. Orchestrator prefers rg over literal grep/find.
const rgBin = binAvailable(["rg"]);
row("rg", "search", rgBin ? "installed" : "absent",
	rgBin ? [`bin=${rgBin}`] : ["hint=install ripgrep (rg)"]);

// --- Report status summary (drives the checkpoint) -------------------------
const covRpt = covReport ? "present" : "absent";
const mutRpt = strykerReport ? (strykerStale ? "stale-json" : "present") : strykerHtmlOnly ? "html-only" : "absent";
const archAstRpt = astgrepArch === "configured" ? "present" : "absent";
const archOgRpt = opengrepArch === "configured" ? "present" : "absent";
const dbRpt = hasDbSurface ? "present" : "absent";

/** One `also_root:` line per further root (D34), with its manifest error when broken. */
const alsoRoots = roots
	.slice(1)
	.map((r) => `also_root: ${r.root}\tecosystem=${r.ecosystem}${r.manifestError ? `\tmanifest=error — ${r.manifestError}` : ""}\n`)
	.join("");

process.stdout.write(
	`root:      ${root}\necosystem: ${first.ecosystem}\n${alsoRoots}${first.manifestError ? `manifest:  error — ${first.manifestError}\n` : ""}---tool-coverage---\n${out.join("\n")}\n---report-status---\ncoverage: ${covRpt}\nmutation: ${mutRpt}\narch-lint-ast: ${archAstRpt}\narch-lint-og: ${archOgRpt}\ndb-tools: ${dbRpt}\n`,
);
process.exit(0);
