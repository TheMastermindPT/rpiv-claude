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

	it("reads a Behavior header with a parenthetical or its colon inside the bold", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			one(
				[
					"- **Behavior B1 (X-1):** paren, colon inside",
					"  - Test: `t1` -> `p.test.mjs`",
					"- **Behavior B2:** colon inside",
					"  - Test: `t2` -> `p.test.mjs`",
					"- **Behavior B3 (finding (nested) id)**: paren, colon outside",
					"  - Test: `t3` -> `p.test.mjs`",
				].join("\n"),
			),
			"s",
		);
		expect(parsed.behaviors.map((b) => [b.id, b.tests[0]?.title])).toEqual([
			["B1", "t1"],
			["B2", "t2"],
			["B3", "t3"],
		]);
	});

	it("reads a bare-ID Behavior header and never a bold label without a digit", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			one(
				[
					"- **B1: whole header in bold.**",
					"  - Test: `t1` -> `p.test.mjs`",
					"- **S3-B2:** colon inside",
					"  - Test: `t2` -> `p.test.mjs`",
					"- **B3 (X-1)**: paren, colon outside",
					"  - Test: `t3` -> `p.test.mjs`",
					"- **Note: not a behavior.**",
				].join("\n"),
			),
			"s",
		);
		expect(parsed.behaviors.map((b) => [b.id, b.tests[0]?.title])).toEqual([
			["B1", "t1"],
			["S3-B2", "t2"],
			["B3", "t3"],
		]);
	});

	it("reads a plural Tests line and the nested list under it, never a list under another label", async () => {
		const { parseTestContract } = await import(
			"../skills/_shared/slice-preflight.mjs"
		);
		const parsed = parseTestContract(
			one(
				[
					"- **Behavior B1 (pin):** x",
					"  - Tests:",
					"    - `t1` in `a.test.ts`",
					"    - `t2` -> `b.test.ts`",
					"    - not a test",
					"  - Oracle:",
					"    - `t3` in `c.test.ts`",
					"- **Behavior B2**: y",
					"  - Tests: `t4` -> `d.test.ts`",
				].join("\n"),
			),
			"s",
		);
		expect(
			parsed.behaviors.map((b) => [b.id, b.hasTest, b.tests, b.unchecked]),
		).toEqual([
			[
				"B1",
				true,
				[
					{ title: "t1", path: "a.test.ts" },
					{ title: "t2", path: "b.test.ts" },
				],
				[{ line: 7, text: "not a test" }],
			],
			["B2", true, [{ title: "t4", path: "d.test.ts" }], []],
		]);
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
		"finds a behavior's tests by the ID that starts their titles, only in test files the slice changed",
		() => {
			const repo = tempDir();
			git(repo, "init", "-q", "-b", "main");
			git(repo, "config", "user.email", "p@example.invalid");
			git(repo, "config", "user.name", "p");
			git(repo, "config", "core.autocrlf", "false");
			// Another feature's B8 lives in a file this slice never touches.
			put(repo, "tests/old.test.mjs", 'it("B8: another feature", () => {});\n');
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "base");
			const base = git(repo, "rev-parse", "HEAD");
			put(
				repo,
				"tests/new.test.mjs",
				'it("B7: rejects an item at capacity", () => {});\nit(\'B7: keeps the collection\', () => {});\nit("B70: not B7", () => {});\n',
			);
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "candidate");
			const candidate = git(repo, "rev-parse", "HEAD");
			const outside = tempDir();
			put(
				outside,
				"brief.md",
				"### Test Contract: s\n\n- **Behavior B7**: At capacity, an item is rejected.\n- **Behavior B8**: Another rule.\n",
			);
			const res = run(
				repo,
				"--artifact",
				join(outside, "brief.md"),
				"--slice",
				"s",
				"--base",
				base,
				"--candidate",
				candidate,
			);
			expect(res.status).toBe(1);
			expect(res.lines.filter((l) => l.startsWith("finding:"))).toEqual([
				"finding: no-test-line: B8",
			]);
			expect(res.lines.filter((l) => l.startsWith("reprove:"))).toEqual([
				`reprove: --commit ${candidate} --base ${base} --test tests/new.test.mjs::B7: rejects an item at capacity`,
				`reprove: --commit ${candidate} --base ${base} --test tests/new.test.mjs::B7: keeps the collection`,
			]);
		},
		TEST_TIMEOUT,
	);

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
				"### Test Contract: s\n\n- Behavior B1: misformatted, no bold\n",
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
		"finds a plugin-folder contract path (rpiv's own layout) from any folder it runs in",
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
			const args = [
				"--artifact",
				join(outside, "b.md"),
				"--slice",
				"s",
				"--base",
				base,
				"--candidate",
				candidate,
			];
			const res = run(join(repo, "pkg"), ...args);
			expect(res.stdout.split("\n")[0]).toBe("preflight: clean");
			expect(res.status).toBe(0);
			expect(run(repo, ...args).stdout).toBe(res.stdout);
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

