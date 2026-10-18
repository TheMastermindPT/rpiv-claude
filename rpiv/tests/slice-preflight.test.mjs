// tests/slice-preflight.test.mjs — contract tests for skills/_shared/slice-preflight.mjs:
// the deterministic checks a committed slice candidate passes before any reviewer runs
// (named test files and titles exist at the candidate, Expected-red revisions resolve,
// evidence logs exist and name the slice's base or candidate). Test-line shapes come
// from real contracts (risk-lanes S1, slopstop u2b-s1). The CLI runs in temp repos.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/slice-preflight.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-preflight-"));
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

const contract = (redSha) => `# Design

\`\`\`markdown
### Test Contract: example-only
- **Behavior X1**: fenced example, never parsed.
  - Test: \`ghost\` -> \`tests/ghost.test.mjs\`
\`\`\`

## Next Slice

### Test Contract: s1-lock

- **Behavior B1**: Any git push asks.
  - Seam: hook process.
  - Test: \`asks before any git push\` -> \`tests/hook.test.mjs\`
  - Oracle: exact output.
  - Expected red: scaffold prints nothing at \`${redSha}\`.
- **Behavior B2**: Re-entrant callers queue.
  - Test: \`queues a non-awaited re-entrant caller behind its holder\` and \`hands the permit through a long queue\` -> \`src/lock.test.ts\`
  - Expected red: none — pin (already holds).
- **Behavior B3**: Placeholder titles keep their placeholder.
  - Test: \`%s verifies hashes\` (each of \`implement\`, \`validate\`) -> \`tests/exec.test.mjs\`; \`second title\` in \`tests/hook.test.mjs\`
  - Expected red (revision 1): fails at ${redSha}.
- **Behavior B4**: The old suite still passes.
  - Test: every existing title in \`src/lock.test.ts\`, run unchanged (B1 adds one; see Q13).
  - Expected red: none — pin
- **TDD-exempt**: the scaffold file - no behavior.

### Success Criteria

- not part of the contract
`;

/** A repo with a base commit and a candidate commit holding the named tests. */
const fixture = ({ titles = true } = {}) => {
	const repo = tempDir();
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "p@example.invalid");
	git(repo, "config", "user.name", "p");
	git(repo, "config", "core.autocrlf", "false");
	put(repo, "README.md", "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	const base = git(repo, "rev-parse", "HEAD");
	put(
		repo,
		"tests/hook.test.mjs",
		titles
			? 'it("asks before any git push", () => {});\nit("second title", () => {});\n'
			: "// empty\n",
	);
	put(
		repo,
		"src/lock.test.ts",
		"it('queues a non-awaited re-entrant caller behind its holder', () => {});\nit(\n\t\"hands the permit through a long queue\",\n\t() => {},\n);\n",
	);
	put(
		repo,
		"tests/exec.test.mjs",
		'it.each(names)("%s verifies hashes", () => {});\n',
	);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "candidate");
	const candidate = git(repo, "rev-parse", "HEAD");
	const outside = tempDir();
	put(outside, "brief.md", contract(base.slice(0, 7)));
	put(outside, "red.log", `red at parent ${base.slice(0, 7)} digest abc\n`);
	put(outside, "unbound.log", "no revision named here\n");
	return { repo, base, candidate, brief: join(outside, "brief.md"), outside };
};

const run = (cwd, ...args) => {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
	});
	return {
		status: res.status,
		stdout: res.stdout,
		stderr: res.stderr,
		lines: res.stdout.trim().split("\n"),
	};
};

describe("parseTestContract", () => {
	it("reads behaviors, titles, pins and red revisions of one slice, ignoring fenced examples", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(contract("abc1234"), "s1-lock");
		expect(parsed.behaviors.map((b) => b.id)).toEqual(["B1", "B2", "B3", "B4"]);
		expect(parsed.behaviors[0].tests).toEqual([
			{ title: "asks before any git push", path: "tests/hook.test.mjs" },
		]);
		expect(parsed.behaviors[0].redAt).toEqual(["abc1234"]);
		expect(parsed.behaviors[1].tests.map((t) => t.title)).toEqual([
			"queues a non-awaited re-entrant caller behind its holder",
			"hands the permit through a long queue",
		]);
		expect(parsed.behaviors[1].pin).toBe(true);
		expect(parsed.behaviors[2].tests).toEqual([
			{ title: "%s verifies hashes", path: "tests/exec.test.mjs" },
			{ title: "second title", path: "tests/hook.test.mjs" },
		]);
		expect(parsed.behaviors[2].redAt).toEqual(["abc1234"]);
		expect(parsed.behaviors[3].tests).toEqual([]);
		expect(parsed.behaviors[3].unchecked).toHaveLength(1);
		expect(parsed.exempt).toHaveLength(1);
	});

	it("throws on a missing or duplicate contract section", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		expect(() => parseTestContract(contract("abc1234"), "nope")).toThrow(
			/no `### Test Contract: nope` section/,
		);
		const twice = `${contract("abc1234")}\n### Test Contract: s1-lock\n- **Behavior B9**: x\n  - Test: \`t\` -> \`p\`\n`;
		expect(() => parseTestContract(twice, "s1-lock")).toThrow(
			/2 `### Test Contract: s1-lock` sections/,
		);
	});
});

