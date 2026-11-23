// tests/metrics-python.test.mjs — slice S6-metrics-jscpd of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: metrics.mjs
// measures complexity, exports with inbound use, test density and import edges for
// `.py` files.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METRICS = join(ROOT, "skills/architectural-review/_helpers/metrics.mjs");
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
const git = (repo, ...args) =>
	execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });
const newRepo = () => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-metrics-py-"));
	dirs.push(repo);
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "p@example.invalid");
	git(repo, "config", "user.name", "p");
	git(repo, "config", "core.autocrlf", "false");
	return repo;
};
const commit = (repo, files, message) => {
	for (const [path, text] of Object.entries(files)) put(repo, path, text);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
};
const metrics = (repo) =>
	execFileSync(process.execPath, [METRICS, "."], { cwd: repo, encoding: "utf-8" });
/** The rows of a `---<label>---` block. */
const block = (out, label) => {
	const lines = out.split("\n");
	const start = lines.indexOf(`---${label}---`);
	if (start < 0) return [];
	const rows = [];
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("---")) break;
		if (line.trim()) rows.push(line);
	}
	return rows;
};

const CORE = [
	"def run(a, b, c, y, z):",
	"    # if this comment counted, decisions would be 7",
	"    if a and b:",
	"        return 1",
	"    elif c:",
	"        return 2",
	"    for x in y:",
	"        print(x)",
	"    while z:",
	"        z = z - 1",
	"    try:",
	"        return 3",
	"    except ValueError:",
	"        return 4",
	"",
].join("\n");

const LEDGER = [
	"def one():",
	"    return 1",
	"",
	"def two():",
	"    return 2",
	"",
	"class Three:",
	"    pass",
	"",
	"FOUR = 4",
	"",
	"def five():",
	"    return 5",
	"",
	"def _hidden():",
	"    return 0",
	"",
].join("\n");

const THIN_TEST = [
	"import pytest",
	"",
	"def test_a():",
	"    assert 1 == 1",
	"",
	"def test_b():",
	"    with pytest.raises(ValueError):",
	"        int('x')",
	"",
	"def test_c():",
	"    print('no check')",
	"",
].join("\n");

describe("metrics.mjs on Python files (S6-metrics-jscpd)", () => {
	it(
		"B41: py files get complexity, export-usage with inbound, and test density rows",
		() => {
			const repo = newRepo();
			commit(
				repo,
				{
					"pyproject.toml": "[project]\nname = 'pkg'\n",
					"src/pkg/__init__.py": "",
					"src/pkg/core.py": CORE,
					"src/pkg/ledger.py": LEDGER,
					"src/pkg/use.py": "from pkg.ledger import one\n\nprint(one())\n",
					"tests/test_thin.py": THIN_TEST,
				},
				"base",
			);
			const out = metrics(repo);
			expect
				.soft(block(out, "complexity").find((r) => r.startsWith("src/pkg/core.py\t")))
				.toMatch(/^src\/pkg\/core\.py\tdecisions=6\t/);
			expect
				.soft(block(out, "export-usage"))
				.toContain("src/pkg/ledger.py\texports=5\tinbound=1");
			expect
				.soft(block(out, "test-density"))
				.toContain("tests/test_thin.py\tcases=3\tasserts=2\tratio=0.67");
		},
		TEST_TIMEOUT,
	);

	it(
		"B42: py files that import each other, absolutely or relatively, are not hidden coupling",
		() => {
			for (const importLine of [
				"from pkg.b import f\n",
				"from .b import f\n",
			]) {
				const repo = newRepo();
				const files = (n) => ({
					"src/pkg/a.py": `${importLine}\nVALUE_A = ${n}\n`,
					"src/pkg/b.py": `def f():\n    return ${n}\n`,
					"src/pkg/c.py": `VALUE_C = ${n}\n`,
					"src/pkg/d.py": `VALUE_D = ${n}\n`,
				});
				commit(
					repo,
					{ "pyproject.toml": "[project]\n", "src/pkg/__init__.py": "", ...files(0) },
					"base",
				);
				for (const n of [1, 2, 3]) {
					const next = files(n);
					commit(
						repo,
						{ "src/pkg/a.py": next["src/pkg/a.py"], "src/pkg/b.py": next["src/pkg/b.py"] },
						`ab ${n}`,
					);
					commit(
						repo,
						{ "src/pkg/c.py": next["src/pkg/c.py"], "src/pkg/d.py": next["src/pkg/d.py"] },
						`cd ${n}`,
					);
				}
				const rows = block(metrics(repo), "co-change-candidates");
				expect
					.soft(rows.some((r) => r.includes("src/pkg/c.py") && r.includes("src/pkg/d.py")), importLine)
					.toBe(true);
				expect
					.soft(rows.some((r) => r.includes("src/pkg/a.py") && r.includes("src/pkg/b.py")), importLine)
					.toBe(false);
			}
		},
		TEST_TIMEOUT,
	);
});
