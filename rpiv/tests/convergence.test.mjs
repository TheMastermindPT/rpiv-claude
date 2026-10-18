// tests/convergence.test.mjs — contract tests for skills/_shared/convergence.mjs, the
// deterministic "reopen approach" trigger at the slice review cap: the slice source grew
// by more than half between the first and the last reviewed candidate while its
// blocker rows did not fall. The CLI is spawned in throwaway git repositories.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/convergence.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

const newRepo = () => {
	const repo = mkdtempSync(join(tmpdir(), "rpiv-convergence-"));
	dirs.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "c@example.invalid");
	git(repo, "config", "user.name", "c");
	git(repo, "config", "core.autocrlf", "false");
	return repo;
};

const put = (repo, path, text) => {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
};

const commitAll = (repo, message) => {
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
};

const lines = (n) =>
	`${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

const run = (repo, ...args) => {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		cwd: repo,
		encoding: "utf-8",
	});
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

/** base, then a first candidate with 10 source lines (plus 100 test lines), then a
    second candidate that grows the source to `secondLines`. */
const twoCandidates = (secondLines) => {
	const repo = newRepo();
	put(repo, "README.md", "base\n");
	const base = commitAll(repo, "base");
	put(repo, "src/parse.mjs", lines(10));
	put(repo, "tests/parse.test.mjs", lines(100));
	const first = commitAll(repo, "candidate 1");
	put(repo, "src/parse.mjs", lines(secondLines));
	const second = commitAll(repo, "candidate 2");
	return { repo, base, first, second };
};

describe("convergence rule", () => {
	it("reopens when the source grew by more than half and blockers did not fall", async () => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		const result = convergence([
			{ lines: 100, blockers: 3 },
			{ lines: 160, blockers: 3 },
		]);
		expect(result.decision).toBe("reopen");
		expect(result.reasons).toContain("lines: 100 -> 160 (+60%)");
		expect(result.reasons).toContain("blockers: 3 -> 3");
	});

	it("keeps going when blockers fell, the growth is at most half, or blockers rose on a small change", async () => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		expect(
			convergence([
				{ lines: 100, blockers: 3 },
				{ lines: 300, blockers: 1 },
			]).decision,
		).toBe("keep");
		expect(
			convergence([
				{ lines: 100, blockers: 3 },
				{ lines: 150, blockers: 4 },
			]).decision,
		).toBe("keep");
		expect(
			convergence([
				{ lines: 100, blockers: 2 },
				{ lines: 120, blockers: 5 },
			]).decision,
		).toBe("keep");
	});

	it("compares the first and the last round, whatever lies between", async () => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		const result = convergence([
			{ lines: 100, blockers: 4 },
			{ lines: 110, blockers: 1 },
			{ lines: 200, blockers: 4 },
		]);
		expect(result.decision).toBe("reopen");
	});

	it("refuses to decide on fewer than two rounds, an unknown size or count, or an empty first candidate", async () => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		expect(() => convergence([{ lines: 100, blockers: 1 }])).toThrow(
			/at least two rounds/,
		);
		expect(() =>
			convergence([
				{ lines: null, blockers: 1 },
				{ lines: 10, blockers: 1 },
			]),
		).toThrow(/size unknown/);
		expect(() =>
			convergence([
				{ lines: 10, blockers: 1 },
				{ lines: 20, blockers: Number.NaN },
			]),
		).toThrow(/blocker count/);
		expect(() =>
			convergence([
				{ lines: 0, blockers: 1 },
				{ lines: 20, blockers: 1 },
			]),
		).toThrow(/no slice source/);
	});
});

describe("convergence CLI", () => {
	it(
		"measures slice source without tests and exits 1 with reopen",
		() => {
			const { repo, base, first, second } = twoCandidates(25);
			const res = run(
				repo,
				"--round",
				`${base}..${first}=2`,
				"--round",
				`${base}..${second}=2`,
			);
			expect(res.status).toBe(1);
			expect(res.stdout.split("\n")[0]).toBe("convergence: reopen");
			expect(res.stdout).toContain("reason: lines: 10 -> 25 (+150%)");
			expect(res.stderr).toBe("");
		},
		TEST_TIMEOUT,
	);

	it(
		"exits 0 with keep when the blockers fell",
		() => {
			const { repo, base, first, second } = twoCandidates(25);
			const res = run(
				repo,
				"--round",
				`${base}..${first}=3`,
				"--round",
				`${base}..${second}=1`,
			);
			expect(res.status).toBe(0);
			expect(res.stdout.split("\n")[0]).toBe("convergence: keep");
		},
		TEST_TIMEOUT,
	);

	it(
		"is broken, never keep, on a bad round, a missing revision or a binary source file",
		() => {
			const { repo, base, first, second } = twoCandidates(25);
			const cases = [
				[["--round", `${base}..${first}`], "round"],
				[["--round", `${base}..${first}=2`], "at least two rounds"],
				[
					["--round", `${base}..nope=2`, "--round", `${base}..${second}=2`],
					"git diff failed",
				],
			];
			for (const [args, detail] of cases) {
				const res = run(repo, ...args);
				expect(res.status, args.join(" ")).toBe(2);
				expect(res.stdout).not.toContain("convergence:");
				expect(res.stderr).toMatch(/^convergence: broken: /);
				expect(res.stderr).toContain(detail);
			}
			writeFileSync(join(repo, "src/blob.bin"), Buffer.from([0, 1, 2, 0]));
			const third = commitAll(repo, "binary");
			const res = run(
				repo,
				"--round",
				`${base}..${first}=2`,
				"--round",
				`${base}..${third}=2`,
			);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("size unknown");
		},
		TEST_TIMEOUT,
	);
});

describe("convergence CLI and renames (review round 1)", () => {
	it(
		"counts a moved file as a move, not as a delete plus an add",
		() => {
			const repo = newRepo();
			put(repo, "src/big.mjs", lines(100));
			const base = commitAll(repo, "base");
			put(repo, "src/parse.mjs", lines(10));
			const first = commitAll(repo, "candidate 1");
			git(repo, "mv", "src/big.mjs", "src/big-renamed.mjs");
			const second = commitAll(repo, "candidate 2: rename only");
			const res = run(
				repo,
				"--round",
				`${base}..${first}=2`,
				"--round",
				`${base}..${second}=2`,
			);
			expect(res.stdout.split("\n")[0]).toBe("convergence: keep");
			expect(res.stdout).toContain("reason: lines: 10 -> 10 (+0%)");
		},
		TEST_TIMEOUT,
	);
});

describe("rangeSourceLines paths (review round 2)", () => {
	it(
		"keeps a path that holds a tab whole, so it is still left out as a test file",
		async () => {
			if (process.platform === "win32") return; // Windows paths cannot hold a tab.
			const { rangeSourceLines } = await import("../skills/_shared/lane.mjs");
			const repo = newRepo();
			put(repo, "README.md", "base\n");
			const base = commitAll(repo, "base");
			put(repo, "src/a\tb.test.mjs", lines(50));
			put(repo, "src/x.mjs", lines(4));
			const cand = commitAll(repo, "candidate");
			expect(rangeSourceLines(repo, `${base}..${cand}`).lines).toBe(4);
		},
		TEST_TIMEOUT,
	);
});
