// tool-probe.test.mjs — golden-fixture test for tool-probe.mjs. Builds a throwaway repo
// with a known tool setup and asserts the configured/absent classification — proving
// detection works WITHOUT running or installing anything. Prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "tool-probe.mjs");
// ts-morph resolves relative to the probe (same dir as this test) — its expected status
// depends on whether the environment has it installed, so compute the expectation here.
const tsMorphResolvable = (() => {
	try {
		createRequire(import.meta.url).resolve("ts-morph");
		return true;
	} catch {
		return false;
	}
})();
const git = (repo, args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });

const repo = mkdtempSync(join(tmpdir(), "probe-"));
try {
	// depcruise: installed (dep) + config file -> configured. knip: script only -> configured.
	// coverage: no vitest/jest/c8/nyc -> absent. madge: absent.
	writeFileSync(join(repo, "package.json"), JSON.stringify({
		name: "x",
		devDependencies: { "dependency-cruiser": "^16" },
		scripts: { knip: "knip" },
	}));
	writeFileSync(join(repo, ".dependency-cruiser.cjs"), "module.exports = { forbidden: [] };\n");
	// tsconfig present -> ts-morph is `configured` when resolvable (else `absent`).
	writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);

	const out = execFileSync("node", [PROBE, "."], { cwd: repo, encoding: "utf-8" });
	const rowFor = (tool) => out.split("\n").find((l) => l.startsWith(`${tool}\t`)) ?? "";
	assert.ok(out.includes("ecosystem: js-ts"), `ecosystem must be js-ts\n${out}`);
	assert.ok(/status=configured/.test(rowFor("dependency-cruiser")), `depcruise must be configured, got: ${rowFor("dependency-cruiser")}\n${out}`);
	assert.ok(/lens=L/.test(rowFor("dependency-cruiser")), `depcruise must map to lens L`);
	assert.ok(/status=configured/.test(rowFor("knip")), `knip (script present) must be configured, got: ${rowFor("knip")}`);
	assert.ok(/status=absent/.test(rowFor("coverage")), `coverage (no tool) must be absent, got: ${rowFor("coverage")}`);
	assert.ok(/status=absent/.test(rowFor("madge")), `madge must be absent, got: ${rowFor("madge")}`);
	// ts-morph maps to S/Fe/A; with a tsconfig present it is `configured` when resolvable, else `absent`.
	assert.ok(/lens=S\/Fe\/A/.test(rowFor("ts-morph")), `ts-morph must map to lens S/Fe/A, got: ${rowFor("ts-morph")}`);
	const expectedTsm = tsMorphResolvable ? "configured" : "absent";
	assert.ok(
		new RegExp(`status=${expectedTsm}`).test(rowFor("ts-morph")),
		`ts-morph status must be ${expectedTsm} (resolvable=${tsMorphResolvable}, tsconfig present), got: ${rowFor("ts-morph")}`,
	);
	// jscpd maps to D; status is env-dependent (a PATH binary), so just assert a valid value.
	assert.ok(/lens=D/.test(rowFor("jscpd")), `jscpd must map to lens D, got: ${rowFor("jscpd")}`);
	assert.ok(/status=(installed|configured|absent)/.test(rowFor("jscpd")), `jscpd must have a valid status, got: ${rowFor("jscpd")}`);
	// ast-grep -> D/M; PATH binary, status env-dependent (no sgconfig in fixture).
	assert.ok(/lens=D\/M/.test(rowFor("ast-grep")), `ast-grep must map to lens D/M, got: ${rowFor("ast-grep")}`);
	assert.ok(/status=(installed|configured|absent)/.test(rowFor("ast-grep")), `ast-grep must have a valid status, got: ${rowFor("ast-grep")}`);
	// opengrep -> L/M; PATH binary, status env-dependent.
	assert.ok(/lens=L\/M/.test(rowFor("opengrep")), `opengrep must map to lens L/M, got: ${rowFor("opengrep")}`);
	assert.ok(/status=(installed|configured|absent)/.test(rowFor("opengrep")), `opengrep must have a valid status, got: ${rowFor("opengrep")}`);
	// rg -> search; no project config -> only installed|absent (the no-configured collapse).
	assert.ok(/lens=search/.test(rowFor("rg")), `rg must map to lens search, got: ${rowFor("rg")}`);
	assert.ok(/status=(installed|absent)/.test(rowFor("rg")), `rg must have a valid status, got: ${rowFor("rg")}`);
	console.log(`OK (tool-probe) — configured/absent detected without running or installing (ts-morph: ${expectedTsm}).`);
} finally {
	rmSync(repo, { recursive: true, force: true });
}

