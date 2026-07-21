// tool-probe.test.mjs — golden-fixture test for tool-probe.mjs. Builds a throwaway repo
// with a known tool setup and asserts the configured/absent classification — proving
// detection works WITHOUT running or installing anything. Prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
