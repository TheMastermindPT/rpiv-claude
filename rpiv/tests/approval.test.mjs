// approval.mjs — one call per approval step: `check` decides whether a later version
// keeps the approval (no question to the developer) or needs one (with the changed lines
// to show), and `record` validates, stamps and saves the approved copy.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/approval.mjs");

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const BRIEF = `---
date: d
author: a
commit: c
branch: b
repository: r
status: in-progress
---

# Brief

### Test Contract: s1

- **Behavior B1**: At capacity, an item is rejected.
  - Example: capacity 2, [A, B], add C -> failure; [A, B] kept.

## Developer Context

- 2026-11-20: intent agreed.
`;

/** A brief at `<home>/.rpiv/artifacts/designs/brief.md` in a fresh folder. */
const brief = () => {
	const home = mkdtempSync(join(tmpdir(), "rpiv-approval-"));
	dirs.push(home);
	const path = join(home, ".rpiv/artifacts/designs/brief.md");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, BRIEF);
	return { home, path, evidence: join(home, ".rpiv/evidence/brief") };
};

const run = (...args) => {
	const res = spawnSync(process.execPath, [HELPER, ...args], {
		encoding: "utf-8",
	});
	return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

const hashOf = (path) =>
	readFileSync(path, "utf-8").match(/^content_hash: (\w+)$/m)?.[1];

describe("approval.mjs record", () => {
	it("validates, stamps and saves the approved copy named by its content_hash", () => {
		const b = brief();
		const res = run("record", b.path);
		expect(res.status).toBe(0);
		const hash = hashOf(b.path);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		const copy = join(b.evidence, `approved-${hash}.md`);
		expect(existsSync(copy)).toBe(true);
		expect(hashOf(copy)).toBe(hash);
		expect(res.stdout).toContain("approval: recorded");
		expect(res.stdout).toContain(`copy: ${copy}`);
	});

	// A linked worktree keeps its approved copy when its .rpiv/evidence is tracked (the
	// rocket-league-trainer worker, M0-01 S5); a gitignored one would lose it with the
	// worktree, so that copy still goes to the main checkout.
	it("saves a linked worktree's copy in that worktree when evidence is tracked, else in the main checkout", () => {
		const execGit = (cwd, ...args) => {
			const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
			if (res.status !== 0) throw new Error(res.stderr);
		};
		for (const [label, ignore, inLinked] of [
			["tracked", "", true],
			["gitignored", ".rpiv/evidence/\n", false],
		]) {
			const parent = mkdtempSync(join(tmpdir(), "rpiv-approval-wt-"));
			dirs.push(parent);
			const main = join(parent, "main");
			const linked = join(parent, "linked");
			mkdirSync(main);
			execGit(main, "init", "-q", "-b", "main");
			execGit(main, "config", "user.email", "p@example.invalid");
			execGit(main, "config", "user.name", "p");
			writeFileSync(join(main, ".gitignore"), ignore || "# nothing\n");
			execGit(main, "add", "-A");
			execGit(main, "commit", "-q", "-m", "base");
			execGit(main, "worktree", "add", "-q", "-b", "slice", linked);
			const path = join(linked, ".rpiv/artifacts/designs/brief.md");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, BRIEF);

			const res = run("record", path);
			expect.soft(res.status, label).toBe(0);
			const copy = `approved-${hashOf(path)}.md`;
			const home = inLinked ? linked : main;
			const other = inLinked ? main : linked;
			expect
				.soft(existsSync(join(home, ".rpiv/evidence/brief", copy)), label)
				.toBe(true);
			expect
				.soft(existsSync(join(other, ".rpiv/evidence/brief", copy)), label)
				.toBe(false);
			expect.soft(run("check", path).stdout, label).toContain("approval: keep");
		}
	});

	it("records nothing when validation fails", () => {
		const b = brief();
		appendFileSync(b.path, "\nTODO finish this\n");
		const res = run("record", b.path);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("approval: invalid");
		expect(existsSync(b.evidence)).toBe(false);
	});
});

describe("approval.mjs check", () => {
	it("keeps the approval for an append to Developer Context and re-stamps, asking nothing", () => {
		const b = brief();
		run("record", b.path);
		const before = hashOf(b.path);
		appendFileSync(
			b.path,
			"- 2026-11-21: tuned spacing to meet B1's example.\n",
		);
		const res = run("check", b.path);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("approval: keep");
		expect(hashOf(b.path)).not.toBe(before);
		expect(
			readdirSync(b.evidence).filter((name) => name.endsWith(".md")),
		).toHaveLength(1);
	});

	it("asks, showing the changed line, when an approved behavior changes", () => {
		const b = brief();
		run("record", b.path);
		const before = hashOf(b.path);
		const text = readFileSync(b.path, "utf-8").replace(
			"add C -> failure",
			"add C -> accepted",
		);
		writeFileSync(b.path, text);
		const res = run("check", b.path);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("approval: ask");
		expect(res.stdout).toMatch(/change: .*add C -> accepted/);
		expect(hashOf(b.path)).toBe(before);
	});

	it("asks for a first approval when there is no approved copy", () => {
		const b = brief();
		const res = run("check", b.path);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("approval: ask");
		expect(res.stdout).toContain("reason: no approved copy yet");
	});

	it("is broken, never a verdict, for a missing artifact or a bad call", () => {
		expect(run("check", join(tmpdir(), "no-such-brief.md")).status).toBe(2);
		const bad = run("approve");
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain("approval: broken:");
	});
});

