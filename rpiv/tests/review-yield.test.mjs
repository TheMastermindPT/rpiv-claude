// tests/review-yield.test.mjs — contract tests for skills/_shared/review-yield.mjs: per
// reviewer source, the share of triaged findings the developer acted on. Fixture rows
// copy real shapes from rpiv and slopstop review evidence (escaped pipes in code spans,
// blank or question-only resolutions, proposal-only tables, multi-source rows, deep-review
// stores). The CLI runs on temp folders.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/review-yield.mjs");

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-yield-"));
	dirs.push(dir);
	return dir;
};
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const run = (...args) => {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		encoding: "utf-8",
	});
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const PLAN_REVIEW = `## Plan Review (implement › candidate review 1)

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | S1 | hook:765 | blocker | code-quality | \`echo 'git push' \\| sudo su\` gives no opinion | ask | fixed — red-first in B12 |
| coverage | S1 | hook:225 | concern | verification-coverage | ANSI-C quoting untested | pin | dismissed — already asks |
| verifier V1, code, coverage | S1 | hook:300 | blocker | code-quality | dynamic word | ask broken | deferred — carried to S4 |
| CR, SV | S1 | hook:310 | suggestion | codebase-fit | name | rename | |
| coverage | S1 | hook:320 | concern | verification-coverage | x | y | **Pedro:** decide. |
| code | S1 | hook:330 | suggestion | code-quality | z | w | recorded |
`;

const PROPOSAL_ONLY = `| id | source | severity | finding | proposed resolution |
| --- | --- | --- | --- | --- |
| T1 | SV F1 | high | hand-off order changed | Fix: hand off inline |
`;

describe("normalizeSources", () => {
	it("maps the source spellings real review tables use, and keeps finding IDs out", async () => {
		const { normalizeSources } = await import(
			"../skills/_shared/review-yield.mjs"
		);
		expect(normalizeSources("SV 8, 11")).toEqual(["verifier"]);
		expect(normalizeSources("COV B2; CR; SV C-3, M-7")).toEqual([
			"coverage",
			"code",
			"verifier",
		]);
		expect(normalizeSources("slice-s4a")).toEqual(["verifier"]);
		expect(normalizeSources("code, slice W3")).toEqual(["code", "verifier"]);
		expect(normalizeSources("all")).toEqual(["code", "coverage", "verifier"]);
		expect(normalizeSources("consistency")).toEqual(["other"]);
	});
});

