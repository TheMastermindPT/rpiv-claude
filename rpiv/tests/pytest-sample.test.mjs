// tests/pytest-sample.test.mjs — the committed pytest sample tree stays exactly its
// eight files, carries no machine detail, and both ignore files guard it (D10, B12 of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md).
// It reads the live repository's git state, so the Stryker command leaves it out.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = "tests/fixtures/pytest-sample";
const NOT_A_WORK_TREE = "pytest-sample: not a work tree that lists the sample";

const SAMPLE_FILES = [
	"CAPTURE.md",
	"junit/collection-error.xml",
	"junit/no-tests.xml",
	"junit/ok.xml",
	"pyproject.toml",
	"src/demo/__init__.py",
	"tests/test_broken.py",
	"tests/test_ok.py",
];

/** The sample's files, tracked or not yet tracked, relative to the sample folder. */
const listSample = (cwd) => {
	let out = "";
	try {
		out = execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "--", SAMPLE],
			{ cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		out = "";
	}
	const files = out
		.split(/\r?\n/)
		.filter(Boolean)
		.map((path) => path.slice(SAMPLE.length + 1));
	if (files.length === 0) throw new Error(NOT_A_WORK_TREE);
	return files.sort();
};

// A drive path (`C:\`, `d:/`), not inside a word and not a URL scheme's `://`, or a
// POSIX home or system folder.
const MACHINE_DETAIL =
	/(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)|\/(Users|home|tmp|opt|usr|var)\//;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("pytest sample tree (S1-pytest-report)", () => {
	it("B12: the sample holds exactly its eight files, no machine detail, and both ignore files guard it", () => {
		const files = listSample(ROOT);
		expect(files).toEqual(SAMPLE_FILES);
		for (const file of files) {
			const text = readFileSync(join(ROOT, SAMPLE, file), "utf-8");
			expect.soft(text.match(MACHINE_DETAIL)?.[0], file).toBeUndefined();
		}
		const capture = readFileSync(join(ROOT, SAMPLE, "CAPTURE.md"), "utf-8");
		expect.soft(capture, "CAPTURE.md holds no URL").not.toContain("://");
		for (const report of files.filter((file) => file.startsWith("junit/"))) {
			const text = readFileSync(join(ROOT, SAMPLE, report), "utf-8");
			const hosts = [...text.matchAll(/hostname="([^"]*)"/g)].map((m) =>
				m[1].replaceAll("&lt;", "<").replaceAll("&gt;", ">"),
			);
			expect.soft(hosts, report).toEqual(["<host>"]);
		}
		for (const ignoreFile of [".gitignore", "../.gitignore"]) {
			const ignoreLines = readFileSync(join(ROOT, ignoreFile), "utf-8").split(
				/\r?\n/,
			);
			expect
				.soft(ignoreLines, ignoreFile)
				.toEqual(
					expect.arrayContaining(["__pycache__/", ".pytest_cache/", ".venv/"]),
				);
		}
		for (const path of [
			`${SAMPLE}/.venv/pyvenv.cfg`,
			`${SAMPLE}/src/demo/__pycache__/x.pyc`,
			`${SAMPLE}/.pytest_cache/v`,
		]) {
			const check = spawnSync("git", ["check-ignore", "-q", path], {
				cwd: ROOT,
			});
			expect.soft(check.status, path).toBe(0);
		}

		const outside = mkdtempSync(join(tmpdir(), "rpiv-pytest-sample-"));
		dirs.push(outside);
		expect(() => listSample(outside)).toThrow(NOT_A_WORK_TREE);
	});
});
