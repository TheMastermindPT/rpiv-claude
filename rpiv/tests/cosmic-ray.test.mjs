// tests/cosmic-ray.test.mjs — slice S8-cosmic-ray of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: mutation.mjs reads a
// Cosmic Ray session through `cosmic-ray dump`, and a session that cannot show survivors
// is never read as zero survivors. The parser runs in-process on dumps captured from real
// Cosmic Ray 8.9.0 runs (tests/fixtures/cosmic-ray/CAPTURE.md). The real-run example runs
// only when RPIV_TEST_COSMIC_VENV names a venv holding Cosmic Ray and pytest (D22's rule).

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
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
const MUTATION = join(HELPERS, "mutation.mjs");
const PROBE = join(ROOT, "skills/_shared/tool-probe.mjs");
const FIXTURES = join(ROOT, "tests/fixtures/cosmic-ray");
const TEST_TIMEOUT = 300_000;

let readCosmicDump;
let cosmicLines;
beforeEach(async () => {
	({ readCosmicDump, cosmicLines } = await import(
		pathToFileURL(join(HELPERS, "cosmic-ray.mjs")).href
	));
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
const repoWith = (files) => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-cosmic-"));
	dirs.push(repo);
	for (const [path, text] of Object.entries(files)) put(repo, path, text);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	return repo;
};
const topOf = (repo) =>
	execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf-8" })
		.trim()
		.replaceAll("\\", "/");
const run = (script, cwd, ...args) =>
	execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf-8" });
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf-8");

/** The parser's lines for a captured dump, read at root `/r` with target `src/calc`. */
const linesOf = (name) => {
	const ctx = {
		root: "/r",
		relOf: (path) => (path.startsWith("/r/") ? path.slice(3) : path),
		underAny: (path) => path === "src/calc" || path.startsWith("src/calc/"),
	};
	return cosmicLines(readCosmicDump(fixture(name), ctx), "cosmic-ray.sqlite");
};

describe("Cosmic Ray sessions in mutation.mjs (S8-cosmic-ray)", () => {
	it("B47: a finished session gives per-file rows with incompetent counted apart", () => {
		expect(linesOf("dump-run.jsonl")).toEqual({
			head: [
				"mutation_report: cosmic-ray cosmic-ray.sqlite",
				"mutation_overall: killed=14 survived=4 score=78% incompetent=0",
			],
			rows: [
				"src/calc/ops.py\tkilled=14\tsurvived=4\tnoCoverage=0\ttimeout=0\tscore=78%\tincompetent=0",
			],
		});
	});

	it("B48: all-incompetent, unfinished and unreadable sessions are never read as zero survivors", () => {
		expect.soft(linesOf("dump-incompetent.jsonl")).toEqual({
			head: [
				"mutation_report: cosmic-ray cosmic-ray.sqlite (all-incompetent — 18 jobs; the test command never ran)",
			],
			rows: [],
		});
		expect.soft(linesOf("dump-pending.jsonl")).toEqual({
			head: [
				"mutation_report: cosmic-ray cosmic-ray.sqlite (incomplete — 18 of 18 jobs not run)",
			],
			rows: [],
		});
		const broken = cosmicLines(
			readCosmicDump("not json\n", { root: "/r", relOf: (p) => p, underAny: () => true }),
			"cosmic-ray.sqlite",
		);
		expect.soft(broken.head[0]).toMatch(/^mutation_report: cosmic-ray cosmic-ray\.sqlite \(parse-error: .+\)$/);
		expect.soft(broken.rows).toEqual([]);
	});

	it(
		"B48: a session with no cosmic-ray in the .venv is broken, never none",
		() => {
			const repo = repoWith({
				"pyproject.toml": "[project]\n",
				"src/calc/__init__.py": "",
				"src/calc/ops.py": "def add(a, b):\n    return a + b\n",
				"cosmic-ray.sqlite": "",
			});
			execFileSync("git", ["add", "-A"], { cwd: repo });
			const out = run(MUTATION, repo, "src/calc");
			expect.soft(out).toContain(
				`mutation_report: broken — cosmic-ray not installed in ${topOf(repo)}/.venv (session cosmic-ray.sqlite)\n`,
			);
			expect.soft(out).toMatch(/^mutation_scope: target_has=2 report_covers=0 missing=2 \(broken\)$/m);
			expect.soft(out).not.toContain("---mutation---");
		},
		TEST_TIMEOUT,
	);

	it(
		"B49: the probe reads a Python root session as the mutation report",
		() => {
			const repo = repoWith({ "pyproject.toml": "[project]\n", "cosmic-ray.sqlite": "" });
			expect.soft(run(PROBE, repo, ".")).toContain("\nmutation: present\n");
			const bare = repoWith({ "pyproject.toml": "[project]\n" });
			expect.soft(run(PROBE, bare, ".")).toContain("\nmutation: absent\n");
		},
		TEST_TIMEOUT,
	);

	it("B49: tool ingestion offers Cosmic Ray only in a disposable copy, with an absolute interpreter", () => {
		for (const path of [
			"skills/architectural-review/references/tool-ingestion.md",
			"opencode/generated/skills/rpiv-architectural-review/references/tool-ingestion.md",
		]) {
			const text = readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");
			for (const phrase of [
				/cosmic-ray exec[^.]*disposable copy/i,
				/absolute forward-slash/i,
				/all-incompetent/,
			]) {
				expect.soft(text, path).toMatch(phrase);
			}
		}
	});

	it(
		"B47: a real Cosmic Ray session read through mutation.mjs gives the same head lines",
		(ctx) => {
			const venv = process.env.RPIV_TEST_COSMIC_VENV;
			if (!venv) ctx.skip("unavailable: RPIV_TEST_COSMIC_VENV not set");
			const repo = repoWith({
				"pyproject.toml": "[project]\n",
				"src/calc/__init__.py": "",
				"src/calc/ops.py":
					"def add(a, b):\n    return a + b\n\n\ndef is_big(n):\n    return n > 10\n",
				"tests/test_ops.py":
					"from calc.ops import add, is_big\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_big():\n    assert is_big(20)\n",
			});
			execFileSync("git", ["add", "-A"], { cwd: repo });
			symlinkSync(venv, join(repo, ".venv"), "junction");
			const python = join(venv, "Scripts", "python.exe").replaceAll("\\", "/");
			put(
				repo,
				"cosmic-ray.toml",
				`[cosmic-ray]\nmodule-path = "src/calc/ops.py"\ntimeout = 30.0\nexcluded-modules = []\ntest-command = "${python} -m pytest -x -q -p no:cacheprovider tests"\n\n[cosmic-ray.distributor]\nname = "local"\n`,
			);
			const cr = join(venv, "Scripts", "cosmic-ray.exe");
			const env = { ...process.env, PYTHONPATH: join(repo, "src"), PYTHONDONTWRITEBYTECODE: "1" };
			execFileSync(cr, ["init", "cosmic-ray.toml", "cosmic-ray.sqlite"], { cwd: repo, env, stdio: "ignore" });
			execFileSync(cr, ["exec", "cosmic-ray.toml", "cosmic-ray.sqlite"], { cwd: repo, env, stdio: "ignore" });
			const out = run(MUTATION, repo, "src/calc");
			expect(out.split("\n").slice(0, 3)).toEqual([
				"mutation_report: cosmic-ray cosmic-ray.sqlite",
				"mutation_overall: killed=14 survived=4 score=78% incompetent=0",
				"mutation_scope: target_has=2 report_covers=1 missing=1 (partial)",
			]);
		},
		TEST_TIMEOUT,
	);
});
