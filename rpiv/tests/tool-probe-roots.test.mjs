// tests/tool-probe-roots.test.mjs — slice S4-probe-roots of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md: the probe finds
// every target's project root (package.json or pyproject.toml), prints each root, and
// reads a Python root's tools from its .venv without running anything.

import { execFileSync } from "node:child_process";
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "skills/_shared/tool-probe.mjs");
const TEST_TIMEOUT = 180_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-probe-roots-"));
	dirs.push(dir);
	return dir;
};
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const slash = (path) => path.replaceAll("\\", "/");

/** A git repo holding `files` (`{ path: text }`; a path ending in `/` is a folder). */
const repoWith = (files) => {
	const repo = tempDir();
	for (const [path, text] of Object.entries(files)) {
		if (path.endsWith("/")) mkdirSync(join(repo, path), { recursive: true });
		else put(repo, path, text);
	}
	execFileSync("git", ["init", "-q"], { cwd: repo });
	const top = slash(
		execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: repo,
			encoding: "utf-8",
		}).trim(),
	);
	return { repo, top };
};
const probe = (repo, ...targets) =>
	execFileSync(process.execPath, [PROBE, ...targets], {
		cwd: repo,
		encoding: "utf-8",
	});
const rowOf = (out, tool) =>
	out.split("\n").find((line) => line.startsWith(`${tool}\t`)) ?? "";

const MIXED = {
	"pyproject.toml": '[project]\nname = "x"\n',
	"src/x/__init__.py": "",
	"ui/package.json": JSON.stringify({ name: "ui", scripts: { knip: "knip" } }),
};

