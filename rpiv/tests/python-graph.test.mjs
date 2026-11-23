// tests/python-graph.test.mjs — slice S7-python-graph of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: python-graph.mjs
// writes grimp's import graph as madge JSON of files, and import-contracts.mjs reads
// lint-imports by its summary line. Real-Python examples run only when
// RPIV_TEST_GRIMP_VENV names a venv holding grimp and import-linter (D22's rule).

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = join(ROOT, "skills/architectural-review/_helpers");
const GRAPH = join(HELPERS, "python-graph.mjs");
const CONTRACTS = join(HELPERS, "import-contracts.mjs");
const FIXTURES = join(ROOT, "tests/fixtures/import-linter");
const TEST_TIMEOUT = 180_000;

let readLintImports;
beforeEach(async () => {
	({ readLintImports } = await import(pathToFileURL(CONTRACTS).href));
});

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const slash = (path) => path.replaceAll("\\", "/");
/** A git repo holding `files`, its toplevel as git prints it. */
const repoWith = (files) => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-pygraph-"));
	dirs.push(repo);
	for (const [path, text] of Object.entries(files)) put(repo, path, text);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	return repo;
};
const run = (script, cwd, ...args) =>
	execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf-8" });
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf-8");

const SHOP = {
	"pyproject.toml": [
		"[project]",
		'name = "shop"',
		"",
		"[tool.importlinter]",
		'root_package = "shop"',
		"",
		"[[tool.importlinter.contracts]]",
		'name = "Layers"',
		'type = "layers"',
		'layers = ["shop.api", "shop.core", "shop.db"]',
		"",
		"[[tool.importlinter.contracts]]",
		'name = "API must not touch db"',
		'type = "forbidden"',
		'source_modules = ["shop.api"]',
		'forbidden_modules = ["shop.db"]',
		"",
	].join("\n"),
	"src/shop/__init__.py": "",
	"src/shop/core.py": "from shop import db\n\ndef run():\n    return db.get()\n",
	"src/shop/db.py": "import os\n\ndef get():\n    return 1\n",
	"src/shop/api/__init__.py": "",
	"src/shop/api/views.py": "from shop.core import run\nfrom ..db import get\n",
};

/** The venv named by RPIV_TEST_GRIMP_VENV, or a skip saying it is unavailable. */
const needVenv = (ctx) => {
	const venv = process.env.RPIV_TEST_GRIMP_VENV;
	if (!venv) ctx.skip("unavailable: RPIV_TEST_GRIMP_VENV not set");
	return venv;
};
/** The SHOP project with `.venv` linked to `venv` (a junction on Windows). */
const shopWithVenv = (venv) => {
	const repo = repoWith(SHOP);
	symlinkSync(venv, join(repo, ".venv"), "junction");
	return repo;
};
const pycacheUnder = (dir) =>
	readdirSync(dir, { recursive: true }).some((p) =>
		String(p).replaceAll("\\", "/").split("/").includes("__pycache__"),
	);

describe("import-contracts.mjs reads lint-imports (S7-python-graph)", () => {
	it("B45: the summary line gives kept and broken counts, contract rows and broken chains; no summary is broken", () => {
		expect(readLintImports(fixture("kept-broken.txt"))).toEqual([
			"import-contracts: ok kept=1 broken=1",
			"---import-contracts---",
			"Layers\tKEPT",
			"API must not touch db\tBROKEN",
			"---broken-contracts---",
			"API must not touch db",
			"shop.api is not allowed to import shop.db:",
			"-   shop.api.views -> shop.core (l.1)",
			"    shop.core -> shop.db (l.1)",
			"-   shop.api.views -> shop.db (l.2)",
		]);
		expect
			.soft(readLintImports(fixture("missing-package.txt")))
			.toEqual([
				"import-contracts: broken: Could not find package 'shop' in your Python path.",
			]);
		expect
			.soft(readLintImports(fixture("bad-type.txt")))
			.toEqual(["import-contracts: broken: laaayers"]);
		expect.soft(readLintImports("")).toEqual(["import-contracts: broken: no output"]);
	});

	it(
		"B45: no lint-imports in the .venv, or no config, is unavailable",
		() => {
			const bare = repoWith({ "pyproject.toml": "[project]\n" });
			const top = slash(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: bare, encoding: "utf-8" }).trim());
			expect
				.soft(run(CONTRACTS, bare, "."))
				.toBe(`import-contracts: unavailable: lint-imports not installed in ${top}/.venv\n`);
			const venv = repoWith({
				"pyproject.toml": "[project]\n",
				".venv/Scripts/lint-imports.exe": "",
				".venv/bin/lint-imports": "",
			});
			expect
				.soft(run(CONTRACTS, venv, "."))
				.toBe("import-contracts: unavailable: no import-linter config\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"B45: a real lint-imports run on the spike project reads like the captured one",
		(ctx) => {
			const repo = shopWithVenv(needVenv(ctx));
			const out = run(CONTRACTS, repo, ".");
			expect(out.split("\n").slice(0, 4)).toEqual([
				"import-contracts: ok kept=1 broken=1",
				"---import-contracts---",
				"Layers\tKEPT",
				"API must not touch db\tBROKEN",
			]);
			expect.soft(existsSync(join(repo, ".import_linter_cache"))).toBe(false);
		},
		TEST_TIMEOUT,
	);
});

