// tests/helpers/git-fixtures.mjs — throwaway git repositories for the approved-branch
// contract (S2-approved-branch, D14). Paths use `/` so they can be written into
// command strings as literals.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd, ...args) {
	const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (res.status !== 0)
		throw new Error(`git ${args.join(" ")} in ${cwd}: ${res.stderr}`);
	return res.stdout.trim();
}

/** A new repository at `dir` on `main`, with one commit unless `unborn`. */
export function initRepo(dir, { unborn = false } = {}) {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "fixture@example.invalid");
	git(dir, "config", "user.name", "fixture");
	if (!unborn) {
		writeFileSync(join(dir, "f.txt"), "x");
		git(dir, "add", "f.txt");
		git(dir, "commit", "-q", "-m", "init");
	}
	return dir;
}

/** The marker key for `branch`, or "" when unset. */
export function approvalOf(dir, branch) {
	const res = spawnSync(
		"git",
		["config", "--get", `branch.${branch}.rpivApproved`],
		{ cwd: dir, encoding: "utf-8" },
	);
	return res.stdout.trim();
}

/** A temp root with the D14 fixtures: main, ok (approved, with sub/), x, y
    (marker false), det, unborn, plain (no repository) and missing (absent);
    S2 revision 1 adds tagged (approved branch with a same-named tag), yes
    (marker `yes`), cdp/sub (a CDPATH target) and d0…d8. */
export function makeFixtures() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-s2-")).replaceAll("\\", "/");
	const repo = (name, setup, options) => {
		const dir = initRepo(`${root}/${name}`, options);
		setup?.(dir);
		return dir;
	};
	const onBranch = (branch, marker) => (dir) => {
		git(dir, "switch", "-q", "-c", branch);
		if (marker !== undefined)
			git(dir, "config", `branch.${branch}.rpivApproved`, marker);
	};
	const fixtures = {
		root,
		main: repo("main"),
		ok: repo("ok", (dir) => {
			onBranch("feat/ok", "true")(dir);
			mkdirSync(`${dir}/sub`);
		}),
		x: repo("x", onBranch("feat/x")),
		y: repo("y", onBranch("feat/y", "false")),
		det: repo("det", (dir) => git(dir, "checkout", "-q", "--detach")),
		unborn: repo("unborn", undefined, { unborn: true }),
		tagged: repo("tagged", (dir) => {
			onBranch("feat/t", "true")(dir);
			git(dir, "tag", "feat/t");
		}),
		yes: repo("yes", onBranch("feat/yes", "yes")),
		cdpSub: repo("cdp/sub"),
		nine: Array.from({ length: 9 }, (_, k) => repo(`d${k}`)),
		plain: `${root}/plain`,
		missing: `${root}/missing`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
	mkdirSync(fixtures.plain);
	return fixtures;
}
