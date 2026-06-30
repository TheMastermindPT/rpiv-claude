// tool-probe.mjs — read-only capability probe for the architectural-review skill.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/tool-probe.mjs" "<target>"
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
// Detect a CLI binary on PATH (for tools shipped as a self-contained binary, e.g. jscpd v5
// — a Rust binary, NOT a node module). A `--version` probe is instant + read-only.
const binAvailable = (names) => {
	for (const n of names) {
		try {
			execFileSync(n, ["--version"], { stdio: "ignore", timeout: 8000, shell: process.platform === "win32" });
			return n;
		} catch {
			/* not on PATH */
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

	// coverage -> T (test theater). Report presence drives the Step-3 checkpoint.
	const covTool = installed("vitest") ? "vitest"
		: installed("jest") ? "jest"
		: installed("c8") ? "c8"
		: installed("nyc") ? "nyc"
		: "";
	const covScript = scriptMatching(/coverage/);
	const covReport = firstFile([
		"coverage/coverage-final.json", "coverage/coverage-summary.json", "coverage/lcov.info",
	]);
	const covStatus = !covTool ? "absent" : covScript ? "configured" : "installed-unconfigured";
	row("coverage", "T", covStatus, [
		`tool=${covTool || "none"}`,
		`report=${covReport || "none"}`,
		...(covStatus === "absent" ? ["hint=npm i -D vitest (or jest) + add a coverage script"]
			: covStatus === "installed-unconfigured" ? ["hint=add a `test:coverage` script"]
			: covScript ? [`script:${covScript}`] : []),
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

process.stdout.write(`root:      ${root}\necosystem: ${ecosystem}\n---tool-coverage---\n${out.join("\n")}\n`);
process.exit(0);