describe("python-graph.mjs writes grimp's graph (S7-python-graph)", () => {
	it(
		"B44: no .venv python, or no package folder, is unavailable and writes nothing",
		() => {
			const bare = repoWith({ "pyproject.toml": "[project]\n", "src/shop/__init__.py": "" });
			const top = slash(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: bare, encoding: "utf-8" }).trim());
			const out = join(bare, "graph.json");
			expect
				.soft(run(GRAPH, bare, ".", "--out", out))
				.toBe(`python-graph: unavailable: no .venv python in ${top}\n`);
			expect.soft(existsSync(out)).toBe(false);

			const empty = repoWith({
				"pyproject.toml": "[project]\n",
				"src/tests/__init__.py": "",
				".venv/Scripts/python.exe": "",
				".venv/bin/python": "",
			});
			const emptyTop = slash(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: empty, encoding: "utf-8" }).trim());
			expect
				.soft(run(GRAPH, empty, ".", "--out", join(empty, "g.json")))
				.toBe(`python-graph: unavailable: no Python package under ${emptyTop}/src\n`);
		},
		TEST_TIMEOUT,
	);

	it(
		"B44: a real grimp run writes the file graph read-only, and a missing package is broken",
		(ctx) => {
			const repo = shopWithVenv(needVenv(ctx));
			const out = join(tempOut(), "graph.json");
			expect(run(GRAPH, repo, ".", "--out", out)).toBe(
				"python-graph: ok modules=5 edges=3\n",
			);
			const graph = JSON.parse(readFileSync(out, "utf-8"));
			expect.soft(graph["src/shop/api/views.py"]).toEqual(["src/shop/core.py", "src/shop/db.py"]);
			expect.soft(graph["src/shop/core.py"]).toEqual(["src/shop/db.py"]);
			expect.soft(graph["src/shop/db.py"]).toEqual([]);
			expect.soft(pycacheUnder(join(repo, "src"))).toBe(false);

			const missing = join(tempOut(), "missing.json");
			expect
				.soft(run(GRAPH, repo, ".", "--package", "nopkg", "--out", missing))
				.toBe(
					"python-graph: broken: ValueError: Could not find package 'nopkg' in your Python path.\n",
				);
			expect.soft(existsSync(missing)).toBe(false);
		},
		TEST_TIMEOUT,
	);
});

const tempOut = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-pygraph-out-"));
	dirs.push(dir);
	return dir;
};

describe("tool ingestion prose (S7-python-graph)", () => {
	it("B46: tool ingestion runs python-graph and import-contracts for a Python root", () => {
		for (const path of [
			"skills/architectural-review/references/tool-ingestion.md",
			"opencode/generated/skills/rpiv-architectural-review/references/tool-ingestion.md",
		]) {
			const text = readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");
			for (const phrase of [
				/python-graph\.mjs/,
				/import-contracts\.mjs/,
				/stability\.mjs[^.]*--graph=<scratchpad>\/python-graph\.json/,
				/BROKEN contract[^.]*L ground truth/i,
			]) {
				expect.soft(text, path).toMatch(phrase);
			}
		}
	});
});
