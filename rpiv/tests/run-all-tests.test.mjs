// `npm test` must run every test file. The vitest suites live in tests/ and in
// skills/_shared/*.test.ts; the older suites are plain `node <file>.test.mjs`
// scripts beside their sources, and nothing ran them together.
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const RUNNER = join(PLUGIN, "scripts", "run-all-tests.mjs");
const PASS = 'console.log("fine");\n';
const FAIL = 'console.error("assertion: 1 !== 2");\nprocess.exit(1);\n';

const temps = [];
afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A temp folder holding `files` (`{ "sub/b.test.mjs": source }`). */
const folderWith = (files) => {
	const root = mkdtempSync(join(tmpdir(), "run-all-"));
	temps.push(root);
	for (const [rel, source] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), source);
	}
	return root;
};

const runScripts = (root) => {
	const { stdout, status } = spawnSync(
		process.execPath,
		[RUNNER, "--scripts-only", "--root", root],
		{ encoding: "utf8" },
	);
	return { lines: stdout.split(/\r?\n/).filter(Boolean), status };
};

describe("run-all-tests --scripts-only", () => {
	it("fails when one script fails and names it", () => {
		const mixed = runScripts(
			folderWith({ "a.test.mjs": PASS, "sub/b.test.mjs": FAIL }),
		);
		expect(mixed.status).toBe(1);
		expect(mixed.lines).toContain("ok a.test.mjs");
		expect(mixed.lines).toContain("FAILED sub/b.test.mjs (exit 1)");
		// The failing script's own output is shown, so the failure can be read.
		expect(mixed.lines).toContain("    assertion: 1 !== 2");
		expect(mixed.lines.at(-1)).toBe("run-all-tests: 1 failed of 2");

		const clean = runScripts(
			folderWith({ "a.test.mjs": PASS, "sub/b.test.mjs": PASS }),
		);
		expect(clean.status).toBe(0);
		expect(clean.lines).toEqual([
			"ok a.test.mjs",
			"ok sub/b.test.mjs",
			"run-all-tests: 0 failed of 2",
		]);
	});

	it("skips generated copies, tests/ and node_modules", () => {
		const { lines, status } = runScripts(
			folderWith({
				"skills/real.test.mjs": PASS,
				".claude/hooks/hook.test.mjs": PASS,
				"opencode/generated/skills/copy.test.mjs": FAIL,
				"tests/vitest-suite.test.mjs": FAIL,
				"node_modules/dep/x.test.mjs": FAIL,
				"skills/not-a-test.mjs": FAIL,
			}),
		);
		expect(lines).toEqual([
			"ok .claude/hooks/hook.test.mjs",
			"ok skills/real.test.mjs",
			"run-all-tests: 0 failed of 2",
		]);
		expect(status).toBe(0);
	});

	it("reports an empty discovery as broken", () => {
		const { lines, status } = runScripts(
			folderWith({ "tests/only-vitest.test.mjs": PASS }),
		);
		expect(status).toBe(2);
		expect(lines).toEqual(["run-all-tests: broken: no test scripts found"]);
	});

	it("reports a missing root as broken", () => {
		const root = join(folderWith({}), "gone");
		const { lines, status } = runScripts(root);
		expect(status).toBe(2);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^run-all-tests: broken: /);
	});
});

describe("run-all-tests skip notices", () => {
	it("names a script that passed but reported a skip", () => {
		const { lines, status } = runScripts(
			folderWith({
				"a.test.mjs":
					'console.log("SKIP (semantic) — ts-morph not resolvable");\n',
				"b.test.mjs":
					'console.log("OK — part one.");\nconsole.log("  (symlink case skipped: EPERM)");\n',
				"c.test.mjs":
					'console.log("OK — scope + degrade paths. DETECTION CASES SKIPPED: no cpd.");\n',
				// Passing lines that merely talk about skipping are not notices.
				"d.test.mjs":
					'console.log("OK — skip dirs: node_modules excluded.");\nconsole.log("OK (x) — knip present -> dead-exports skipped (delegated).");\n',
			}),
		);
		expect(status).toBe(0);
		expect(lines).toEqual([
			"skip a.test.mjs",
			"    SKIP (semantic) — ts-morph not resolvable",
			"skip b.test.mjs",
			"    (symlink case skipped: EPERM)",
			"skip c.test.mjs",
			"    OK — scope + degrade paths. DETECTION CASES SKIPPED: no cpd.",
			"ok d.test.mjs",
			"run-all-tests: 0 failed of 4 (3 reported a skip)",
		]);
	});
});

describe("run-all-tests with vitest", () => {
	const VITEST = "node_modules/vitest/vitest.mjs";
	const runAll = (root) => {
		const { stdout, status } = spawnSync(
			process.execPath,
			[RUNNER, "--root", root],
			{ encoding: "utf8" },
		);
		return { lines: stdout.split(/\r?\n/).filter(Boolean), status };
	};

	it("counts vitest as one unit of the summary", () => {
		const failing = runAll(
			folderWith({
				[VITEST]: 'console.log("1 test failed");\nprocess.exit(1);\n',
				"a.test.mjs": PASS,
			}),
		);
		expect(failing.status).toBe(1);
		expect(failing.lines).toEqual([
			"1 test failed",
			"FAILED vitest (exit 1)",
			"ok a.test.mjs",
			"run-all-tests: 1 failed of 2",
		]);

		const passing = runAll(
			folderWith({ [VITEST]: 'console.log("all good");\n', "a.test.mjs": PASS }),
		);
		expect(passing.status).toBe(0);
		expect(passing.lines).toEqual([
			"all good",
			"ok vitest",
			"ok a.test.mjs",
			"run-all-tests: 0 failed of 2",
		]);
	});

	it("reports a missing vitest as broken", () => {
		const { lines, status } = runAll(folderWith({ "a.test.mjs": PASS }));
		expect(status).toBe(2);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^run-all-tests: broken: vitest not found at /);
	});
});

describe("the plugin's own test command", () => {
	it("npm test is the runner", () => {
		const { scripts } = JSON.parse(
			readFileSync(join(PLUGIN, "package.json"), "utf8"),
		);
		expect(scripts.test).toBe("node scripts/run-all-tests.mjs");
	});

	it("vitest collects the skills/_shared .test.ts suites and no generated copy", () => {
		const { stdout, status } = spawnSync(
			process.execPath,
			[join(PLUGIN, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly"],
			{ cwd: PLUGIN, encoding: "utf8", timeout: 120_000 },
		);
		expect(status).toBe(0);
		const files = stdout
			.split(/\r?\n/)
			.map((line) => line.trim().replaceAll("\\", "/"))
			.filter(Boolean);
		expect(files).toEqual(
			expect.arrayContaining([
				"skills/_shared/git-changes.test.ts",
				"skills/_shared/git-context.test.ts",
				"skills/_shared/list-recent.test.ts",
				"skills/_shared/now.test.ts",
			]),
		);
		expect(files.filter((file) => file.startsWith("opencode/generated/"))).toEqual(
			[],
		);
		// The co-located node scripts have no suites; vitest must leave them to the runner.
		expect(files.filter((file) => file.startsWith(".claude/hooks/"))).toEqual([]);
	});
});
