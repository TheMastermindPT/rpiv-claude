// tests/validate-artifact-cli.test.mjs — the validate-artifact command line refuses a flag it
// does not know (odin#13). A flag such as `--dry-run` used to be dropped without a word, so a
// call that also passed `--stamp` stamped the file while the caller expected a check only.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const VALIDATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills/_shared/validate-artifact.mjs",
);

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const CLEAN =
	"---\ndate: x\nauthor: x\ncommit: x\nbranch: x\nrepository: x\ntopic: x\nstatus: ready\nlast_updated: x\nlast_updated_by: x\n---\n# T\n\nClean prose.\n";

/** A clean, unstamped artifact in a throwaway root. */
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "rpiv-validate-cli-"));
	dirs.push(root);
	const file = join(root, "a.md");
	writeFileSync(file, CLEAN);
	return { root, file };
};

const run = (...args) =>
	spawnSync(process.execPath, [VALIDATE, ...args], { encoding: "utf-8" });

describe("validate-artifact refuses an unknown flag", () => {
	it.each([
		["alone", ["--dry-run"]],
		["next to --stamp", ["--dry-run", "--stamp"]],
		["after --stamp", ["--stamp", "--dry-run"]],
		[
			"next to --finalizing and --stamp",
			["--finalizing", "--stamp", "--dry-run"],
		],
	])(
		"%s: exits 2, names the flag with the usage line, and leaves the file untouched",
		(_label, flags) => {
			const { root, file } = fixture();
			const before = readFileSync(file);
			const r = run(file, "--root", root, ...flags);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("unknown flag --dry-run");
			expect(r.stderr).toContain("usage: validate-artifact.mjs");
			expect(r.stdout).toBe("");
			expect(readFileSync(file).equals(before)).toBe(true);
		},
	);

	it("names every unknown flag, including a known name written with =", () => {
		const { root, file } = fixture();
		const before = readFileSync(file);
		const r = run(file, "--root", root, "--stamp=yes", "--verbose", "--stamp");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--stamp=yes");
		expect(r.stderr).toContain("--verbose");
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("refuses --root without a value instead of crashing", () => {
		const { file } = fixture();
		const r = run(file, "--root");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: validate-artifact.mjs");
	});
});

describe("validate-artifact known flags still work", () => {
	it("validates without writing when --stamp is absent", () => {
		const { root, file } = fixture();
		const before = readFileSync(file);
		const r = run(file, "--root", root, "--finalizing");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("validate-artifact: OK");
		expect(readFileSync(file).equals(before)).toBe(true);
	});

	it("stamps with --root, --finalizing and --stamp", () => {
		const { root, file } = fixture();
		const r = run(file, "--root", root, "--finalizing", "--stamp");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("OK (stamped)");
		expect(readFileSync(file, "utf-8")).toMatch(/^content_hash: [0-9a-f]+$/m);
	});

	it("still reports a usage error when no artifact path is given", () => {
		const r = run("--stamp");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: validate-artifact.mjs");
	});

	it("still refuses --slice without a value", () => {
		const { root, file } = fixture();
		const r = run(file, "--root", root, "--finalizing", "--slice");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: validate-artifact.mjs");
	});
});
