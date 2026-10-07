// tests/merge-cleanup.test.mjs — contract tests for the post-merge cleanup planner
// skills/_shared/merge-cleanup.mjs (slice S26-merge-cleanup, D36, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// gh is replaced by a stub script through RPIV_GH_SCRIPT; `origin` is a local
// bare repository. No network.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills", "_shared", "merge-cleanup.mjs");
const TEST_TIMEOUT = 60_000;

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-s26-"))).replaceAll("\\", "/");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// The gh stand-in: answers from STUB_OUT / STUB_ERR / STUB_CODE and records its
// argv (one JSON line per call) in STUB_LOG.
const STUB = `${TMP}/gh-stub.mjs`;
writeFileSync(
	STUB,
	[
		'import { appendFileSync } from "node:fs";',
		"appendFileSync(process.env.STUB_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
		'process.stdout.write(process.env.STUB_OUT ?? "");',
		'process.stderr.write(process.env.STUB_ERR ?? "");',
		'process.exitCode = Number(process.env.STUB_CODE ?? "0");',
	].join("\n"),
);

let count = 0;
const fresh = (name) => `${TMP}/${name}${count++}`;

/** Lines for a cycle log: `{ v, branch, event }` records. */
const record = (branch) => JSON.stringify({ v: 1, branch, event: "stage" });

/** A repository on main with `feat/x` committed and pushed to a bare `origin`,
    a linked worktree for it (unless `worktree: false`), and a cycle log holding
    two `feat/x` lines and one `main` line. */
function fixture({ worktree = true, push = true } = {}) {
	const origin = fresh("origin");
	mkdirSync(origin);
	git(origin, "init", "-q", "--bare", "-b", "main");
	const repo = initRepo(fresh("repo"));
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	git(repo, "branch", "feat/x");
	if (push) git(repo, "push", "-q", "origin", "feat/x");
	const wt = fresh("wt");
	if (worktree) git(repo, "worktree", "add", "-q", wt, "feat/x");
	const log = `${repo}/.git/rpiv/cycles.jsonl`;
	mkdirSync(dirname(log), { recursive: true });
	writeFileSync(log, `${[record("feat/x"), record("main"), record("feat/x")].join("\n")}\n`);
	return { repo, origin, wt, log };
}

/** Runs the planner in `cwd` with the gh stub answering `stub` (`stub.env` adds
    environment variables). */
function plan(cwd, args, stub = {}) {
	const stubLog = fresh("calls");
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 30_000,
		env: {
			...process.env,
			RPIV_GH_SCRIPT: STUB,
			STUB_LOG: stubLog,
			STUB_OUT: stub.out ?? "",
			STUB_ERR: stub.err ?? "",
			STUB_CODE: String(stub.code ?? 0),
			...stub.env,
		},
	});
	const calls = existsSync(stubLog)
		? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
		: [];
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", calls };
}

const MERGED = JSON.stringify({ state: "MERGED", mergedAt: "2026-10-07T10:00:00Z" });
/** The MERGED answer whose pull request head is `head` (default: the local feat/x tip). */
const merged = (repo, head = git(repo, "rev-parse", "feat/x")) =>
	JSON.stringify({ state: "MERGED", mergedAt: "2026-10-07T10:00:00Z", headRefOid: head });
const lines = (...l) => `${l.join("\n")}\n`;

