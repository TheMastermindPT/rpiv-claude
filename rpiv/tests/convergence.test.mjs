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

describe("convergence CLI and the tool's own folder (odin#16)", () => {
	/** base, a candidate with a 100-line code change, then the same candidate
	    amended to also commit a 2000-line saved patch under `.rpiv/evidence/`,
	    with the code grown to `secondLines`. */
	const evidenceRounds = (secondLines) => {
		const repo = newRepo();
		put(repo, "README.md", "base\n");
		const base = commitAll(repo, "base");
		put(repo, "src/parse.mjs", lines(100));
		const first = commitAll(repo, "candidate A");
		put(repo, "src/parse.mjs", lines(secondLines));
		put(repo, ".rpiv/evidence/round-1.patch", lines(2000));
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "--amend", "-m", "candidate A2");
		const second = git(repo, "rev-parse", "HEAD");
		return { repo, base, first, second };
	};

	// 0 -> 0 is the issue's repro; 2 -> 2 keeps the blockers stuck, so only the
	// tool-folder exclusion can turn the verdict into keep.
	it.each([0, 2])(
		"keeps when only committed evidence grew (%i blockers in both rounds)",
		(blockers) => {
			const { repo, base, first, second } = evidenceRounds(100);
			const res = run(
				repo,
				"--round",
				`${base}..${first}=${blockers}`,
				"--round",
				`${base}..${second}=${blockers}`,
			);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.stdout.split("\n")[0]).toBe("convergence: keep");
			expect(res.stdout).toContain("reason: lines: 100 -> 100 (+0%)");
			expect(res.stdout).toContain(
				"reason: tool-folder lines not counted: 0 -> 2000",
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"still reopens on real code growth beside committed evidence",
		() => {
			const { repo, base, first, second } = evidenceRounds(200);
			const res = run(
				repo,
				"--round",
				`${base}..${first}=2`,
				"--round",
				`${base}..${second}=2`,
			);
			expect(res.status).toBe(1);
			expect(res.stdout.split("\n")[0]).toBe("convergence: reopen");
			expect(res.stdout).toContain("reason: lines: 100 -> 200 (+100%)");
			expect(res.stdout).toContain(
				"reason: tool-folder lines not counted: 0 -> 2000",
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps, never divides by zero, when both rounds measure no slice source",
		() => {
			const repo = newRepo();
			put(repo, "README.md", "base\n");
			const base = commitAll(repo, "base");
			put(repo, ".rpiv/evidence/a.log", lines(10));
			const first = commitAll(repo, "evidence only");
			put(repo, ".rpiv/evidence/b.log", lines(500));
			const second = commitAll(repo, "more evidence");
			const res = run(
				repo,
				"--round",
				`${base}..${first}=1`,
				"--round",
				`${base}..${second}=1`,
			);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.stdout.split("\n")[0]).toBe("convergence: keep");
			expect(res.stdout).toContain(
				"reason: lines: 0 -> 0 (no counted slice source; growth not measured)",
			);
			expect(res.stdout).toContain(
				"reason: tool-folder lines not counted: 10 -> 510",
			);
		},
		TEST_TIMEOUT,
	);
});

describe("convergence rule and zero blockers (odin#16)", () => {
	const decide = async (blockers) => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		return convergence([
			{ lines: 100, blockers: blockers[0] },
			{ lines: 200, blockers: blockers[1] },
		]).decision;
	};

	it("does not read 0 -> 0 blockers as stuck, even when the source doubled", async () => {
		expect(await decide([0, 0])).toBe("keep");
	});

	it("still reads 0 -> 1, 2 -> 2 and 2 -> 3 blockers as stuck", async () => {
		expect(await decide([0, 1])).toBe("reopen");
		expect(await decide([2, 2])).toBe("reopen");
		expect(await decide([2, 3])).toBe("reopen");
		expect(await decide([2, 1])).toBe("keep");
	});
});

describe("convergence rule with no slice source in either round (odin#16)", () => {
	it("keeps 0 -> 0 as not measured, and still refuses 0 -> more", async () => {
		const { convergence } = await import("../skills/_shared/convergence.mjs");
		const result = convergence([
			{ lines: 0, blockers: 2 },
			{ lines: 0, blockers: 2 },
		]);
		expect(result.decision).toBe("keep");
		expect(result.reasons).toContain(
			"lines: 0 -> 0 (no counted slice source; growth not measured)",
		);
		expect(result.reasons.join(" ")).not.toMatch(/NaN|Infinity/);
		expect(() =>
			convergence([
				{ lines: 0, blockers: 2 },
				{ lines: 5, blockers: 2 },
			]),
		).toThrow(/no slice source/);
	});
});