// --- Regression: project nested under the git root (subdir invocation) ------
// The manifest lookup joined onto the git TOPLEVEL, so a project living in a
// subdirectory of the repo (nested repo, monorepo package) read no package.json
// and reported ecosystem "unknown" / every tool absent. Manifest under pkg/, a
// bare root package.json that must NOT shadow it, invoke from pkg/.
const repo2 = mkdtempSync(join(tmpdir(), "probe-subdir-"));
try {
	mkdirSync(join(repo2, "pkg"), { recursive: true });
	// Bare root manifest with none of the tools — proves walk-up picks the NEAREST
	// package.json (pkg/), not the git-toplevel one.
	writeFileSync(join(repo2, "package.json"), JSON.stringify({ name: "root" }));
	writeFileSync(join(repo2, "pkg", "package.json"), JSON.stringify({
		name: "nested",
		devDependencies: { "dependency-cruiser": "^16" },
	}));
	writeFileSync(join(repo2, "pkg", ".dependency-cruiser.cjs"), "module.exports = { forbidden: [] };\n");
	git(repo2, ["init", "-q"]);
	git(repo2, ["add", "-A"]);
	const out2 = execFileSync("node", [PROBE, "."], { cwd: join(repo2, "pkg"), encoding: "utf-8" });
	assert.ok(out2.includes("ecosystem: js-ts"), `nested project (cwd != git toplevel) must still detect ecosystem\n${out2}`);
	const dc2 = out2.split("\n").find((l) => l.startsWith("dependency-cruiser\t")) ?? "";
	assert.ok(/status=configured/.test(dc2), `nested project's depcruise config must be found from a subdir, not the bare root manifest, got: ${dc2}\n${out2}`);
	console.log("OK (tool-probe subdir) — project nested under the git root is detected (nearest manifest, not the toplevel).");
} finally {
	rmSync(repo2, { recursive: true, force: true });
}

// --- Broken != absent (M2): a corrupt manifest is announced, an absent one stays clean ---
const repo3 = mkdtempSync(join(tmpdir(), "probe-corrupt-"));
try {
	writeFileSync(join(repo3, "package.json"), "{invalid");
	git(repo3, ["init", "-q"]);
	git(repo3, ["add", "-A"]);
	const out3 = execFileSync("node", [PROBE, "."], { cwd: repo3, encoding: "utf-8" });
	assert.ok(
		out3.includes("manifest:  error — package.json failed to parse"),
		`corrupt package.json must emit the manifest error line, got:\n${out3}`,
	);
	assert.ok(out3.includes("ecosystem: unknown"), `corrupt manifest cannot claim an ecosystem, got:\n${out3}`);
	console.log("OK (tool-probe corrupt-manifest) — parse failure surfaces `manifest: error`, never silent unknown.");
} finally {
	rmSync(repo3, { recursive: true, force: true });
}

const repo4 = mkdtempSync(join(tmpdir(), "probe-nomanifest-"));
try {
	writeFileSync(join(repo4, "README.md"), "no manifest here\n");
	git(repo4, ["init", "-q"]);
	git(repo4, ["add", "-A"]);
	const out4 = execFileSync("node", [PROBE, "."], { cwd: repo4, encoding: "utf-8" });
	assert.ok(!/^manifest:/m.test(out4), `absent manifest is the clean path — no manifest line, got:\n${out4}`);
	console.log("OK (tool-probe absent-manifest) — no package.json emits no manifest line (clean absent path unchanged).");
} finally {
	rmSync(repo4, { recursive: true, force: true });
}

// --- Multi-target probe (dogfooding A): union of N paths, anchor announced ---
const repo5 = mkdtempSync(join(tmpdir(), "probe-multi-"));
try {
	mkdirSync(join(repo5, "d1"), { recursive: true });
	mkdirSync(join(repo5, "d2"), { recursive: true });
	writeFileSync(join(repo5, "package.json"), JSON.stringify({ name: "one-root" }));
	git(repo5, ["init", "-q"]);
	git(repo5, ["add", "-A"]);
	const multi = execFileSync("node", [PROBE, "d1", "d2"], { cwd: repo5, encoding: "utf-8" });
	const single = execFileSync("node", [PROBE, "d1"], { cwd: repo5, encoding: "utf-8" });
	assert.equal(multi, single, `two targets under ONE package.json must probe identically (no roots_note)`);
	assert.ok(!multi.includes("roots_note"), `same project root -> no roots_note line, got:\n${multi}`);
	console.log("OK (tool-probe multi same-root) — union of targets under one root probes identically.");
} finally {
	rmSync(repo5, { recursive: true, force: true });
}

const repo6 = mkdtempSync(join(tmpdir(), "probe-span-"));
try {
	mkdirSync(join(repo6, "pkgA"), { recursive: true });
	mkdirSync(join(repo6, "pkgB"), { recursive: true });
	writeFileSync(join(repo6, "pkgA", "package.json"), JSON.stringify({ name: "a" }));
	writeFileSync(join(repo6, "pkgB", "package.json"), JSON.stringify({ name: "b" }));
	git(repo6, ["init", "-q"]);
	git(repo6, ["add", "-A"]);
	const out6 = execFileSync("node", [PROBE, "pkgA", "pkgB"], { cwd: repo6, encoding: "utf-8" });
	assert.ok(
		out6.includes("roots_note: targets span 2 project roots — probing the first"),
		`multi-project targets must announce the probe anchor, got:\n${out6}`,
	);
	console.log("OK (tool-probe span note) — multi-project anchor announced, never silent.");
} finally {
	rmSync(repo6, { recursive: true, force: true });
}