describe("merge-cleanup planner (S26)", () => {
	it(
		"a merged branch gets an ordered cleanup plan",
		() => {
			const { repo, wt, log } = fixture();
			const before = readFileSync(log, "utf8");
			const res = plan(repo, ["--branch", "feat/x"], { out: merged(repo) });
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.stdout).toBe(
				lines(
					"merge-cleanup: feat/x",
					"merged: yes (2026-10-07T10:00:00Z)",
					`command: git worktree remove ${wt}`,
					"command: git branch -D feat/x",
					"command: git push origin --delete feat/x",
					"archive: 2 cycle line(s)",
				),
			);
			expect(res.calls).toEqual([["pr", "view", "feat/x", "--json", "state,mergedAt,headRefOid"]]);
			// Nothing was deleted.
			expect(existsSync(wt)).toBe(true);
			expect(git(repo, "branch", "--list", "feat/x")).toContain("feat/x");
			expect(git(repo, "ls-remote", "--heads", "origin", "refs/heads/feat/x")).toContain("feat/x");
			expect(readFileSync(log, "utf8")).toBe(before);

			// Inside the branch's own worktree the removal is blocked, not listed.
			expect(plan(wt, ["--branch", "feat/x"], { out: merged(repo) }).stdout).toBe(
				lines(
					"merge-cleanup: feat/x",
					"merged: yes (2026-10-07T10:00:00Z)",
					"blocked: the branch's worktree is the current directory",
					"command: git branch -D feat/x",
					"command: git push origin --delete feat/x",
					"archive: 2 cycle line(s)",
				),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"a merged branch's plan lists only what exists",
		() => {
			const bare = fixture({ worktree: false, push: false });
			expect(plan(bare.repo, ["--branch", "feat/x"], { out: merged(bare.repo) }).stdout).toBe(
				lines(
					"merge-cleanup: feat/x",
					"merged: yes (2026-10-07T10:00:00Z)",
					"command: git branch -D feat/x",
					"archive: 2 cycle line(s)",
				),
			);

			// The branch's own remote, when configured, is the one named.
			const up = fixture({ worktree: false, push: false });
			const second = fresh("up");
			mkdirSync(second);
			git(second, "init", "-q", "--bare", "-b", "main");
			git(up.repo, "remote", "add", "up", second);
			git(up.repo, "push", "-q", "up", "feat/x");
			git(up.repo, "config", "branch.feat/x.remote", "up");
			expect(plan(up.repo, ["--branch", "feat/x"], { out: merged(up.repo) }).stdout).toBe(
				lines(
					"merge-cleanup: feat/x",
					"merged: yes (2026-10-07T10:00:00Z)",
					"command: git branch -D feat/x",
					"command: git push up --delete feat/x",
					"archive: 2 cycle line(s)",
				),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"an unmerged or undecidable branch gets no plan",
		() => {
			const { repo } = fixture({ worktree: false });
			const noPlan = (stub, merged) =>
				expect(plan(repo, ["--branch", "feat/x"], stub)).toMatchObject({
					status: 0,
					stderr: "",
					stdout: lines("merge-cleanup: feat/x", `merged: no (${merged})`),
				});
			noPlan({ out: JSON.stringify({ state: "OPEN", mergedAt: null }) }, "OPEN");
			noPlan({ out: JSON.stringify({ state: "CLOSED", mergedAt: null }) }, "CLOSED");
			noPlan({ err: 'no pull requests found for branch "feat/x"\n', code: 1 }, "no pull request");

			const broken = (args, stub, cwd = repo) => {
				const res = plan(cwd, args, stub);
				expect.soft(res.status, JSON.stringify(stub)).toBe(2);
				expect.soft(res.stdout, JSON.stringify(stub)).toBe("");
				return res.stderr;
			};
			expect(broken(["--branch", "feat/x"], { err: "HTTP 401: Bad credentials\n", code: 1 })).toBe(
				"merge-cleanup: broken: gh pr view failed: HTTP 401: Bad credentials\n",
			);
			expect(broken(["--branch", "feat/x"], { out: "{oops" })).toMatch(
				/^merge-cleanup: broken: gh pr view returned invalid JSON/,
			);
			expect(broken(["--branch", "feat/x"], { out: JSON.stringify({ state: "DRAFT" }) })).toBe(
				"merge-cleanup: broken: unknown pull request state DRAFT\n",
			);
			expect(broken([], { out: JSON.stringify({ state: "OPEN" }) })).toMatch(
				/^merge-cleanup: broken: --branch/,
			);
			const outside = fresh("outside");
			mkdirSync(outside);
			expect(
				spawnSync(process.execPath, [HELPER, "--branch", "feat/x"], {
					cwd: outside,
					encoding: "utf-8",
					env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP, RPIV_GH_SCRIPT: STUB, STUB_LOG: fresh("calls"), STUB_OUT: MERGED },
				}).status,
			).toBe(2);
		},
		TEST_TIMEOUT,
	);

	it(
		"outside a repository the planner is broken and asks no one",
		() => {
			const outside = fresh("outside");
			mkdirSync(outside);
			const res = plan(outside, ["--branch", "feat/x"], {
				out: JSON.stringify({ state: "OPEN" }),
				env: { GIT_CEILING_DIRECTORIES: TMP },
			});
			expect(res.status).toBe(2);
			expect(res.stdout).toBe("");
			expect(res.stderr).toMatch(/^merge-cleanup: broken: not a git repository/);
			expect(res.calls).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it(
		"a failing git read is broken, never a shorter plan",
		() => {
			// (No `git config --get` failure is reachable on its own: git 2.53 returns
			// the last value of a doubled key with exit 0 — S26 revision 1 deviation.)

			// A URL remote (a path, not a remote name) is used as written.
			const url = fixture({ worktree: false, push: false });
			const bare = fresh("url");
			mkdirSync(bare);
			git(bare, "init", "-q", "--bare", "-b", "main");
			git(url.repo, "push", "-q", bare, "feat/x");
			git(url.repo, "config", "branch.feat/x.remote", bare);
			expect.soft(plan(url.repo, ["--branch", "feat/x"], { out: merged(url.repo) }).stdout).toContain(
				`command: git push ${bare} --delete feat/x\n`,
			);

			// A configured remote that cannot be read is broken.
			git(url.repo, "config", "branch.feat/x.remote", `${TMP}/missing-remote`);
			const gone = plan(url.repo, ["--branch", "feat/x"], { out: merged(url.repo) });
			expect.soft(gone.status).toBe(2);
			expect.soft(gone.stderr).toMatch(/^merge-cleanup: broken: git ls-remote failed/);

			// No remote at all and none configured: simply no push line.
			const lone = initRepo(fresh("lone"));
			git(lone, "branch", "feat/x");
			const alone = plan(lone, ["--branch", "feat/x"], { out: merged(lone) });
			expect.soft(alone.status).toBe(0);
			expect.soft(alone.stdout).not.toContain("git push");
		},
		TEST_TIMEOUT,
	);

	it(
		"paths in commands are quoted when needed",
		() => {
			const { repo } = fixture({ worktree: false });
			const spaced = fresh("wt with space");
			git(repo, "worktree", "add", "-q", spaced, "feat/x");
			expect(plan(repo, ["--branch", "feat/x"], { out: merged(repo) }).stdout).toContain(
				`command: git worktree remove "${spaced}"\n`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"the remote delete waits for remote commits that are not in the pull request",
		() => {
			const { repo, origin } = fixture({ worktree: false });
			const head = git(repo, "rev-parse", "feat/x");
			expect(plan(repo, ["--branch", "feat/x"], { out: merged(repo, head) }).stdout).toContain(
				"command: git push origin --delete feat/x\n",
			);

			// A commit pushed to origin/feat/x after the pull request's head.
			git(repo, "switch", "-q", "feat/x");
			writeFileSync(join(repo, "after.txt"), "after");
			git(repo, "add", "after.txt");
			git(repo, "commit", "-q", "-m", "after");
			git(repo, "push", "-q", "origin", "feat/x");
			git(repo, "switch", "-q", "main");
			git(repo, "branch", "-f", "feat/x", head);
			const ahead = plan(repo, ["--branch", "feat/x"], { out: merged(repo, head) });
			expect(ahead.status).toBe(0);
			expect(ahead.stdout).not.toContain("git push");
			expect(ahead.stdout).toContain("blocked: origin/feat/x has commits that are not in its pull request\n");
			expect(ahead.stdout).toContain("command: git branch -D feat/x\n");

			// A remote tip this repository never fetched.
			const other = fresh("other");
			git(TMP, "clone", "-q", origin, other);
			git(other, "config", "user.email", "o@example.invalid");
			git(other, "config", "user.name", "o");
			git(other, "switch", "-q", "feat/x");
			writeFileSync(join(other, "elsewhere.txt"), "elsewhere");
			git(other, "add", "elsewhere.txt");
			git(other, "commit", "-q", "-m", "elsewhere");
			git(other, "push", "-q", "origin", "feat/x");
			const tip = git(other, "rev-parse", "HEAD");
			const unseen = plan(repo, ["--branch", "feat/x"], { out: merged(repo, head) });
			expect(unseen.stdout).not.toContain("git push");
			expect(unseen.stdout).toContain(
				`blocked: the remote tip ${tip} of feat/x is not in this repository; fetch it first\n`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"the branch delete waits for local commits that are not in the pull request",
		() => {
			const { repo } = fixture({ worktree: false });
			const parent = git(repo, "rev-parse", "feat/x");
			const atTip = plan(repo, ["--branch", "feat/x"], { out: merged(repo) });
			expect(atTip.calls).toEqual([["pr", "view", "feat/x", "--json", "state,mergedAt,headRefOid"]]);
			expect(atTip.stdout).toContain("command: git branch -D feat/x\n");

			// A local commit after the pull request's head would be lost.
			git(repo, "switch", "-q", "feat/x");
			writeFileSync(join(repo, "later.txt"), "later");
			git(repo, "add", "later.txt");
			git(repo, "commit", "-q", "-m", "later");
			git(repo, "switch", "-q", "main");
			const ahead = plan(repo, ["--branch", "feat/x"], { out: merged(repo, parent) });
			expect(ahead.status).toBe(0);
			expect(ahead.stdout).not.toContain("git branch -D");
			expect(ahead.stdout).toContain("blocked: feat/x has commits that are not in its pull request\n");

			// A head this repository does not hold cannot be checked.
			const unknown = "0123456789abcdef0123456789abcdef01234567";
			const missing = plan(repo, ["--branch", "feat/x"], { out: merged(repo, unknown) });
			expect(missing.stdout).not.toContain("git branch -D");
			expect(missing.stdout).toContain(
				`blocked: the pull request head ${unknown} is not in this repository; fetch it first\n`,
			);
		},
		TEST_TIMEOUT,
	);
});