// rpiv issue draft 20261123-163840-6e36ac6d: after a merge two approved copies had file
// times 1 ms apart and check governed by the older approval. Git keeps no file times, so
// the order is recorded: a sidecar per copy, else the commit that added the copy.
describe("approval.mjs picks the latest recorded approval, never by file time", () => {
	const git = (cwd, args, env = {}) => {
		const res = spawnSync("git", args, {
			cwd,
			encoding: "utf-8",
			env: { ...process.env, ...env },
		});
		if (res.status !== 0) throw new Error(res.stderr);
		return res.stdout.trim();
	};
	const OLD = new Date("2020-01-01T00:00:00Z");
	const NEW = new Date("2030-01-01T00:00:00Z");

	/** A brief approved twice: copy A, then (after a change beyond the append-only rule)
	    copy B, which the artifact now equals. Copy A's file time is made the newest. */
	const approvedTwice = () => {
		const b = brief();
		run("record", b.path);
		const a = join(b.evidence, `approved-${hashOf(b.path)}.md`);
		writeFileSync(
			b.path,
			readFileSync(b.path, "utf-8").replace(
				"add C -> failure",
				"add C -> refused",
			),
		);
		run("record", b.path);
		const second = join(b.evidence, `approved-${hashOf(b.path)}.md`);
		utimesSync(a, NEW, NEW);
		utimesSync(second, OLD, OLD);
		return { ...b, a, b: second };
	};
	const governing = (res) =>
		/^approved copy: (.*)$/m.exec(res.stdout)?.[1]?.trim();
	const sidecar = (copy) => copy.replace(/\.md$/, ".json");

	it("record writes a sidecar naming the content_hash and when it was recorded", () => {
		const b = brief();
		run("record", b.path);
		const hash = hashOf(b.path);
		const side = JSON.parse(
			readFileSync(join(b.evidence, `approved-${hash}.json`), "utf-8"),
		);
		expect(side.content_hash).toBe(hash);
		expect(Number.isNaN(Date.parse(side.recorded_at))).toBe(false);
	});

	it("governs by the sidecars' recorded_at even when the older copy has the newer file time", () => {
		const t = approvedTwice();
		const res = run("check", t.path);
		expect(res.stdout).toContain("approval: keep");
		expect(governing(res)).toBe(t.b);
	});

	it("governs a copy recorded before sidecars by the commit that added it", () => {
		const t = approvedTwice();
		for (const copy of [t.a, t.b]) rmSync(sidecar(copy));
		git(t.home, ["init", "-q", "-b", "main"]);
		git(t.home, ["config", "user.email", "a@example.invalid"]);
		git(t.home, ["config", "user.name", "a"]);
		const commitAt = (path, date) => {
			git(t.home, ["add", path]);
			git(t.home, ["commit", "-q", "-m", path], {
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date,
			});
		};
		commitAt(t.a, "2026-01-01T00:00:00Z");
		commitAt(t.b, "2026-01-02T00:00:00Z");
		utimesSync(t.a, NEW, NEW);
		const res = run("check", t.path);
		expect(res.stdout).toContain("approval: keep");
		expect(governing(res)).toBe(t.b);
	});

	it("asks, naming both, when two different copies are equally the latest", () => {
		const t = approvedTwice();
		const at = { recorded_at: "2026-11-23T12:00:00.000Z" };
		for (const copy of [t.a, t.b])
			writeFileSync(sidecar(copy), JSON.stringify(at));
		const res = run("check", t.path);
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("approval: ask");
		expect(res.stdout).toContain(
			"reason: cannot tell which approved copy is the latest:",
		);
		expect(res.stdout).toContain(t.a);
		expect(res.stdout).toContain(t.b);
	});

	it("is broken, never a verdict, when a sidecar cannot be read", () => {
		const t = approvedTwice();
		writeFileSync(sidecar(t.b), "{ not json");
		const res = run("check", t.path);
		expect(res.status).toBe(2);
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain(
			"approval: broken: unreadable approval sidecar:",
		);
	});
});