describe("slice-preflight CLI", () => {
	it(
		"reports partial, never clean, while a Test line is unchecked, and plans the re-proofs",
		() => {
			const f = fixture();
			const res = run(
				f.repo,
				"--artifact",
				f.brief,
				"--slice",
				"s1-lock",
				"--base",
				f.base,
				"--candidate",
				f.candidate,
				"--evidence",
				join(f.outside, "red.log"),
			);
			expect(res.status).toBe(0);
			expect(res.lines[0]).toBe("preflight: partial");
			expect(res.stdout).toMatch(
				/^unchecked: B4 line \d+: every existing title/m,
			);
			expect(res.stdout).toContain(
				`reprove: --commit ${f.candidate} --base ${f.base.slice(0, 7)} --test tests/hook.test.mjs::asks before any git push`,
			);
			expect(res.stdout).not.toContain(
				"hands the permit through a long queue\n",
			); // a pin is never re-proved
			expect(res.stdout).not.toMatch(/^finding:/m);
			expect(res.stderr).toBe("");
		},
		TEST_TIMEOUT,
	);

	it(
		"exits 1 with one finding per missing title, file, red revision or evidence binding",
		() => {
			const f = fixture({ titles: false });
			const brief = join(f.outside, "bad.md");
			put(
				f.outside,
				"bad.md",
				contract("deadbee").replace(
					"`src/lock.test.ts`\n",
					"`src/missing.test.ts`\n",
				),
			);
			const res = run(
				f.repo,
				"--artifact",
				brief,
				"--slice",
				"s1-lock",
				"--base",
				f.base,
				"--candidate",
				f.candidate,
				"--evidence",
				join(f.outside, "unbound.log"),
				"--evidence",
				join(f.outside, "absent.log"),
			);
			expect(res.status).toBe(1);
			expect(res.lines[0]).toBe("preflight: findings");
			expect(res.stdout).toContain(
				"finding: missing-test-title: B1 tests/hook.test.mjs :: asks before any git push",
			);
			expect(res.stdout).toContain(
				"finding: missing-test-file: B2 src/missing.test.ts",
			);
			expect(res.stdout).toContain(
				"finding: unresolved-red-revision: B1 deadbee",
			);
			expect(res.stdout).toContain(
				`finding: evidence-unbound: ${join(f.outside, "unbound.log")}`,
			);
			expect(res.stdout).toContain(
				`finding: missing-evidence: ${join(f.outside, "absent.log")}`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"is broken, never clean, on a bad call, a missing section or a candidate that is not a commit",
		() => {
			const f = fixture();
			const common = ["--artifact", f.brief, "--base", f.base];
			const cases = [
				[[...common, "--slice", "s1-lock"], "--candidate"],
				[
					[...common, "--slice", "nope", "--candidate", f.candidate],
					"no `### Test Contract: nope` section",
				],
				[
					[...common, "--slice", "s1-lock", "--candidate", "not-a-rev"],
					"does not name a commit",
				],
				[["--bogus"], "unknown option"],
			];
			for (const [args, detail] of cases) {
				const res = run(f.repo, ...args);
				expect(res.status, args.join(" ")).toBe(2);
				expect(res.stdout).not.toMatch(/^preflight:/m);
				expect(res.stderr).toMatch(/^slice-preflight: broken: /);
				expect(res.stderr).toContain(detail);
			}
		},
		TEST_TIMEOUT,
	);
});

describe("parseTestContract edge cases (review round 1)", () => {
	const one = (body) => `### Test Contract: s\n\n${body}\n`;

	it("a TDD-exempt entry closes the behavior before it", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			one(
				"- **Behavior B1**: x\n- **TDD-exempt**: scaffold - no behavior\n  - Test: `t` -> `p.test.mjs`",
			),
			"s",
		);
		expect(parsed.behaviors[0].tests).toEqual([]);
		expect(parsed.behaviors[0].hasTest).toBe(false);
	});

	it("an empty Test line is no Test line", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		expect(
			parseTestContract(one("- **Behavior B1**: x\n  - Test: "), "s")
				.behaviors[0].hasTest,
		).toBe(false);
	});

	it("reads upper-case revisions, parenthesised placeholders, and refuses double-backtick spans", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			one(
				[
					"- **Behavior B1**: x",
					"  - Test: `adds (%s)` -> `t/a.test.mjs`",
					"  - Expected red: fails at `ABCDEF1234`.",
					"- **Behavior B2**: y",
					"  - Test: ``a `b` c`` -> `t/b.test.mjs`",
				].join("\n"),
			),
			"s",
		);
		expect(parsed.behaviors[0].tests).toEqual([
			{ title: "adds (%s)", path: "t/a.test.mjs" },
		]);
		expect(parsed.behaviors[0].redAt).toEqual(["abcdef1234"]);
		expect(parsed.behaviors[1].tests).toEqual([]);
		expect(parsed.behaviors[1].unchecked).toHaveLength(1);
	});

	it("ignores a contract heading inside a longer fence that contains a shorter fence line", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const text =
			"````markdown\n```\n### Test Contract: s\n- **Behavior X9**: example\n````\n\n### Test Contract: s\n\n- **Behavior B1**: real\n  - Test: `t` -> `p.test.mjs`\n";
		expect(parseTestContract(text, "s").behaviors.map((b) => b.id)).toEqual([
			"B1",
		]);
	});
});