// A slice of several commits (the slice, then a fix commit) whose contract names whole
// files, bare file names and a file a generated mirror repeats, as SlopStop phase 3 and
// rpiv's own opencode/generated tree do.
describe("slice-preflight on whole-file tests and a slice of several commits", () => {
	const commitAll = (repo, message) => {
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", message);
		return git(repo, "rev-parse", "HEAD");
	};
	const layout = () => {
		const repo = tempDir();
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "p@example.invalid");
		git(repo, "config", "user.name", "p");
		git(repo, "config", "core.autocrlf", "false");
		put(repo, "src/x.ts", "export const x = 1;\n");
		put(repo, "apps/h/kept.test.ts", "it('kept', () => {});\n");
		put(repo, "apps/b/twin.test.ts", "it('other twin', () => {});\n");
		const base = commitAll(repo, "base");
		put(repo, "apps/h/new.test.ts", "it('new', () => {});\n");
		put(repo, "apps/q/unique.test.ts", "it('unique', () => {});\n");
		put(repo, "apps/a/twin.test.ts", "it('twin case', () => {});\n");
		put(repo, "apps/a/tie.test.ts", "it('a', () => {});\n");
		put(repo, "apps/b/tie.test.ts", "it('b', () => {});\n");
		put(repo, "rpiv/skills/s.test.mjs", "it('s', () => {});\n");
		put(repo, "rpiv/gen/skills/s.test.mjs", "it('s', () => {});\n");
		commitAll(repo, "slice");
		put(repo, "src/x.ts", "export const x = 2;\n");
		const candidate = commitAll(repo, "fix after review");
		return { repo, base, candidate, outside: tempDir() };
	};
	const brief = (outside, lines) =>
		put(outside, "b.md", `### Test Contract: s\n\n${lines.join("\n")}\n`);
	const preflight = (l, cwd) =>
		run(
			cwd ?? l.repo,
			"--artifact",
			join(l.outside, "b.md"),
			"--slice",
			"s",
			"--base",
			l.base,
			"--candidate",
			l.candidate,
		);

	it(
		"is clean on readable whole-file tests across two commits, the same from any folder, re-proving from the base",
		() => {
			const l = layout();
			brief(l.outside, [
				"- **Behavior B1**: new file",
				"  - Test: `apps/h/new.test.ts` (new), every row.",
				"- **Behavior B2 (pin)**: kept",
				"  - Test: `apps/h/kept.test.ts` `keptHelper`, unchanged.",
				"  - Expected red: none — pin",
				"- **Behavior B3**: bare names",
				"  - Test: `unique.test.ts`; `twin case` in `twin.test.ts`",
				"- **Behavior B4**: mirrored",
				"  - Test: `skills/s.test.mjs`, with the mirror regenerated.",
			]);
			const res = preflight(l);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.lines).toEqual([
				"preflight: clean",
				"diagnostic: test path twin.test.ts resolved to apps/a/twin.test.ts (also matched apps/b/twin.test.ts)",
				"diagnostic: test path skills/s.test.mjs resolved to rpiv/skills/s.test.mjs (also matched rpiv/gen/skills/s.test.mjs)",
				`reprove: --commit ${l.candidate} --base ${l.base}`,
				`reprove: --commit ${l.candidate} --base ${l.base} --test twin.test.ts::twin case`,
				"diagnostic: reprove lines need a runner: append -- <runner> with {junit} and {tests} (no node_modules/vitest/vitest.mjs at the repository root)",
			]);
			for (const folder of ["apps/h", "rpiv/gen"])
				expect(preflight(l, join(l.repo, folder)).stdout).toBe(res.stdout);
		},
		TEST_TIMEOUT,
	);

	it(
		"finds a whole-file test the slice never changed, a tied bare name and a missing file",
		() => {
			const l = layout();
			brief(l.outside, [
				"- **Behavior B1**: claims red on a file it never touched",
				"  - Test: `apps/h/kept.test.ts`, tightened in place.",
				"- **Behavior B2**: tie",
				"  - Test: `tie.test.ts`",
				"- **Behavior B3**: gone",
				"  - Test: `apps/h/gone.test.ts`; `nowhere.test.ts`",
			]);
			const res = preflight(l);
			expect(res.status).toBe(1);
			expect(res.lines.filter((x) => x.startsWith("finding:"))).toEqual([
				"finding: untouched-test-file: B1 apps/h/kept.test.ts",
				"finding: ambiguous-test-path: B2 tie.test.ts (apps/a/tie.test.ts, apps/b/tie.test.ts)",
				"finding: missing-test-file: B3 apps/h/gone.test.ts",
				"finding: missing-test-file: B3 nowhere.test.ts",
			]);
		},
		TEST_TIMEOUT,
	);

	it(
		"is broken when the base is not an ancestor of the candidate",
		() => {
			const l = layout();
			brief(l.outside, [
				"- **Behavior B1**: x",
				"  - Test: `apps/h/new.test.ts`",
			]);
			git(l.repo, "switch", "-q", "-c", "side", l.base);
			put(l.repo, "side.txt", "side\n");
			const side = commitAll(l.repo, "side");
			const res = run(
				l.repo,
				"--artifact",
				join(l.outside, "b.md"),
				"--slice",
				"s",
				"--base",
				side,
				"--candidate",
				l.candidate,
			);
			expect(res.status).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr).toBe(
				`slice-preflight: broken: --base ${side} is not an ancestor of --candidate ${l.candidate}\n`,
			);
		},
		TEST_TIMEOUT,
	);
});

