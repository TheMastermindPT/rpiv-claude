// tool-probe.mjs — read-only capability probe for the architectural-review skill.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/tool-probe.mjs" "<target>"
//
// Detects which external analysis tools are available and which review LENS each one
// sharpens, classifying each as:
//   configured              — has a config file or a dedicated npm script
//   installed-unconfigured  — the binary/dep is present but nothing configures it
//   absent                  — not installed
//
// It NEVER runs the heavy tools and NEVER installs anything — it only reads the
// manifest + checks for config files / installed binaries. The skill (Step 2) decides
// what to RUN (with consent) and what to SUGGEST. execFileSync-only; always exit 0.
//
// Output:
//   root:      <repo-relative toplevel>
//   ecosystem: <js-ts | rust | go | python | unknown>
//   ---tool-coverage---  tool \t lens=L \t status=... \t <key=val ...>
//
// Registry is ecosystem-keyed; only JS/TS is wired in detail today — other ecosystems
// are descriptive stubs (cross-language support is registry growth, not special-casing).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
const root = toPosix(safe(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
const has = (rel) => existsSync(join(root, rel));
const firstFile = (rels) => rels.find((r) => has(r)) ?? "";
const readJson = (rel) => {
	try {
		return JSON.parse(readFileSync(join(root, rel), "utf-8"));
	} catch {
		return null;
	}
};

const pkg = readJson("package.json");
const deps = pkg ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
const scripts = pkg?.scripts ?? {};
const hasBin = (bin) => has(`node_modules/.bin/${bin}`) || has(`node_modules/.bin/${bin}.cmd`);
const installed = (dep, bin = dep) => Boolean(deps[dep]) || hasBin(bin);
const scriptMatching = (re) =>
	Object.keys(scripts).find((k) => re.test(k) || re.test(String(scripts[k]))) ?? "";
// Detect a Python package via pip (for tools like sqlfluff that aren't on PATH
// but are installed as pip packages). Checks pip show <pkg> via python/pip binary.
const pipAvailable = (pkg) => {
	for (const py of ["python", "python3"]) {
		try {
			execFileSync(py, ["-m", "pip", "show", pkg], { stdio: "pipe", timeout: 8000, shell: process.platform === "win32" });
			return py;
		} catch {
			/* not installed */
		}
	}
	try {
		execFileSync("pip", ["show", pkg], { stdio: "pipe", timeout: 8000, shell: process.platform === "win32" });
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

const ecosystem = pkg
	? "js-ts"
	: has("Cargo.toml")
		? "rust"
		: has("go.mod")
			? "go"
			: has("pyproject.toml") || has("requirements.txt")
				? "python"
				: "unknown";

// Report-status variables (populated in the ecosystem block below, defaulted here
// so the ---report-status--- footer always has values regardless of ecosystem).
let covReport = "";
let strykerReport = "";

const out = [];
const row = (tool, lens, status, extras = []) =>
	out.push([tool, `lens=${lens}`, `status=${status}`, ...extras].join("\t"));

if (ecosystem === "js-ts") {
	// depcruise -> L (boundary erosion). Full graph + --metrics work even without rules.
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

	// knip -> A (dead abstraction).
	const knipCfg = firstFile(["knip.json", "knip.jsonc", "knip.ts", "knip.config.ts", "knip.config.js"])
		|| (pkg?.knip ? "package.json#knip" : "")
		|| (scriptMatching(/knip/) ? `script:${scriptMatching(/knip/)}` : "");
	const knipInst = installed("knip");
	row("knip", "A",
		knipCfg ? "configured" : knipInst ? "installed-unconfigured" : "absent",
		knipCfg ? [`config=${knipCfg}`]
			: knipInst ? ["hint=add a knip config/script"]
			: ["hint=npm i -D knip"]);

	// coverage -> T (test theater). Report presence drives the checkpoint.
	// Framework-aware detection: captures the specific binary + its coverage invocation
	// so the skill can generate coverage without relying on an npm script.
	const covTool = installed("vitest") ? "vitest"
		: installed("jest") ? "jest"
		: installed("c8") ? "c8"
		: installed("nyc") ? "nyc"
		: "";
	const covScript = scriptMatching(/coverage/);
	covReport = firstFile([
		"coverage/coverage-final.json", "coverage/coverage-summary.json", "coverage/lcov.info",
	]);
	const covStatus = !covTool ? "absent" : covScript ? "configured" : "installed-unconfigured";
	// Derive the framework-specific coverage command (used by the skill checkpoint when
	// a report is absent but the framework is detected).
	let covCmd = "";
	if (covTool === "vitest") covCmd = "npx vitest run --coverage";
	else if (covTool === "jest") covCmd = "npx jest --coverage";
	else if (covTool === "c8") covCmd = "npx c8 node --test";
	else if (covTool === "nyc") covCmd = "npx nyc --reporter=lcov node --test";
	row("coverage", "T", covStatus, [
		`tool=${covTool || "none"}`,
		`report=${covReport || "none"}`,
		...(covCmd ? [`cmd=${covCmd}`] : []),
		...(covStatus === "absent" ? ["hint=npm i -D vitest (or jest) + add a coverage script"]
			: covStatus === "installed-unconfigured" ? ["hint=add a `test:coverage` script or run `${covCmd}`"]
			: covScript ? [`script:${covScript}`] : []),
	]);

	// stryker -> T (mutation testing). Detects @stryker-mutator/core in deps or
	// stryker.config.* file. Mutation score distinguishes genuine test coverage
	// from test theater: high coverage + low mutation score = THEATER.
	const strykerInst = installed("@stryker-mutator/core", "stryker");
	const strykerCfg = firstFile([
		"stryker.config.mjs", "stryker.config.js", "stryker.config.json",
		"stryker.config.cjs", ".stryker.conf.json",
	]);
	strykerReport = firstFile([
		"reports/mutation/mutation.json", "reports/mutation.json",
		"stryker-output/mutation.json",
	]);
	const strykerStatus = !strykerInst ? "absent"
		: strykerCfg ? "configured"
		: "installed-unconfigured";
	row("stryker", "T", strykerStatus, [
		`report=${strykerReport || "none"}`,
		...(strykerCfg ? [`config=${strykerCfg}`] : []),
		...(strykerStatus === "absent" ? ["hint=npm i -D @stryker-mutator/core (mutation testing — catches covered-but-unverified code)"]
			: strykerStatus === "installed-unconfigured" ? ["hint=run `npx stryker init` to create a config"]
			: []),
	]);

	// ts-morph -> S/Fe/A. Resolved relative to THIS helper (it may be installed off the
	// project manifest, e.g. a home-dir node_modules), NOT via package.json deps. Needs a
	// tsconfig for semantic.mjs to load a Project.
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
		...(tsmStatus === "absent" ? ["hint=npm i -D ts-morph (sharpens write-site ownership, feature-envy, dead-exports)"]
			: tsmStatus === "installed-unconfigured" ? ["hint=add a tsconfig.json so semantic.mjs can load a Project"]
			: []),
	]);

	// jscpd -> D (duplication). v5 is a self-contained Rust binary on PATH (also `cpd`),
	// NOT a node module — detect via the CLI, not require-resolve. Works without a config.
	const jscpdBin = binAvailable(["jscpd", "cpd"]);
	const jscpdCfg = firstFile([".jscpd.json", ".jscpd.jsonc"]) || (pkg?.jscpd ? "package.json#jscpd" : "");
	row("jscpd", "D",
		jscpdBin ? (jscpdCfg ? "configured" : "installed") : "absent",
		[
			...(jscpdBin ? [`bin=${jscpdBin}`] : []),
			...(jscpdCfg ? [`config=${jscpdCfg}`] : []),
			...(jscpdBin ? [] : ["hint=npm i -g jscpd@5 (Rust engine) — dedicated copy/paste detector for D"]),
		]);

	// madge -> cycles. dependency-cruiser's `circular` already covers cycles, so madge
	// overlaps it — only worth suggesting when depcruise is ABSENT (run the better tool, no overlap).
	const depcruisePresent = Boolean(dcCfg) || dcInst;
	const madgeInst = installed("madge");
	row("madge", "cycles", madgeInst ? "installed" : "absent",
		madgeInst
			? (depcruisePresent ? ["note=redundant: dependency-cruiser already reports circular"] : [])
			: depcruisePresent
				? ["note=not needed: dependency-cruiser covers cycles"]
				: ["hint=npm i -D madge (cycle detection; or prefer depcruise)"]);
} else if (ecosystem === "unknown") {
	out.push("(no recognized manifest — no tool registry to probe)");
} else {
	out.push(`(ecosystem=${ecosystem}: registry rows not yet wired — JS/TS detection only)`);
	out.push("(what WOULD sharpen each lens here: L=import-linter/staticcheck/clippy, A=vulture/deadcode/cargo-udeps, T=coverage.py/go test -cover/cargo llvm-cov)");
}

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

// rg (ripgrep) -> search. No project config by convention (config is the RIPGREP_CONFIG_PATH
// env var, not a tracked file) -> installed | absent only. Orchestrator prefers rg over literal grep/find.
const rgBin = binAvailable(["rg"]);
row("rg", "search", rgBin ? "installed" : "absent",
	rgBin ? [`bin=${rgBin}`] : ["hint=install ripgrep (rg)"]);

// --- Report status summary (drives the checkpoint) -------------------------
const covRpt = covReport ? "present" : "absent";
const mutRpt = strykerReport ? "present" : "absent";
const archAstRpt = astgrepArch === "configured" ? "present" : "absent";
const archOgRpt = opengrepArch === "configured" ? "present" : "absent";
const dbRpt = hasDbSurface ? "present" : "absent";

process.stdout.write(`root:      ${root}\necosystem: ${ecosystem}\n---tool-coverage---\n${out.join("\n")}\n---report-status---\ncoverage: ${covRpt}\nmutation: ${mutRpt}\narch-lint-ast: ${archAstRpt}\narch-lint-og: ${archOgRpt}\ndb-tools: ${dbRpt}\n`);
process.exit(0);
