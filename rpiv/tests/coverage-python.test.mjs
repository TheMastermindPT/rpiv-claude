// tests/coverage-python.test.mjs — slice S5-coverage of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: coverage.mjs reads
// coverage.py's lcov export at each Python root, a missing lcov total reads n/a, and
// targets that span project roots read every root's report.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE = join(ROOT, "skills/architectural-review/_helpers/coverage.mjs");
const PROBE = join(ROOT, "skills/_shared/tool-probe.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const repoWith = (files) => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-coverage-py-"));
	dirs.push(repo);
	for (const [path, text] of Object.entries(files)) put(repo, path, text);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	return repo;
};
const run = (script, repo, ...targets) =>
	execFileSync(process.execPath, [script, ...targets], {
		cwd: repo,
		encoding: "utf-8",
	});
const rowsOf = (out) => out.split("---coverage---\n")[1]?.trim().split("\n") ?? [];

// coverage.py 7.17.4's `coverage lcov` shape (research, "Coverage (FR13)"): relative SF
// paths with Windows backslashes, DA/LF/LH and FN/FNDA/FNF/FNH lines, no BRF/BRH.
const COVERAGE_PY_LCOV = [
	"SF:src\\demo\\__init__.py",
	"DA:1,1",
	"DA:2,1",
	"DA:3,0",
	"DA:4,0",
	"LF:4",
	"LH:2",
	"FN:1,2,add",
	"FNDA:1,add",
	"FNF:1",
	"FNH:1",
	"end_of_record",
	"",
].join("\n");

const PY_ROOT = {
	"py/pyproject.toml": '[project]\nname = "demo"\n',
	"py/src/demo/__init__.py": "def add(a, b):\n    return a + b\n",
	"py/coverage.lcov": COVERAGE_PY_LCOV,
};

describe("coverage.mjs on Python roots and lcov totals (S5-coverage)", () => {
	it(
		"B38: a Python root coverage.lcov gives per-file rows, and the probe reads it as present",
		() => {
			const repo = repoWith(PY_ROOT);
			const out = run(COVERAGE, repo, "py");
			expect.soft(out).toContain("coverage_report:  coverage.lcov\n");
			expect
				.soft(rowsOf(out))
				.toEqual(["py/src/demo/__init__.py\tstmt=50%\tbranch=n/a\tfn=100%"]);

			expect.soft(run(PROBE, repo, "py")).toContain("\ncoverage: present\n");
			const bare = repoWith({ "py/pyproject.toml": "[project]\n" });
			expect.soft(run(PROBE, bare, "py")).toContain("\ncoverage: absent\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"B39: a missing or zero lcov total reads n/a, sorted after numbers, and a broken count is a parse error",
		() => {
			const repo = repoWith({
				"package.json": JSON.stringify({ name: "x" }),
				"coverage/lcov.info": [
					"SF:a.ts",
					"LF:2",
					"LH:2",
					"BRF:0",
					"end_of_record",
					"SF:b.ts",
					"LF:4",
					"LH:1",
					"BRF:2",
					"BRH:1",
					"FNF:2",
					"FNH:0",
					"end_of_record",
					"",
				].join("\n"),
			});
			const out = run(COVERAGE, repo, ".");
			expect.soft(out).toContain("coverage_report:  lcov.info\n");
			expect
				.soft(rowsOf(out))
				.toEqual([
					"b.ts\tstmt=25%\tbranch=50%\tfn=0%",
					"a.ts\tstmt=100%\tbranch=n/a\tfn=n/a",
				]);

			const broken = repoWith({
				"package.json": JSON.stringify({ name: "x" }),
				"coverage/lcov.info": "SF:c.ts\nLF:2\nLH:x\nend_of_record\n",
			});
			const bad = run(COVERAGE, broken, ".");
			expect.soft(bad).toMatch(/^coverage_report: {2}lcov\.info \(parse-error: .+\)$/m);
			expect.soft(rowsOf(bad)).toEqual(["c.ts\tstmt=n/a\tbranch=n/a\tfn=n/a"]);
		},
		TEST_TIMEOUT,
	);

	it(
		"B40: targets that span roots read every root report, with no first-root note",
		() => {
			const repo = repoWith({
				...PY_ROOT,
				"ui/package.json": JSON.stringify({ name: "ui" }),
				"ui/coverage/coverage-summary.json": JSON.stringify({
					total: {
						statements: { pct: 80 },
						branches: { pct: 70 },
						functions: { pct: 90 },
					},
					"ui/src/a.ts": {
						statements: { pct: 80 },
						branches: { pct: 70 },
						functions: { pct: 90 },
					},
				}),
			});
			const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: repo,
				encoding: "utf-8",
			})
				.trim()
				.replaceAll("\\", "/");
			const out = run(COVERAGE, repo, "py", "ui");
			expect.soft(out).not.toMatch(/^note:/m);
			expect.soft(out).toContain("coverage_report:  coverage.lcov\n");
			expect
				.soft(out)
				.toContain(`also_coverage_report: ${top}/ui\tcoverage-summary.json\n`);
			expect
				.soft(rowsOf(out))
				.toEqual(
					expect.arrayContaining([
						"py/src/demo/__init__.py\tstmt=50%\tbranch=n/a\tfn=100%",
						"ui/src/a.ts\tstmt=80%\tbranch=70%\tfn=90%",
					]),
				);
		},
		TEST_TIMEOUT,
	);
});
