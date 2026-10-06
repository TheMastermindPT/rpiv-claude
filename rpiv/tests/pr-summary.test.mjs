// tests/pr-summary.test.mjs — contract tests for the PR summary, slice S25-pr-summary of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md (D25). Seams:
// the helper CLI (skills/_shared/pr-summary.mjs) spawned in fixture repositories, and
// the pr skill, validate and the generated OpenCode tree read as files.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills", "_shared", "pr-summary.mjs");
const READER = join(ROOT, "skills", "_shared", "cycles.mjs");
const BROKEN = "pr-summary: broken: ";
const TEST_TIMEOUT = 60_000;

const TMP = mkdtempSync(join(tmpdir(), "rpiv-s25-")).replaceAll("\\", "/");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let count = 0;
const newRepo = () => initRepo(`${TMP}/r${count++}`);

/** Commits a file change with the full `message` (subject, blank line, body). */
function commit(dir, message) {
	const n = count++;
	writeFileSync(join(dir, `c${n}.txt`), String(n));
	git(dir, "add", `c${n}.txt`);
	const msg = join(TMP, `msg${n}.txt`);
	writeFileSync(msg, message);
	git(dir, "commit", "-q", "-F", msg);
	return git(dir, "rev-parse", "HEAD");
}

const short = (dir, rev) => git(dir, "rev-parse", "--short", rev);
const commonDir = (dir) =>
	git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");

