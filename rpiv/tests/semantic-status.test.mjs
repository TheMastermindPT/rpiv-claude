// tests/semantic-status.test.mjs — skills/architectural-review/_helpers/semantic.mjs must keep
// "ts-morph is absent" (unavailable) apart from "ts-morph or the project failed" (broken), and
// must make a partial scan visible (syntax errors, tsconfig errors) instead of reading clean.
// warrant.mjs must carry that outcome in its `semantic` field.
// Each case builds a throwaway git repo with a tsconfig under the OS temp folder.

import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = join(ROOT, "skills/architectural-review/_helpers");
const SEMANTIC = join(HELPERS, "semantic.mjs");
const WARRANT = join(HELPERS, "warrant.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};

const put = (dir, path, content) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
};

/** A git repo with `src/` files and the given tsconfig text. */
const tsRepo = (
	files,
	tsconfig = JSON.stringify({
		compilerOptions: { strict: true },
		include: ["src"],
	}),
) => {
	const repo = tempDir("rpiv-semantic-");
	put(repo, "tsconfig.json", tsconfig);
	for (const [path, content] of Object.entries(files)) put(repo, path, content);
	execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
	return repo;
};

const run = (helper, repo, args = ["src"]) =>
	spawnSync(process.execPath, [helper, ...args], {
		cwd: repo,
		encoding: "utf-8",
	}).stdout;

/** A copy of semantic.mjs and its local imports, laid out as in the plugin, outside the plugin's node_modules. */
const isolatedHelper = () => {
	const dir = tempDir("rpiv-semantic-helper-");
	const helpers = join(dir, "skills/architectural-review/_helpers");
	mkdirSync(helpers, { recursive: true });
	mkdirSync(join(dir, "skills/_shared"), { recursive: true });
	for (const f of ["semantic.mjs", "source-set.mjs", "target-context.mjs"])
		copyFileSync(join(HELPERS, f), join(helpers, f));
	copyFileSync(
		join(ROOT, "skills/_shared/source-vocab.mjs"),
		join(dir, "skills/_shared/source-vocab.mjs"),
	);
	return { dir, helper: join(helpers, "semantic.mjs") };
};

/** An isolated helper whose node_modules holds a stub ts-morph package. */
const helperWithStubTsMorph = (stubSource, main = "index.js") => {
	const { dir, helper } = isolatedHelper();
	put(
		dir,
		"node_modules/ts-morph/package.json",
		JSON.stringify({ name: "ts-morph", main }),
	);
	if (stubSource !== null)
		put(dir, "node_modules/ts-morph/index.js", stubSource);
	return helper;
};

const tsMorphResolvableFromTemp = (() => {
	try {
		createRequire(join(tmpdir(), "probe.mjs")).resolve("ts-morph");
		return true;
	} catch {
		return false;
	}
})();