describe("slice-preflight on a slice with only TDD-exempt items", () => {
	it(
		"is clean with a diagnostic and no re-proof plan when every item is TDD-exempt, and still checks the evidence",
		() => {
			const f = fixture();
			put(
				f.outside,
				"docs.md",
				"### Test Contract: S1\n\n- **TDD-exempt**: `CLAUDE.md` and the ledger files - documentation\n  with no executable behavior.\n\n### Success Criteria: S1\n\n1. a check script exits 0.\n",
			);
			const args = [
				"--artifact",
				join(f.outside, "docs.md"),
				"--slice",
				"S1",
				"--base",
				f.base,
				"--candidate",
				f.candidate,
			];
			const clean = run(f.repo, ...args);
			expect(clean.stderr).toBe("");
			expect(clean.status).toBe(0);
			expect(clean.lines).toEqual([
				"preflight: clean",
				"diagnostic: every item of the contract is TDD-exempt: no test to check or re-prove",
			]);
			const unbound = run(
				f.repo,
				...args,
				"--evidence",
				join(f.outside, "unbound.log"),
			);
			expect(unbound.status).toBe(1);
			expect(unbound.lines.slice(0, 2)).toEqual([
				"preflight: findings",
				`finding: evidence-unbound: ${join(f.outside, "unbound.log")}`,
			]);
		},
		TEST_TIMEOUT,
	);
});