describe("tool-probe project roots (S4-probe-roots)", () => {
	it(
		"B35: each target root is its nearest package.json or pyproject.toml, walking up only",
		() => {
			const mixed = repoWith(MIXED);
			const out = probe(mixed.repo, "src", "ui");
			expect.soft(out).toContain(`root:      ${mixed.top}\n`);
			expect.soft(out).toContain("ecosystem: python\n");
			expect
				.soft(out)
				.toContain(`also_root: ${mixed.top}/ui\tecosystem=js-ts\n`);

			const rpivLike = repoWith({
				"package.json": JSON.stringify({ name: "rpiv" }),
				"tests/fixtures/pytest-sample/pyproject.toml": "[project]\n",
				"tests/a.test.mjs": "",
			});
			const one = probe(rpivLike.repo, "tests");
			expect.soft(one).toContain(`root:      ${rpivLike.top}\n`);
			expect.soft(one).toContain("ecosystem: js-ts\n");
			expect.soft(one).not.toContain("also_root:");
		},
		TEST_TIMEOUT,
	);

	it("B35: tool-probe, target-context and semantic take the root walk from project-root.mjs", () => {
		for (const path of [
			"skills/_shared/tool-probe.mjs",
			"skills/architectural-review/_helpers/target-context.mjs",
			"skills/architectural-review/_helpers/semantic.mjs",
		]) {
			const text = readFileSync(join(ROOT, path), "utf-8");
			expect
				.soft(text, path)
				.toMatch(
					/import \{[^}]*\bfindProjectRoot\b[^}]*\} from "[./]*(?:_shared\/)?project-root\.mjs"/,
				);
			expect.soft(text, path).not.toMatch(/const findProjectRoot\s*=/);
		}
	});

	it(
		"B36: a Python root reads its eight tools from the .venv, with configs and uv hints",
		() => {
			const site = ".venv/Lib/site-packages/";
			const { repo } = repoWith({
				"pyproject.toml":
					'[project]\nname = "x"\n\n[tool.pytest.ini_options]\npythonpath = ["src"]\n\n[tool.ruff]\nline-length = 100\n',
				[`${site}pytest-9.2.0.dist-info/`]: "",
				[`${site}ruff-0.9.1.dist-info/`]: "",
				[`${site}import_linter-2.1.dist-info/`]: "",
				[`${site}grimp-3.5.dist-info/`]: "",
			});
			const out = probe(repo, ".");
			expect.soft(out).toContain("ecosystem: python\n");
			expect
				.soft(rowOf(out, "pytest"))
				.toBe("pytest\tlens=T\tstatus=configured\tconfig=pyproject.toml");
			expect
				.soft(rowOf(out, "ruff"))
				.toBe("ruff\tlens=lint\tstatus=configured\tconfig=pyproject.toml");
			expect
				.soft(rowOf(out, "import-linter"))
				.toMatch(/^import-linter\tlens=L\tstatus=installed-unconfigured\t/);
			expect.soft(rowOf(out, "grimp")).toBe("grimp\tlens=L\tstatus=installed");
			for (const [tool, pkg] of [
				["coverage.py", "coverage"],
				["cosmic-ray", "cosmic-ray"],
				["vulture", "vulture"],
				["pyright", "pyright"],
			]) {
				expect
					.soft(rowOf(out, tool), tool)
					.toMatch(new RegExp(`\\tstatus=absent\\thint=uv add --dev ${pkg}$`));
			}

			const posix = repoWith({
				"pyproject.toml": "[project]\n",
				".venv/lib/python3.13/site-packages/pytest-9.2.0.dist-info/": "",
			});
			expect
				.soft(rowOf(probe(posix.repo, "."), "pytest"))
				.toBe("pytest\tlens=T\tstatus=installed");

			const bare = repoWith({ "pyproject.toml": "[project]\n" });
			const none = probe(bare.repo, ".");
			for (const tool of [
				"pytest",
				"coverage.py",
				"cosmic-ray",
				"ruff",
				"vulture",
				"import-linter",
				"grimp",
				"pyright",
			]) {
				expect.soft(rowOf(none, tool), tool).toMatch(/\tstatus=absent\t/);
			}
		},
		TEST_TIMEOUT,
	);

	it("B36: the probe never calls uv run or uv sync, and pipAvailable uses no shell", () => {
		const text = readFileSync(PROBE, "utf-8");
		expect.soft(text).not.toMatch(/["']uv["']\s*,\s*\[\s*["'](?:run|sync)["']/);
		const pip = /const pipAvailable = [\s\S]*?\n};/.exec(text)?.[0] ?? "";
		expect(pip).not.toBe("");
		expect.soft(pip).not.toMatch(/shell\s*:/);
	});

	it(
		"B37: targets that span roots print every root, and parseToolProbe keeps every root",
		async () => {
			const mixed = repoWith(MIXED);
			const out = probe(mixed.repo, "src", "ui");
			const head = out.split("---tool-coverage---")[0];
			expect.soft(head).not.toContain("roots_note");
			expect.soft(rowOf(out, "pytest")).not.toContain("\troot=");
			expect
				.soft(rowOf(out, "knip"))
				.toMatch(new RegExp(`\\troot=${mixed.top}/ui$`));
			expect
				.soft(out.split("\n").filter((l) => l.startsWith("ast-grep\t")))
				.toHaveLength(1);

			const { parseToolProbe } = await import(
				"../skills/deep-review/_helpers/review-preflight.mjs"
			);
			const parsed = parseToolProbe(out);
			expect.soft(parsed.ecosystem).toBe("python");
			expect.soft(parsed.local.pytest?.status).toBeDefined();
			expect.soft(parsed.local.knip?.root).toBe(`${mixed.top}/ui`);
			expect.soft(parsed.roots?.[mixed.top]?.ecosystem).toBe("python");
			expect.soft(parsed.roots?.[`${mixed.top}/ui`]?.ecosystem).toBe("js-ts");
			expect
				.soft(Object.keys(parsed.roots?.[`${mixed.top}/ui`]?.local ?? {}))
				.toContain("knip");
		},
		TEST_TIMEOUT,
	);

	it(
		"B37: single-root output is unchanged from the probe at aa62592, apart from the ts-morph row",
		() => {
			const base = join(tempDir(), "tool-probe-base.mjs");
			writeFileSync(
				base,
				execFileSync(
					"git",
					["show", "aa62592:rpiv/skills/_shared/tool-probe.mjs"],
					{ cwd: ROOT, encoding: "utf-8" },
				),
			);
			const { repo } = repoWith({
				"package.json": JSON.stringify({
					name: "x",
					devDependencies: { vitest: "^4" },
					scripts: { knip: "knip", "test:coverage": "vitest --coverage" },
				}),
				"src/a.ts": "export const a = 1;\n",
			});
			const withoutTsMorph = (text) =>
				text
					.split("\n")
					.filter((line) => !line.startsWith("ts-morph\t"))
					.join("\n");
			const before = execFileSync(process.execPath, [base, "src"], {
				cwd: repo,
				encoding: "utf-8",
			});
			expect(withoutTsMorph(probe(repo, "src"))).toBe(withoutTsMorph(before));
		},
		TEST_TIMEOUT,
	);
});