describe("semantic.mjs — broken is never absent", () => {
	it(
		"reports a tsconfig that cannot be parsed as broken",
		() => {
			const repo = tsRepo(
				{ "src/a.ts": "export const a = 1;\n" },
				"{ not json",
			);
			expect(run(SEMANTIC, repo)).toMatch(
				/^---semantic-status---\nbroken: ts-morph failed to load the project .*tsconfig\.json/m,
			);
		},
		TEST_TIMEOUT,
	);

	// Each row is a stub ts-morph package next to an isolated copy of the helper.
	// Only "the module itself cannot be found" is absence; everything else is broken.
	const STUB_LOADS = [
		{
			name: "an installed ts-morph that throws on load",
			source: "throw new Error('boom from stub');\n",
			expected:
				/^broken: ts-morph is installed but failed to load \(boom from stub\)$/m,
		},
		{
			name: "an installed ts-morph whose entry file is missing",
			source: null,
			main: "missing.js",
			expected: /^broken: ts-morph is installed but failed to load/m,
		},
		{
			name: "an installed ts-morph without a Project export",
			source: "module.exports = {};\n",
			expected: /^broken: ts-morph loaded but exports no Project class/m,
		},
		{
			name: "a ts-morph that cannot be found (on any machine)",
			source:
				"throw Object.assign(new Error(\"Cannot find module 'ts-morph'\"), { code: 'MODULE_NOT_FOUND' });\n",
			expected:
				/^unavailable: ts-morph not resolvable from the helper location/m,
		},
		{
			name: "a ts-morph that throws a plain error naming 'ts-morph' (no MODULE_NOT_FOUND code)",
			source: "throw new Error(\"internal assertion in 'ts-morph' loader\");\n",
			expected:
				/^broken: ts-morph is installed but failed to load \(internal assertion in 'ts-morph' loader\)$/m,
		},
		{
			name: "a ts-morph whose project crashes mid-analysis",
			source:
				"class Project { getSourceFiles() { throw new TypeError('boom crash'); } }\nmodule.exports = { Project, SyntaxKind: {} };\n",
			expected:
				/^---semantic-status---\nbroken: semantic analysis crashed \(boom crash\)$/m,
		},
	];

	it.for(STUB_LOADS)(
		"classifies $name",
		({ source, main, expected }) => {
			const helper = helperWithStubTsMorph(source, main);
			const repo = tsRepo({ "src/a.ts": "export const a = 1;\n" });
			expect(run(helper, repo)).toMatch(expected);
		},
		TEST_TIMEOUT,
	);

	it.skipIf(tsMorphResolvableFromTemp)(
		"keeps a ts-morph that is not installed as unavailable",
		() => {
			const { helper } = isolatedHelper();
			const repo = tsRepo({ "src/a.ts": "export const a = 1;\n" });
			expect(run(helper, repo)).toMatch(
				/^unavailable: ts-morph not resolvable/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps a missing tsconfig as unavailable",
		() => {
			const repo = tsRepo({ "src/a.ts": "export const a = 1;\n" });
			rmSync(join(repo, "tsconfig.json"));
			expect(run(SEMANTIC, repo)).toMatch(
				/^unavailable: no tsconfig\.json found/m,
			);
		},
		TEST_TIMEOUT,
	);
});

describe("semantic.mjs — a partial scan is visible", () => {
	it(
		"counts target files with syntax errors in the parse_errors header",
		() => {
			const repo = tsRepo({
				"src/broken.ts": "export function f() { if (1 > 0 { return 1 }\n",
				"src/ok.ts": "export const ok = 1;\n",
			});
			const out = run(SEMANTIC, repo);
			expect(out).toMatch(
				/^parse_errors: +files=1 \(signals from these files are partial; first: src\/broken\.ts diags=\d+\)$/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"reports parse_errors files=0 and tsconfig_errors 0 on a clean project",
		() => {
			const out = run(
				SEMANTIC,
				tsRepo({ "src/ok.ts": "export const ok = 1;\n" }),
			);
			expect(out).toMatch(/^parse_errors: +files=0$/m);
			expect(out).toMatch(/^tsconfig_errors: +0$/m);
		},
		TEST_TIMEOUT,
	);

	it(
		"counts tsconfig errors that load without throwing (a missing extends base)",
		() => {
			const repo = tsRepo(
				{ "src/ok.ts": "export const ok = 1;\n" },
				JSON.stringify({ extends: "./missing-base.json", include: ["src"] }),
			);
			expect(run(SEMANTIC, repo)).toMatch(
				/^tsconfig_errors: +1 \(program may be resolved wrongly; first: .*missing-base\.json/m,
			);
		},
		TEST_TIMEOUT,
	);
});

describe("warrant.mjs — the semantic outcome is part of the decision output", () => {
	const warrant = (semanticText) => {
		const dir = tempDir("rpiv-warrant-");
		const args = [WARRANT, "--files=10"];
		if (semanticText !== undefined) {
			writeFileSync(join(dir, "semantic.txt"), semanticText);
			args.push(`--semantic=${join(dir, "semantic.txt")}`);
		}
		const r = spawnSync(process.execPath, args, {
			cwd: dir,
			input: "",
			encoding: "utf-8",
		});
		return JSON.parse(r.stdout).semantic;
	};
	const blocks =
		"---write-sites-semantic---\n---feature-envy-semantic---\n---dead-exports-semantic---\n---type-fragmentation-semantic---\n";

	it("is not-run without --semantic", () => {
		expect(warrant(undefined)).toBe("not-run");
	});

	it("carries a broken semantic status verbatim", () => {
		expect(
			warrant(
				"---semantic-status---\nbroken: ts-morph failed to load the project x (boom)\n",
			),
		).toBe("broken: ts-morph failed to load the project x (boom)");
	});

	it("carries an unavailable semantic status verbatim", () => {
		expect(
			warrant(
				"---semantic-status---\nunavailable: no tsconfig.json found at or above the target\n",
			),
		).toBe("unavailable: no tsconfig.json found at or above the target");
	});

	it("is ran for a clean run", () => {
		expect(
			warrant(`tsconfig_errors:  0\nparse_errors:     files=0\n${blocks}`),
		).toBe("ran");
	});

	it("is ran-partial when the run saw parse or tsconfig errors", () => {
		const out = warrant(
			`tsconfig_errors:  1 (program may be resolved wrongly; first: x)\nparse_errors:     files=2 (first: a.ts diags=1)\n${blocks}`,
		);
		expect(out).toMatch(
			/^ran-partial: tsconfig_errors=1 .*; parse_errors files=2/,
		);
	});

	it("is unreadable when the --semantic file does not exist", () => {
		const dir = tempDir("rpiv-warrant-");
		const r = spawnSync(
			process.execPath,
			[WARRANT, "--files=10", `--semantic=${join(dir, "nope.txt")}`],
			{
				cwd: dir,
				input: "",
				encoding: "utf-8",
			},
		);
		expect(JSON.parse(r.stdout).semantic).toBe("unreadable");
	});
});

describe("semantic.mjs and warrant.mjs — review round 1 regressions", () => {
	it(
		"reports a target with TypeScript files outside the tsconfig program as broken, not an empty run",
		() => {
			const solution = JSON.stringify({
				files: [],
				references: [{ path: "./tsconfig.app.json" }],
			});
			const repo = tsRepo(
				{
					"src/a.ts": "export const a = 1;\n",
					"src/b.ts": "export const b = 2;\n",
				},
				solution,
			);
			put(
				repo,
				"tsconfig.app.json",
				JSON.stringify({
					compilerOptions: { composite: true },
					include: ["src"],
				}),
			);
			const out = run(SEMANTIC, repo);
			expect(out).toMatch(
				/^---semantic-status---\nbroken: the target has source files but none are in the program/m,
			);
			expect(out).not.toMatch(/---type-fragmentation-semantic---/);
		},
		TEST_TIMEOUT,
	);

	it(
		"reports a target without TypeScript files as unavailable",
		() => {
			const repo = tsRepo({ "src/readme.md": "# nothing to type-check\n" });
			expect(run(SEMANTIC, repo)).toMatch(
				/^unavailable: no source files the program can analyse under the target/m,
			);
		},
		TEST_TIMEOUT,
	);

	const warrantJson = (metricsText, semanticText, extra = []) => {
		const dir = tempDir("rpiv-warrant-");
		writeFileSync(join(dir, "semantic.txt"), semanticText);
		const r = spawnSync(
			process.execPath,
			[
				WARRANT,
				"--files=10",
				`--semantic=${join(dir, "semantic.txt")}`,
				...extra,
			],
			{
				cwd: dir,
				input: metricsText,
				encoding: "utf-8",
			},
		);
		return JSON.parse(r.stdout);
	};
	const PARTIAL =
		"tsconfig_errors:  1 (program may be resolved wrongly; first: x)\nparse_errors:     files=0\n";
	const CLEAN = "tsconfig_errors:  0\nparse_errors:     files=0\n";
	const EMPTY_BLOCKS =
		"---write-sites-semantic---\n---feature-envy-semantic---\n---dead-exports-semantic---\n---type-fragmentation-semantic---\n";
	const REGEX_SEEDS =
		"file_count: 10\n---feature-envy-candidates---\nsrc/feat/trace.ts\tenvies=src/lib/rules.ts\text=12\town=3\tratio=0.80\n---export-usage---\nsrc/lib/old.ts:legacy\tinbound=0\n";

	// Empty semantic blocks over live regex seeds: a partial run proves nothing (the regex
	// seeds stay live, C is unmeasured); a clean run still supersedes them.
	const SCAN = "dead_export_scan: examined=5 capped=false skipped_on_error=0\n";
	const EMPTY_RUNS = [
		{
			name: "a partial run falls back to the regex Fe and A seeds",
			head: PARTIAL,
			outcome: /^ran-partial:/,
			fe: true,
			a: true,
			c: null,
		},
		{
			name: "a clean run still supersedes the regex seeds",
			head: CLEAN,
			outcome: /^ran$/,
			fe: false,
			a: false,
			c: false,
		},
	];

	it.for(EMPTY_RUNS)(
		"with empty semantic blocks, $name",
		({ head, outcome, fe, a, c }) => {
			const out = warrantJson(REGEX_SEEDS, `${head}${SCAN}${EMPTY_BLOCKS}`);
			expect(out.semantic).toMatch(outcome);
			expect(out.lenses).toMatchObject({ Fe: fe, A: a, C: c });
			expect(out.unmeasured.includes("C")).toBe(c === null);
		},
	);

	it("keeps regex write-sites alongside partial semantic ones", () => {
		const metrics =
			"file_count: 10\n---write-sites---\ntable:orders\twriters=2\tfiles=a.ts, b.ts\n";
		const semantic = `${PARTIAL}---write-sites-semantic---\ntable:users\twriters=1\tfiles=c.ts\n---feature-envy-semantic---\n---dead-exports-semantic---\n---type-fragmentation-semantic---\n`;
		expect(warrantJson(metrics, semantic).lenses.S).toBe(true);
	});

	it("reads an empty semantic file (a crash) as broken, not as not-run", () => {
		expect(warrantJson("", "").semantic).toMatch(
			/^broken: semantic\.mjs produced no output/,
		);
	});
});

describe("semantic.mjs — review round 2 regressions", () => {
	it(
		"reports a target that does not exist as broken",
		() => {
			const repo = tsRepo({ "src/a.ts": "export const a = 1;\n" });
			expect(run(SEMANTIC, repo, ["no-such-dir"])).toMatch(
				/^broken: target does not exist \(no-such-dir\)$/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"flags a second target outside the first target's program, and warrant reads the run as partial",
		() => {
			const repo = tsRepo({
				"src/a.ts": "export const a = 1;\n",
				"scripts/w.ts": "export function unusedTool() { return 1; }\n",
			});
			const out = run(SEMANTIC, repo, ["src", "scripts"]);
			expect(out).toMatch(
				/^targets_unmeasured: 1 \(source files outside the program; scripts\)$/m,
			);
			const dir = tempDir("rpiv-warrant-");
			writeFileSync(join(dir, "semantic.txt"), out);
			const w = spawnSync(
				process.execPath,
				[WARRANT, "--files=2", `--semantic=${join(dir, "semantic.txt")}`],
				{
					cwd: dir,
					input: "",
					encoding: "utf-8",
				},
			);
			expect(JSON.parse(w.stdout).semantic).toMatch(
				/^ran-partial: .*targets_unmeasured=1/,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"reports targets_unmeasured: 0 when every target is in the program",
		() => {
			const repo = tsRepo({
				"src/a.ts": "export const a = 1;\n",
				"src/b/c.ts": "export const c = 1;\n",
			});
			expect(run(SEMANTIC, repo, ["src", "src/b"])).toMatch(
				/^targets_unmeasured: 0$/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"with allowJs, reports a JavaScript-only target outside the program as broken",
		() => {
			const tsconfig = JSON.stringify({
				compilerOptions: { allowJs: true },
				include: ["src"],
			});
			const repo = tsRepo(
				{
					"src/a.ts": "export const a = 1;\n",
					"tools/t.js": "export const t = 1;\n",
				},
				tsconfig,
			);
			expect(run(SEMANTIC, repo, ["tools"])).toMatch(
				/^broken: the target has source files but none are in the program/m,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"without allowJs, keeps a JavaScript-only target as unavailable",
		() => {
			const repo = tsRepo({
				"src/a.ts": "export const a = 1;\n",
				"tools/t.js": "export const t = 1;\n",
			});
			expect(run(SEMANTIC, repo, ["tools"])).toMatch(
				/^unavailable: no source files the program can analyse/m,
			);
		},
		TEST_TIMEOUT,
	);
});
