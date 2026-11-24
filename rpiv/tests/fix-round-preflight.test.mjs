// tests/fix-round-preflight.test.mjs — a deep-review fix round has a preflight it can
// pass (rpiv issue draft 20261124-195023-19d0abfc): implement writes the round's contract
// into the owning design's `## Developer Context` as `#### Test Contract: fix<N>`, which
// keeps the design's approval, and slice-preflight reads it with `--slice fix<N>`.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = join(ROOT, "skills/_shared/slice-preflight.mjs");
const APPEND_ONLY = join(ROOT, "skills/_shared/append-only.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-fix-round-"));
	dirs.push(dir);
	return dir;
};
const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const node = (script, cwd, ...args) => {
	const res = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf-8" });
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const APPROVED = `---
title: demo
status: approved
---
# Design

## Slice S1

### Test Contract: S1
- **Behavior B1**: adds two numbers.
  - Test: \`B1: adds two numbers\` -> \`tests/add.test.mjs\`
  - Expected red: none — pin

## Developer Context

- 2026-11-24: the developer approved S1.
`;

const FIX_ENTRY = `- 2026-11-25: fix round fix1 agreed on review \`.rpiv/artifacts/reviews/r1.md\`: Q1.

#### Test Contract: fix1
- **Behavior F1**: rejects a negative input (finding Q1).
  - Test: \`F1: rejects a negative input\` -> \`tests/add.test.mjs\`
  - Expected red: the S1 commit accepts it.
`;

/** A repository with a base, the S1 commit and the fix1 commit; and the design before
    (approved) and after (fix-round contract added) the fix round. */
const fixRound = () => {
	const repo = tempDir();
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "p@example.invalid");
	git(repo, "config", "user.name", "p");
	git(repo, "config", "core.autocrlf", "false");
	put(repo, "README.md", "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	put(repo, "tests/add.test.mjs", 'it("B1: adds two numbers", () => {});\n');
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "S1");
	const s1 = git(repo, "rev-parse", "HEAD");
	put(
		repo,
		"tests/add.test.mjs",
		'it("B1: adds two numbers", () => {});\nit("F1: rejects a negative input", () => {});\n',
	);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "fix1\n\nReview: .rpiv/artifacts/reviews/r1.md");
	const fix = git(repo, "rev-parse", "HEAD");
	const docs = tempDir();
	put(docs, "approved.md", APPROVED);
	put(docs, "design.md", `${APPROVED}${FIX_ENTRY}`);
	return { repo, s1, fix, approved: join(docs, "approved.md"), design: join(docs, "design.md") };
};

describe("deep-review fix round preflight", () => {
	it(
		"runs clean on the fix commit from the fix-round contract in Developer Context",
		() => {
			const r = fixRound();
			const res = node(PREFLIGHT, r.repo, "--artifact", r.design, "--slice", "fix1", "--base", r.s1, "--candidate", r.fix);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.stdout).toMatch(/^preflight: clean$/m);
		},
		TEST_TIMEOUT,
	);

	it(
		"still refuses a fix round whose design has no fix-round contract",
		() => {
			const r = fixRound();
			const res = node(PREFLIGHT, r.repo, "--artifact", r.approved, "--slice", "fix1", "--base", r.s1, "--candidate", r.fix);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("no `### Test Contract: fix1` section");
		},
		TEST_TIMEOUT,
	);

	it(
		"keeps the design's approval when the fix-round contract is added in Developer Context",
		() => {
			const r = fixRound();
			const res = node(APPEND_ONLY, r.repo, r.approved, r.design);
			expect(res.stdout.trim()).toBe("append-only: keep");
			expect(res.status).toBe(0);
		},
		TEST_TIMEOUT,
	);

	it("implement and the candidate workflow say where the fix-round contract goes", () => {
		const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
		const implement = read("skills/implement/SKILL.md");
		expect(implement).toContain(
			"inside the `## Developer Context` entry that records that agreement, as `#### Test Contract: fix<N>`",
		);
		expect(implement).toContain("`--artifact <design> --slice fix<N>`");
		expect(read("skills/_shared/candidate-workflow.md")).toContain(
			"its slice ID is `fix<N>` and its contract is the `#### Test Contract: fix<N>`",
		);
	});
});