// --- HTML-only mutation report is distinct from absent (dogfooding B, M2) ----
const repo7 = mkdtempSync(join(tmpdir(), "probe-htmlonly-"));
try {
	const seed = () => {
		// vitest WITHOUT a @vitest/coverage-* provider — exercises the provider pre-detect.
		writeFileSync(join(repo7, "package.json"), JSON.stringify({
			name: "x",
			devDependencies: { "@stryker-mutator/core": "^9", vitest: "^4" },
		}));
		writeFileSync(join(repo7, "stryker.config.json"), JSON.stringify({ mutate: ["src/x.ts"] }));
	};
	seed();
	mkdirSync(join(repo7, "reports", "mutation"), { recursive: true });
	writeFileSync(join(repo7, "reports", "mutation", "store.html"), "<html></html>");
	git(repo7, ["init", "-q"]);
	git(repo7, ["add", "-A"]);

	const htmlOnly = execFileSync("node", [PROBE, "."], { cwd: repo7, encoding: "utf-8" });
	const strykerRow = htmlOnly.split("\n").find((l) => l.startsWith("stryker\t")) ?? "";
	assert.ok(
		strykerRow.includes("report=html-only:reports/mutation/store.html"),
		`html-only report must be named distinctly, got: ${strykerRow}\n${htmlOnly}`,
	);
	assert.ok(
		strykerRow.includes('hint=add "json" to stryker reporters for machine ingest'),
		`html-only row must carry the add-json hint, got: ${strykerRow}`,
	);
	assert.ok(/^mutation: html-only$/m.test(htmlOnly), `footer must be exactly 'mutation: html-only', got:\n${htmlOnly}`);

	// with a FRESH json report present, the html file is irrelevant -> present (unchanged, pinned)
	writeFileSync(join(repo7, "reports", "mutation", "mutation.json"), JSON.stringify({ files: {} }));
	const withJson = execFileSync("node", [PROBE, "."], { cwd: repo7, encoding: "utf-8" });
	const jsonRow = withJson.split("\n").find((l) => l.startsWith("stryker\t")) ?? "";
	assert.ok(jsonRow.includes("report=reports/mutation/mutation.json"), `json report preferred, got: ${jsonRow}`);
	assert.ok(/^mutation: present$/m.test(withJson), `footer stays 'mutation: present' with json, got:\n${withJson}`);

	// a json markedly OLDER than the sibling html is from an earlier run -> stale-json
	// (dogfooding #2: an html-only reporter config leaves the last json in place).
	const old = (Date.now() - 6 * 86_400_000) / 1000;
	utimesSync(join(repo7, "reports", "mutation", "mutation.json"), old, old);
	const stale = execFileSync("node", [PROBE, "."], { cwd: repo7, encoding: "utf-8" });
	const staleRow = stale.split("\n").find((l) => l.startsWith("stryker\t")) ?? "";
	assert.ok(staleRow.includes("report=stale-json:reports/mutation/mutation.json"), `stale json named distinctly, got: ${staleRow}`);
	assert.ok(staleRow.includes("hint=mutation.json predates the html report"), `stale row carries the re-run hint, got: ${staleRow}`);
	assert.ok(/^mutation: stale-json$/m.test(stale), `footer must be 'mutation: stale-json', got:\n${stale}`);

	// vitest without a coverage provider package: `npx vitest run --coverage` would die
	// asking for one — the probe pre-detects it (dogfooding #8) so the Generate (~30s)
	// checkpoint can warn instead of promising a run that fails.
	const covRow = stale.split("\n").find((l) => l.startsWith("coverage\t")) ?? "";
	assert.ok(covRow.includes("provider=absent"), `vitest without @vitest/coverage-* must flag provider=absent, got: ${covRow}`);
	assert.ok(covRow.includes("hint=npm i -D @vitest/coverage-v8 first"), `provider=absent row carries the install-first hint, got: ${covRow}`);

	// with neither -> absent (unchanged)
	rmSync(join(repo7, "reports"), { recursive: true, force: true });
	const neither = execFileSync("node", [PROBE, "."], { cwd: repo7, encoding: "utf-8" });
	const noneRow = neither.split("\n").find((l) => l.startsWith("stryker\t")) ?? "";
	assert.ok(noneRow.includes("report=none"), `no report at all -> report=none, got: ${noneRow}`);
	assert.ok(/^mutation: absent$/m.test(neither), `footer stays 'mutation: absent' with no report, got:\n${neither}`);
	console.log("OK (tool-probe html-only) — html-only distinct from absent; json preferred; absent unchanged.");
} finally {
	rmSync(repo7, { recursive: true, force: true });
}