function writeLog(dir, records) {
	const log = resolve(commonDir(dir), "rpiv", "cycles.jsonl");
	mkdirSync(dirname(log), { recursive: true });
	writeFileSync(log, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const stageRec = (branch, time) => ({
	v: 1,
	time,
	branch,
	session: "s",
	event: "stage",
	stage: "implement",
	via: "command",
});

const LANE_FAST = "---\nlane: fast\nlane_reasons: [small, docs]\n---\n\n# D\n";

/** Fixture F of the contract: base B on main, then C1–C4 on feat/x. */
function fixtureF({ log = true, design = LANE_FAST } = {}) {
	const dir = newRepo();
	const base = git(dir, "rev-parse", "HEAD");
	git(dir, "switch", "-q", "-c", "feat/x");
	const c1 = commit(
		dir,
		"feat: one (S1)\n\nIntro text.\n\nContract: design D1,\nB1-B2\n\nRed: seen at B\n\nGreen: B1, B2\n\nCo-Authored-By: x <x@y>\n",
	);
	const c2 = commit(
		dir,
		"feat: two (S2)\n\nTDD: red then green\n\nGates: lint ok\n\nEvidence: e.md\n",
	);
	const c3 = commit(dir, "chore: three\n\nSee Red: inline.\n");
	const c4 = commit(
		dir,
		"fix: review round 1\n\nFix round 1 for .rpiv/artifacts/reviews/r1.md\n",
	);
	writeFileSync(join(dir, "d.md"), design);
	writeFileSync(join(dir, "r1.md"), "---\nmerge_status: clear\n---\n\n# R\n");
	writeFileSync(join(dir, "v.md"), "---\nverdict: pass\n---\n\n# V\n");
	if (log) writeLog(dir, [stageRec("feat/x", "T1")]);
	return { dir, base, c1, c2, c3, c4 };
}

function runHelper(cwd, ...args) {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 30_000,
	});
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

function readerLines(cwd, branch) {
	const res = spawnSync(process.execPath, [READER, "--branch", branch], {
		cwd,
		encoding: "utf-8",
		timeout: 30_000,
	});
	expect(res.status).toBe(0);
	return res.stdout.split(/\r?\n/).filter(Boolean);
}

/** The lines of section `heading` (up to the next blank line). */
function section(stdout, heading) {
	const lines = stdout.split("\n");
	const at = lines.indexOf(heading);
	expect(at, `no ${heading} section`).toBeGreaterThanOrEqual(0);
	const end = lines.indexOf("", at);
	return lines.slice(at + 1, end === -1 ? undefined : end);
}

function okBody(res) {
	expect(res.stderr).toBe("");
	expect(res.status).toBe(0);
	return res.stdout;
}

function expectBroken(res, detail) {
	expect(res.status).toBe(2);
	expect(res.stdout).toBe("");
	expect(res.stderr.startsWith(BROKEN)).toBe(true);
	expect(res.stderr).toContain(detail);
}

const fullArgs = (base) => [
	"--base",
	base,
	"--design",
	"d.md",
	"--review",
	"r1.md",
	"--validation",
	"v.md",
];

describe("S25 PR summary helper", () => {
	it(
		"prints the PR body for a branch",
		() => {
			const f = fixtureF();
			const body = okBody(runHelper(f.dir, ...fullArgs(f.base)));
			const expected = [
				"## Summary",
				"<!-- rpiv:agent summary -->",
				"",
				"## Lane",
				"lane: fast",
				"why: [small, docs]",
				"",
				"## Slices",
				`- ${short(f.dir, f.c1)} feat: one (S1)`,
				"  Contract: design D1,",
				"  B1-B2",
				"  Red: seen at B",
				"  Green: B1, B2",
				`- ${short(f.dir, f.c2)} feat: two (S2)`,
				"  TDD: red then green",
				"  Gates: lint ok",
				"  Evidence: e.md",
				`- ${short(f.dir, f.c3)} chore: three`,
				"  no evidence lines",
				"",
				"## Fix commits",
				"fix rounds: 1",
				`- ${short(f.dir, f.c4)} fix: review round 1 (review: .rpiv/artifacts/reviews/r1.md)`,
				"",
				"## Reviews",
				"- r1.md: merge_status clear",
				"",
				"## Validation",
				"- v.md: verdict pass",
				"",
				"## Cycle metrics",
				...readerLines(f.dir, "feat/x"),
				"",
				"## Open decisions",
				"<!-- rpiv:agent open-decisions -->",
			];
			expect(body).toBe(`${expected.join("\n")}\n`);
			expect(body).not.toContain("Intro text.");
			expect(body).not.toContain("Co-Authored-By");
			expect(body).not.toContain("See Red");
		},
		TEST_TIMEOUT,
	);

	it.each([
		[
			"rigorous with reasons",
			"---\nlane: rigorous\nlane_reasons: [auth path]\n---\n",
			["lane: rigorous", "why: [auth path]"],
		],
		[
			"no lane key",
			"---\ntopic: x\n---\n",
			["lane: normal", "why: no feature lane"],
		],
		[
			"a value that is not a lane",
			"---\nlane: quick\nlane_reasons: [x]\n---\n",
			["lane: normal", "why: broken feature lane: quick"],
		],
		["no frontmatter", "# D\n", ["lane: normal", "why: no feature lane"]],
		[
			"a lane without reasons",
			"---\nlane: normal\n---\n",
			["lane: normal", "why: no lane reasons"],
		],
	])(
		"reads the lane from the design and falls back to normal: %s",
		(_name, design, lane) => {
			const f = fixtureF({ design });
			const body = okBody(runHelper(f.dir, ...fullArgs(f.base)));
			expect(section(body, "## Lane")).toEqual(lane);
		},
		TEST_TIMEOUT,
	);

	it(
		"groups slice and fix commits and picks evidence by label",
		() => {
			// A range without fix commits.
			const plain = newRepo();
			const plainBase = git(plain, "rev-parse", "HEAD");
			commit(plain, "feat: only\n\nRed: r\n");
			writeFileSync(join(plain, "d.md"), LANE_FAST);
			const plainBody = okBody(
				runHelper(plain, "--base", plainBase, "--design", "d.md"),
			);
			expect(section(plainBody, "## Fix commits")).toEqual(["fix rounds: 0"]);
			expect(section(plainBody, "## Reviews")).toEqual(["reviews: none"]);
			expect(section(plainBody, "## Validation")).toEqual(["validation: none"]);

			// Labels, fix commits in log order, a merge commit.
			const dir = newRepo();
			const base = git(dir, "rev-parse", "HEAD");
			git(dir, "switch", "-q", "-c", "feat/x");
			const s1 = commit(
				dir,
				"feat: labels\n\nRedness: x\n\nred: y\n\nGreen: g\n\nEvidence: e\n",
			);
			const fa = commit(
				dir,
				"fix: a\n\nRound 1: .rpiv/artifacts/reviews/a.md\n",
			);
			git(dir, "switch", "-q", "-c", "side", base);
			const side = commit(dir, "feat: side work\n");
			git(dir, "switch", "-q", "feat/x");
			git(dir, "merge", "-q", "--no-ff", "-m", "Merge side into feat", "side");
			const fb = commit(
				dir,
				"fix: b\n\nRound 2: .rpiv/artifacts/reviews/b.md\n",
			);
			writeFileSync(join(dir, "d.md"), LANE_FAST);
			for (const [name, field] of [
				["a.md", "merge_status: blocked"],
				["b.md", "merge_status: clear"],
				["v1.md", "verdict: fail"],
				["v2.md", "verdict: pass"],
			])
				writeFileSync(join(dir, name), `---\n${field}\n---\n`);
			const body = okBody(
				runHelper(
					dir,
					"--base",
					base,
					"--design",
					"d.md",
					"--review",
					"a.md",
					"--review",
					"b.md",
					"--validation",
					"v1.md",
					"--validation",
					"v2.md",
				),
			);
			// The two lines of history may interleave either way (same-second commits).
			const slices = section(body, "## Slices");
			const labels = [
				`- ${short(dir, s1)} feat: labels`,
				"  Green: g",
				"  Evidence: e",
			];
			const sideWork = [
				`- ${short(dir, side)} feat: side work`,
				"  no evidence lines",
			];
			expect([
				[...labels, ...sideWork],
				[...sideWork, ...labels],
			]).toContainEqual(slices);
			expect(section(body, "## Fix commits")).toEqual([
				"fix rounds: 2",
				`- ${short(dir, fa)} fix: a (review: .rpiv/artifacts/reviews/a.md)`,
				`- ${short(dir, fb)} fix: b (review: .rpiv/artifacts/reviews/b.md)`,
			]);
			expect(body).not.toContain("Merge side into feat");
			expect(section(body, "## Reviews")).toEqual([
				"- a.md: merge_status blocked",
				"- b.md: merge_status clear",
			]);
			expect(section(body, "## Validation")).toEqual([
				"- v1.md: verdict fail",
				"- v2.md: verdict pass",
			]);
		},
		TEST_TIMEOUT,
	);

	it(
		"embeds the cycle reader's lines for the branch",
		() => {
			const f = fixtureF({ log: false });
			const args = ["--base", f.base, "--design", "d.md"];
			expect(
				section(okBody(runHelper(f.dir, ...args)), "## Cycle metrics"),
			).toEqual(["cycles: feat/x", "records: none"]);

			writeLog(f.dir, [stageRec("feat/y", "T7")]);
			const other = section(
				okBody(runHelper(f.dir, ...args, "--branch", "feat/y")),
				"## Cycle metrics",
			);
			expect(other).toEqual(readerLines(f.dir, "feat/y"));
			expect(other[0]).toBe("cycles: feat/y");

			git(f.dir, "switch", "-q", "--detach");
			const detached = section(
				okBody(runHelper(f.dir, ...args)),
				"## Cycle metrics",
			);
			expect(detached[0]).toBe("cycles: (detached)");
		},
		TEST_TIMEOUT,
	);

	it(
		"reports broken calls and inputs",
		() => {
			const f = fixtureF();
			const b = f.base;
			writeFileSync(join(f.dir, "r0.md"), "---\nstatus: ready\n---\n");
			writeFileSync(join(f.dir, "v0.md"), "---\nstatus: ready\n---\n");
			const cases = [
				[["--base", b, "--design", "d.md", "--frob"], "--frob"],
				[["--design", "d.md"], "--base"],
				[["--design", "d.md", "--base"], "--base"],
				[["--base", b], "--design"],
				[["--base", "nosuchrev", "--design", "d.md"], "nosuchrev"],
				[["--base", b, "--design", "missing-d.md"], "missing-d.md"],
				[
					["--base", b, "--design", "d.md", "--review", "missing-r.md"],
					"missing-r.md",
				],
				[
					["--base", b, "--design", "d.md", "--review", "r0.md"],
					"merge_status",
				],
				[["--base", b, "--design", "d.md", "--validation", "v0.md"], "verdict"],
				[["--base", "HEAD", "--design", "d.md"], "no commits"],
			];
			for (const [args, detail] of cases)
				expectBroken(runHelper(f.dir, ...args), detail);

			const outside = `${TMP}/outside${count++}`;
			mkdirSync(outside);
			expectBroken(
				runHelper(outside, "--base", b, "--design", "d.md"),
				"not a git repository",
			);

			const g = fixtureF({ log: false });
			writeFileSync(resolve(commonDir(g.dir), "rpiv"), "not a folder");
			const res = runHelper(g.dir, "--base", g.base, "--design", "d.md");
			expectBroken(res, "cycles");
			expect(res.stderr).toContain("log folder is not a folder");
		},
		TEST_TIMEOUT,
	);

	it(
		"reports an unterminated design frontmatter as broken",
		() => {
			const open = fixtureF({ design: "---\nlane: fast\n# D\n" });
			const res = runHelper(open.dir, "--base", open.base, "--design", "d.md");
			expectBroken(res, "d.md");
			expect(res.stderr).toContain("frontmatter");

			const rule = fixtureF({ design: "# D\n---\n" });
			const body = okBody(
				runHelper(rule.dir, "--base", rule.base, "--design", "d.md"),
			);
			expect(section(body, "## Lane")).toEqual([
				"lane: normal",
				"why: no feature lane",
			]);
		},
		TEST_TIMEOUT,
	);
});

describe("S25 pr skill wiring", () => {
	const read = (path) => readFileSync(join(ROOT, path), "utf-8");

	it("wires the pr skill as the chain's last stage", () => {
		expect(existsSync(join(ROOT, "skills/pr/SKILL.md"))).toBe(true);
		const skill = read("skills/pr/SKILL.md");
		expect(skill).toMatch(/^---\r?\nname: pr\r?\n/);
		for (const text of [
			"skills/_shared/pr-summary.mjs",
			"<!-- rpiv:agent summary -->",
			"<!-- rpiv:agent open-decisions -->",
			"rpiv/pr-body.md",
			"ask_user_question",
			"git push -u origin",
			"gh pr create",
			"--body-file",
			"Merging stays with the developer",
		])
			expect(skill).toContain(text);
		expect(skill).toMatch(/verdict[^.]*not `pass`[^.]*stop/i);
		expect(skill).not.toContain("gh pr merge");
		expect(skill).not.toContain("git merge");

		const nextSteps = read("skills/validate/SKILL.md")
			.split(/\r?\n/)
			.filter((line) => line.startsWith("**Next step:**"));
		expect(nextSteps).toHaveLength(1);
		expect(nextSteps[0]).toMatch(/`\/rpiv:pr[ `]/);

		expect(
			existsSync(join(ROOT, "opencode/generated/skills/rpiv-pr/SKILL.md")),
		).toBe(true);
	});

	it("the pr skill checks the validated commit and a clean tree before asking", () => {
		const skill = read("skills/pr/SKILL.md");
		for (const text of [
			"candidate_revision",
			"git rev-parse HEAD",
			"git status --porcelain",
		])
			expect(skill).toContain(text);
		expect(skill).toMatch(
			/candidate_revision[^.]*git rev-parse HEAD[^.]*stop/i,
		);
		expect(skill).toMatch(/git status --porcelain[^.]*stop/i);
	});

	it("the pr skill lets untracked validation artifacts pass the clean-tree check", () => {
		expect(read("skills/pr/SKILL.md")).toMatch(
			/git status --porcelain[^.]*stop[^.]*except untracked[^.]*`\.rpiv\/artifacts\/`/i,
		);
	});

	it("the pr skill resolves the validated commit and reports a missing one", () => {
		const skill = read("skills/pr/SKILL.md");
		expect(skill).toContain("git rev-parse --verify <candidate_revision>^0");
		expect(skill).toContain("not a mismatch");
		expect(skill).toMatch(/no `candidate_revision`[^.]*stop/i);
	});
});