describe("slice-preflight on pytest tests (S3-preflight-python)", () => {
	/** A repo whose slice commit adds `files`, on a base holding `baseFiles`. */
	const pyRepo = (baseFiles, files) => {
		const repo = tempDir();
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "p@example.invalid");
		git(repo, "config", "user.name", "p");
		git(repo, "config", "core.autocrlf", "false");
		put(repo, "README.md", "base\n");
		for (const [path, text] of Object.entries(baseFiles)) put(repo, path, text);
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "base");
		const base = git(repo, "rev-parse", "HEAD");
		for (const [path, text] of Object.entries(files)) put(repo, path, text);
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "slice");
		const candidate = git(repo, "rev-parse", "HEAD");
		return { repo, base, candidate, outside: tempDir() };
	};
	const preflightOn = (r, lines) => {
		put(r.outside, "b.md", `### Test Contract: s\n\n${lines.join("\n")}\n`);
		return run(
			r.repo,
			"--artifact",
			join(r.outside, "b.md"),
			"--slice",
			"s",
			"--base",
			r.base,
			"--candidate",
			r.candidate,
		);
	};
	const findings = (res) => res.lines.filter((l) => l.startsWith("finding:"));
	const reproves = (res) => res.lines.filter((l) => l.startsWith("reprove:"));

	it(
		"B32: a titled py test is found by its def or async def, classes and case ids included, never by a string",
		() => {
			const r = pyRepo(
				{},
				{
					"tests/test_found.py": [
						"def test_b1_x():",
						"    pass",
						"",
						"class TestBar:",
						"    async def test_b1_y(self):",
						"        pass",
						"",
						"    def test_b3_m(self):",
						"        pass",
						"",
						"def test_b2_p(n):",
						"    pass",
						"",
					].join("\n"),
					"tests/test_x.py": 'def test_b1_xy():\n    s = "test_b1_x"\n',
					"tests/test_noclass.py": "def test_b3_m():\n    pass\n",
				},
			);
			const res = preflightOn(r, [
				"- **Behavior B1**: plain and async",
				"  - Test: `test_b1_x` in `tests/test_found.py`; `TestBar::test_b1_y` in `tests/test_found.py`",
				"- **Behavior B2**: a case id",
				"  - Test: `test_b2_p[1]` in `tests/test_found.py`",
				"- **Behavior B3**: a class",
				"  - Test: `TestBar::test_b3_m` in `tests/test_found.py`",
				"- **Behavior B7**: only a longer name and a string",
				"  - Test: `test_b1_x` in `tests/test_x.py`",
				"- **Behavior B8**: no such class",
				"  - Test: `TestBar::test_b3_m` in `tests/test_noclass.py`",
			]);
			expect(res.stderr).toBe("");
			expect(findings(res)).toEqual([
				"finding: missing-test-title: B7 tests/test_x.py :: test_b1_x",
				"finding: missing-test-title: B8 tests/test_noclass.py :: TestBar::test_b3_m",
			]);
			const call = `reprove: --commit ${r.candidate} --base ${r.base} --test`;
			expect(reproves(res)).toEqual(
				expect.arrayContaining([
					`${call} tests/test_found.py::test_b1_x`,
					`${call} tests/test_found.py::TestBar::test_b1_y`,
					`${call} tests/test_found.py::test_b2_p[1]`,
					`${call} tests/test_found.py::TestBar::test_b3_m`,
				]),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"B33: with no Test line a behavior finds the py functions named after its ID in changed test files, up to the next underscore",
		() => {
			const r = pyRepo(
				{ "tests/test_old.py": "def test_b6_old():\n    pass\n" },
				{
					"tests/test_cart.py": [
						"def test_b1_rejects():",
						'    assert "B4: x"',
						"",
						"def test_b10_x():",
						"    pass",
						"",
						"def test_B2():",
						"    pass",
						"",
						"class TestS:",
						"    def test_s3_b5_x(self):",
						"        pass",
						"",
					].join("\n"),
				},
			);
			const res = preflightOn(r, [
				"- **Behavior B1**: one",
				"- **Behavior B10**: ten",
				"- **Behavior B2**: two",
				"- **Behavior B4**: only a string",
				"- **Behavior S3-B5**: a hyphenated ID",
				"- **Behavior B6**: an unchanged file",
			]);
			expect(res.stderr).toBe("");
			expect(findings(res)).toEqual([
				"finding: no-test-line: B4",
				"finding: no-test-line: B6",
			]);
			const call = `reprove: --commit ${r.candidate} --base ${r.base} --test`;
			expect(reproves(res)).toEqual([
				`${call} tests/test_cart.py::test_b1_rejects`,
				`${call} tests/test_cart.py::test_b10_x`,
				`${call} tests/test_cart.py::test_B2`,
				`${call} tests/test_cart.py::test_s3_b5_x`,
			]);
		},
		TEST_TIMEOUT,
	);

	// rpiv issue draft 20261123-151137-3491b4f7: a reprove line printed without `--` and
	// a runner was run as printed and broke. Each line now ends in the runner found at
	// the repository root, or a diagnostic says the runner is still missing.
	describe("reprove lines name their runner", () => {
		const PY_TAIL = "-m pytest --junitxml={junit} {tests}";
		const plan = (r, contract) =>
			preflightOn(r, contract).lines.filter(
				(l) => l.startsWith("reprove:") || l.includes("need a runner"),
			);

		it(
			"a py test runs with the root's .venv python and pytest, Scripts first, linking .venv",
			() => {
				const r = pyRepo(
					{},
					{ "tests/test_a.py": "def test_b1_x():\n    pass\n" },
				);
				const contract = [
					"- **Behavior B1**: x",
					"  - Test: `test_b1_x` in `tests/test_a.py`",
				];
				const call = `reprove: --commit ${r.candidate} --base ${r.base} --test tests/test_a.py::test_b1_x`;

				put(r.repo, ".venv/bin/python", "");
				expect(plan(r, contract)).toEqual([
					`${call} --link .venv -- .venv/bin/python ${PY_TAIL}`,
				]);
				put(r.repo, ".venv/Scripts/python.exe", "");
				expect(plan(r, contract)).toEqual([
					`${call} --link .venv -- .venv/Scripts/python.exe ${PY_TAIL}`,
				]);
			},
			TEST_TIMEOUT,
		);

		it(
			"a js test runs with the root's vitest, linking node_modules; with none, the line stops before -- and a diagnostic says why",
			() => {
				const r = pyRepo(
					{},
					{ "tests/a.test.mjs": 'it("B1: x", () => {});\n' },
				);
				const contract = [
					"- **Behavior B1**: x",
					"  - Test: `B1: x` in `tests/a.test.mjs`",
				];
				const call = `reprove: --commit ${r.candidate} --base ${r.base} --test tests/a.test.mjs::B1: x`;

				put(r.repo, ".venv/bin/python", "");
				expect(plan(r, contract)).toEqual([
					call,
					"diagnostic: reprove lines need a runner: append -- <runner> with {junit} and {tests} (no node_modules/vitest/vitest.mjs at the repository root)",
				]);
				put(r.repo, "node_modules/vitest/vitest.mjs", "");
				expect(plan(r, contract)).toEqual([
					`${call} --link node_modules -- node node_modules/vitest/vitest.mjs run --reporter=junit --outputFile={junit} {tests}`,
				]);
			},
			TEST_TIMEOUT,
		);

		it(
			"a whole-file call over py and js tests names no runner and says so",
			() => {
				const r = pyRepo(
					{},
					{
						"tests/test_a.py": "def test_x():\n    pass\n",
						"tests/a.test.mjs": "\n",
					},
				);
				put(r.repo, ".venv/bin/python", "");
				put(r.repo, "node_modules/vitest/vitest.mjs", "");
				expect(
					plan(r, [
						"- **Behavior B1**: x",
						"  - Test: `tests/test_a.py`; `tests/a.test.mjs`",
					]),
				).toEqual([
					`reprove: --commit ${r.candidate} --base ${r.base}`,
					"diagnostic: reprove lines need a runner: append -- <runner> with {junit} and {tests} (tests in Python and another language)",
				]);
			},
			TEST_TIMEOUT,
		);

		// rpiv issue draft 20261124-123428-d6faf9de: a package in a subfolder runs from
		// it, with the runner found there or in a folder above it.
		const JS_TAIL = "run --reporter=junit --outputFile={junit} {tests}";
		const jsPackage = () => {
			const r = pyRepo(
				{},
				{ "web/tests/unit/a.test.mjs": 'it("B1: x", () => {});\n' },
			);
			put(r.repo, "web/package.json", "{}\n");
			return {
				r,
				contract: [
					"- **Behavior B1**: x",
					"  - Test: `B1: x` in `web/tests/unit/a.test.mjs`",
				],
				call: `reprove: --commit ${r.candidate} --base ${r.base} --test web/tests/unit/a.test.mjs::B1: x`,
			};
		};

		it(
			"a js test in a package with its own vitest runs from the package",
			() => {
				const { r, contract, call } = jsPackage();
				put(r.repo, "node_modules/vitest/vitest.mjs", "");
				put(r.repo, "web/node_modules/vitest/vitest.mjs", "");
				expect(plan(r, contract)).toEqual([
					`${call} --in web --link node_modules -- node node_modules/vitest/vitest.mjs ${JS_TAIL}`,
				]);
			},
			TEST_TIMEOUT,
		);

		it(
			"a js test in a package whose vitest is hoisted runs from the package, linking both node_modules",
			() => {
				const { r, contract, call } = jsPackage();
				put(r.repo, "node_modules/vitest/vitest.mjs", "");
				put(r.repo, "web/node_modules/.modules.yaml", "");
				expect(plan(r, contract)).toEqual([
					`${call} --in web --link node_modules --link ../node_modules -- node ../node_modules/vitest/vitest.mjs ${JS_TAIL}`,
				]);
			},
			TEST_TIMEOUT,
		);

		it(
			"a js test in a package with no vitest anywhere says where it looked",
			() => {
				const { r, contract, call } = jsPackage();
				expect(plan(r, contract)).toEqual([
					call,
					"diagnostic: reprove lines need a runner: append -- <runner> with {junit} and {tests} (no node_modules/vitest/vitest.mjs in web or a folder above it)",
				]);
			},
			TEST_TIMEOUT,
		);

		it(
			"a py test in a project in a subfolder runs from it with the root's .venv",
			() => {
				const r = pyRepo(
					{},
					{ "svc/tests/test_a.py": "def test_b1_x():\n    pass\n" },
				);
				put(r.repo, "svc/pyproject.toml", "[project]\nname = 'svc'\n");
				put(r.repo, ".venv/bin/python", "");
				expect(
					plan(r, [
						"- **Behavior B1**: x",
						"  - Test: `test_b1_x` in `svc/tests/test_a.py`",
					]),
				).toEqual([
					`reprove: --commit ${r.candidate} --base ${r.base} --test svc/tests/test_a.py::test_b1_x --in svc --link ../.venv -- ../.venv/bin/python ${PY_TAIL}`,
				]);
			},
			TEST_TIMEOUT,
		);
	});
});

