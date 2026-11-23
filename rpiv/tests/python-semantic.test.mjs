// tests/python-semantic.test.mjs — slice S10-python-semantic of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: python-semantic.mjs
// asks pyright-langserver for the references of each public top-level symbol and prints
// dead-export candidates and feature envy in semantic.mjs's shapes. The real-pyright
// examples run only when a pyright-langserver is on PATH (D22's rule).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/architectural-review/_helpers/python-semantic.mjs");
const TEST_TIMEOUT = 300_000;

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
	const repo = mkdtempSync(join(tmpdir(), "rpiv-pysem-"));
	dirs.push(repo);
	for (const [path, text] of Object.entries(files)) put(repo, path, text);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "-A"], { cwd: repo });
	return repo;
};
const run = (cwd, env = process.env) =>
	spawnSync(process.execPath, [HELPER, "src"], { cwd, encoding: "utf-8", env }).stdout;
/** The rows of a `---<label>---` block. */
const block = (out, label) => {
	const lines = out.split("\n");
	const start = lines.indexOf(`---${label}---`);
	if (start < 0) return null;
	const rows = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("---")) break;
		if (line.trim()) rows.push(line);
	}
	return rows;
};

/** True when a pyright-langserver is on PATH (npm global on Windows, a command elsewhere). */
const langserverOnPath = () =>
	(process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.some(
			(dir) =>
				existsSync(join(dir, "node_modules", "pyright", "langserver.index.js")) ||
				existsSync(join(dir, "pyright-langserver")),
		);
const needPyright = (ctx) => {
	if (!langserverOnPath()) ctx.skip("unavailable: no pyright-langserver on PATH");
};

const APP = {
	"pyproject.toml": '[project]\nname = "app"\n',
	"src/app/__init__.py": "",
	"src/app/core.py": [
		"from app.db import get",
		"",
		"LIMIT = 3",
		"",
		"",
		"def run():",
		"    return get()",
		"",
		"",
		"def helper_unused():",
		"    return 1",
		"",
	].join("\n"),
	"src/app/db.py": [
		'__all__ = ["scan"]',
		"",
		'TABLE = "t"',
		"",
		"",
		"def get():",
		"    return None",
		"",
		"",
		"def put(x):",
		"    return x",
		"",
		"",
		"def scan():",
		"    return []",
		"",
	].join("\n"),
	"src/app/report.py": [
		"from app import db",
		"",
		"",
		"def render():",
		"    db.get()",
		"    db.get()",
		"    db.get()",
		"    db.put(1)",
		"    db.put(2)",
		"    return db.TABLE",
		"",
		"",
		"def main():",
		"    return render()",
		"",
	].join("\n"),
	"tests/test_core.py": "from app.core import run\n\n\ndef test_run():\n    assert run() is None\n",
};

describe("python-semantic.mjs (S10-python-semantic)", () => {
	it(
		"B51: with no pyright-langserver in the .venv or on PATH it is unavailable and prints no block",
		() => {
			const repo = repoWith(APP);
			const git = spawnSync("git", ["--exec-path"], { encoding: "utf-8" }).stdout.trim();
			const gitBin = dirname(execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf-8" }).split(/\r?\n/)[0]);
			const env = { ...process.env, PATH: [dirname(process.execPath), gitBin, git].join(delimiter) };
			const out = run(repo, env);
			expect(out).toBe("---semantic-status---\nunavailable: no pyright-langserver (project .venv or PATH)\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"B51: dead-export candidates are symbols with no reference from another file, apart from __all__",
		(ctx) => {
			needPyright(ctx);
			const out = run(repoWith(APP));
			expect.soft(block(out, "dead-exports-semantic")).toEqual([
				"src/app/core.py:LIMIT\tkind=constant\textRefs=0",
				"src/app/core.py:helper_unused\tkind=function\textRefs=0",
				"src/app/report.py:main\tkind=function\textRefs=0",
				"src/app/report.py:render\tkind=function\textRefs=0",
			]);
			expect.soft(out).toContain("dead_export_scan: examined=9 capped=false skipped_on_error=0\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"B52: feature envy comes from the same references, with semantic.mjs's gates",
		(ctx) => {
			needPyright(ctx);
			const out = run(repoWith(APP));
			expect(block(out, "feature-envy-semantic")).toEqual([
				"src/app/report.py\tenvies=src/app/db.py\text=6\town=1\tratio=0.86\tbehavioralRefs=5\tdataRefs=1",
			]);
		},
		TEST_TIMEOUT,
	);

	it(
		"B53: the output is a partial run for warrant and prints no unmeasured block",
		(ctx) => {
			needPyright(ctx);
			const out = run(repoWith(APP));
			expect.soft(block(out, "semantic-status")?.[0]).toMatch(/^ran-partial: python via pyright/);
			expect.soft(block(out, "type-fragmentation-semantic")).toBeNull();
			expect.soft(block(out, "write-sites-semantic")).toBeNull();
		},
		TEST_TIMEOUT,
	);

	it("B53: tool ingestion runs python-semantic for a Python-only target and names findReferences", () => {
		for (const path of [
			"skills/architectural-review/references/tool-ingestion.md",
			"opencode/generated/skills/rpiv-architectural-review/references/tool-ingestion.md",
		]) {
			const text = readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");
			for (const phrase of [/python-semantic\.mjs/, /warrant\.mjs[^.]*--semantic/, /findReferences/]) {
				expect.soft(text, path).toMatch(phrase);
			}
		}
	});
});
