// tool-probe.test.mjs — golden-fixture test for tool-probe.mjs. Builds a throwaway repo
// with a known tool setup and asserts the configured/absent classification — proving
// detection works WITHOUT running or installing anything. Prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
	console.log(`OK (tool-probe) — configured/absent detected without running or installing (ts-morph: ${expectedTsm}).`);
} finally {
	rmSync(repo, { recursive: true, force: true });
}