describe("slice-preflight on titles holding another quote style (draft 20261122-185409-54f3bade)", () => {
	it(
		"finds an ID-titled test whose title holds a quote character of another style",
		() => {
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
				"tests/q.test.mjs",
				[
					`it("B1: the run's line is red", () => {});`,
					`it('B2: say "hi" twice', () => {});`,
					'it(`B3: it\'s "both"`, () => {});',
					`it("B4: an escaped \\"quote\\" stays", () => {});`,
					"",
				].join("\n"),
			);
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "slice");
			const candidate = git(repo, "rev-parse", "HEAD");
			const outside = tempDir();
			put(
				outside,
				"b.md",
				"### Test Contract: s\n\n- **Behavior B1**: one\n- **Behavior B2**: two\n- **Behavior B3**: three\n- **Behavior B4**: four\n",
			);
			const res = run(
				repo,
				"--artifact",
				join(outside, "b.md"),
				"--slice",
				"s",
				"--base",
				base,
				"--candidate",
				candidate,
			);
			expect(res.stderr).toBe("");
			expect(res.lines.filter((l) => l.startsWith("finding:"))).toEqual([]);
			const call = `reprove: --commit ${candidate} --base ${base} --test tests/q.test.mjs::`;
			expect(res.lines.filter((l) => l.startsWith("reprove:"))).toEqual([
				`${call}B1: the run's line is red`,
				`${call}B2: say "hi" twice`,
				`${call}B3: it's "both"`,
				`${call}B4: an escaped \\"quote\\" stays`,
			]);
		},
		TEST_TIMEOUT,
	);
});