describe("review-yield CLI", () => {
	it("counts acted, not-acted, deferred, pending and unknown per source, and yield over triaged rows", () => {
		const dir = tempDir();
		put(dir, "evidence/feat/s1-candidate-review-1.md", PLAN_REVIEW);
		const res = run("--root", dir);
		expect(res.status).toBe(0);
		expect(res.stdout.split("\n")[0]).toBe("review-yield: complete");
		expect(res.stdout).toContain(
			"source | findings | acted | not-acted | deferred | pending | unknown | yield",
		);
		expect(res.stdout).toContain("code | 4 | 1 | 0 | 1 | 1 | 1 | 50%");
		expect(res.stdout).toContain("coverage | 3 | 0 | 1 | 1 | 1 | 0 | 0%");
		expect(res.stdout).toContain("verifier | 2 | 0 | 0 | 1 | 1 | 0 | 0%");
		expect(res.stderr).toBe("");
	});

	it("treats a proposal-only table as pending, never as acted", () => {
		const dir = tempDir();
		put(dir, "evidence/feat/review-round1.md", PROPOSAL_ONLY);
		const res = run("--root", dir);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("verifier | 1 | 0 | 0 | 0 | 1 | 0 | n/a");
	});

	it("reads deep-review stores by lens and leaves withdrawn findings out", () => {
		const dir = tempDir();
		put(
			dir,
			"artifacts/reviews/r.json",
			JSON.stringify({
				schema: 1,
				findings: [
					{ kind: "dr", id: "Q1", lens: "Q", status: "accepted" },
					{ kind: "dr", id: "Q2", lens: "Q", status: "open" },
					{ kind: "dr", id: "S1", lens: "S", status: "rejected" },
					{
						kind: "dr",
						id: "G1",
						lens: "G",
						status: "withdrawn",
						verify: "Falsified",
					},
				],
			}),
		);
		const res = run("--root", dir);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain(
			"deep-review:Q | 2 | 1 | 0 | 0 | 1 | 0 | 100%",
		);
		expect(res.stdout).toContain("deep-review:S | 1 | 0 | 1 | 0 | 0 | 0 | 0%");
		expect(res.stdout).not.toContain("deep-review:G");
	});

	it("reports a partial result, exit 1, when one review file is broken, and still counts the rest", () => {
		const dir = tempDir();
		put(dir, "evidence/feat/s1-candidate-review-1.md", PLAN_REVIEW);
		put(
			dir,
			"evidence/feat/s2-candidate-review-1.md",
			"| source | severity | resolution |\n| --- | --- | --- |\n| code | blocker |\n",
		);
		put(dir, "artifacts/reviews/bad.json", "{ not json");
		const res = run("--root", dir);
		expect(res.status).toBe(1);
		expect(res.stdout.split("\n")[0]).toBe("review-yield: partial");
		expect(res.stderr).toMatch(
			/^review-yield: broken: .*s2-candidate-review-1\.md:3: 2 cells, header has 3/m,
		);
		expect(res.stderr).toMatch(/^review-yield: broken: .*bad\.json: /m);
		expect(res.stdout).toContain("code | 4 |");
	});

	it("says records: none for a root without review files, and is broken on a bad call", () => {
		const empty = tempDir();
		expect(run("--root", empty).stdout.trim()).toBe("records: none");
		const bad = run("--nope");
		expect(bad.status).toBe(2);
		expect(bad.stdout).toBe("");
		expect(bad.stderr).toMatch(/^review-yield: broken: unknown option: --nope/);
		const missing = run("--root", join(empty, "absent"));
		expect(missing.status).toBe(2);
		expect(missing.stderr).toMatch(/^review-yield: broken: /);
	});
});

describe("review-yield edge cases (review round 1)", () => {
	it("reads the deep-review stores when --root is the reviews folder itself, with or without a trailing slash", () => {
		const dir = tempDir();
		put(
			dir,
			"reviews/r.json",
			JSON.stringify({
				schema: 1,
				findings: [{ kind: "dr", id: "Q1", lens: "Q", status: "accepted" }],
			}),
		);
		for (const root of [join(dir, "reviews"), `${join(dir, "reviews")}/`]) {
			const res = run("--root", root);
			expect(res.stdout, root).toContain("deep-review:Q | 1 | 1 |");
		}
	});

	it("skips tables inside fenced code and reads indented tables", () => {
		const dir = tempDir();
		put(
			dir,
			"evidence/f/review-1.md",
			[
				"```markdown",
				"| source | severity | resolution |",
				"| --- | --- | --- |",
				"| code | blocker | fixed |",
				"```",
				"",
				"  | source | severity | resolution |",
				"  | --- | --- | --- |",
				"  | coverage | concern | dismissed — no |",
			].join("\n"),
		);
		const res = run("--root", dir);
		expect(res.stdout).not.toContain("code |");
		expect(res.stdout).toContain("coverage | 1 | 0 | 1 |");
	});
});

describe("review-yield review round 2", () => {
	it("reports an unclosed fence as broken, and skips tables in list-nested fences", () => {
		const dir = tempDir();
		put(
			dir,
			"evidence/f/review-nested.md",
			[
				"1. Example:",
				"",
				"    ```markdown",
				"    | source | severity | resolution |",
				"    | --- | --- | --- |",
				"    | code | blocker | fixed |",
				"    ```",
			].join("\n"),
		);
		put(
			dir,
			"evidence/f/review-open.md",
			"```\n| source | severity | resolution |\n| --- | --- | --- |\n| coverage | concern | fixed |\n",
		);
		const res = run("--root", dir);
		expect(res.status).toBe(1);
		expect(res.stderr).toMatch(/review-open\.md:1: unterminated code fence/);
		expect(res.stdout).not.toContain("code |");
	});

	it("reads a markdown resolution of open as pending", async () => {
		const { classifyResolution } = await import(
			"../skills/_shared/review-yield.mjs"
		);
		expect(classifyResolution("open")).toBe("pending");
	});
});