describe("slice-preflight CLI edge cases (review round 1)", () => {
	it(
		"finds a partial title, a behavior with no Test line, and evidence naming a foreign revision",
		() => {
			const f = fixture();
			put(
				f.outside,
				"edge.md",
				"### Test Contract: s\n\n- **Behavior B1**: x\n  - Test: `asks before any git` -> `tests/hook.test.mjs`\n- **Behavior B5**: pin only\n  - Expected red: none — pin\n",
			);
			put(f.outside, "foreign.log", "red at 1a2b3c4d digest abc\n");
			const res = run(
				f.repo,
				"--artifact",
				join(f.outside, "edge.md"),
				"--slice",
				"s",
				"--base",
				f.base,
				"--candidate",
				f.candidate,
				"--evidence",
				join(f.outside, "foreign.log"),
			);
			expect(res.status).toBe(1);
			expect(res.stdout).toContain(
				"finding: missing-test-title: B1 tests/hook.test.mjs :: asks before any git",
			);
			expect(res.stdout).toContain("finding: no-test-line: B5");
			expect(res.stdout).toContain(
				`finding: evidence-unbound: ${join(f.outside, "foreign.log")}`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"is broken when the candidate is the base or the contract has no well-formed behavior",
		() => {
			const f = fixture();
			put(
				f.outside,
				"empty.md",
				"### Test Contract: s\n\n- **Behavior B1:** misformatted\n",
			);
			for (const [args, detail] of [
				[
					[
						"--artifact",
						f.brief,
						"--slice",
						"s1-lock",
						"--base",
						f.base,
						"--candidate",
						f.base,
					],
					"--candidate equals --base",
				],
				[
					[
						"--artifact",
						join(f.outside, "empty.md"),
						"--slice",
						"s",
						"--base",
						f.base,
						"--candidate",
						f.candidate,
					],
					"has no Behavior entries",
				],
			]) {
				const res = run(f.repo, ...args);
				expect(res.status, detail).toBe(2);
				expect(res.stdout).not.toMatch(/^preflight:/m);
				expect(res.stderr).toContain(detail);
			}
		},
		TEST_TIMEOUT,
	);
});

describe("slice-preflight in a package folder", () => {
	it(
		"reads contract paths relative to the folder it runs in, like rpiv's own plugin folder",
		() => {
			const repo = tempDir();
			git(repo, "init", "-q", "-b", "main");
			git(repo, "config", "user.email", "p@example.invalid");
			git(repo, "config", "user.name", "p");
			put(repo, "README.md", "base\n");
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "base");
			const base = git(repo, "rev-parse", "HEAD");
			put(
				repo,
				"pkg/tests/hook.test.mjs",
				'it("asks before any git push", () => {});\n',
			);
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "candidate");
			const candidate = git(repo, "rev-parse", "HEAD");
			const outside = tempDir();
			put(
				outside,
				"b.md",
				"### Test Contract: s\n\n- **Behavior B1**: x\n  - Test: `asks before any git push` -> `tests/hook.test.mjs`\n",
			);
			const res = run(
				join(repo, "pkg"),
				"--artifact",
				join(outside, "b.md"),
				"--slice",
				"s",
				"--base",
				base,
				"--candidate",
				candidate,
			);
			expect(res.stdout.split("\n")[0]).toBe("preflight: clean");
			expect(res.status).toBe(0);
		},
		TEST_TIMEOUT,
	);
});

describe("slice-preflight review round 2", () => {
	it("refuses a brief whose code fence never closes, instead of hiding the rest", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const text =
			"```markdown\nexample\n\n### Test Contract: s\n- **Behavior B1**: x\n  - Test: `t` -> `p`\n";
		expect(() => parseTestContract(text, "s")).toThrow(
			/unterminated code fence opened at line 1/,
		);
	});

	it("takes no re-proof revision from an Expected red that says none was observable", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			"### Test Contract: s\n- **Behavior B1**: x\n  - Test: `t` -> `p`\n  - Expected red: none observable — asks at `ffd19f9`.\n",
			"s",
		);
		expect(parsed.behaviors[0].redAt).toEqual([]);
		expect(parsed.behaviors[0].pin).toBe(false);
	});
});
