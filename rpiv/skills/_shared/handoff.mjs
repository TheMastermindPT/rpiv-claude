// handoff.mjs — the chain handoff writer (S17-chain-handoff, D37). A pipeline skill
// that ends its stage runs it so the next session, started fresh after `/clear`,
// sees the pending step: .claude/hooks/chain-handoff-restore.mjs reads the file once.
//
// CLI: `node handoff.mjs write --next "<command>" [--artifact <path>] [--slice <id>]
// [--lane <lane>] [--decision "<text>"]...` writes `<git-dir>/rpiv/handoff.json` of
// the worktree it runs in (per worktree, never committed), replacing any earlier
// one, and prints `handoff: written <path>`. A bad call prints
// `handoff: broken: <detail>` on stderr and exits 2, writing nothing.
//
// Importable: runCli.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { LANES } from "./lane.mjs";
import { contentHashOf } from "./validate-artifact.mjs";

const HEADS = "refs/heads/";

/** git's trimmed stdout in `cwd` when its exit status is one of `ok` (0 by
    default) — `{ status, out }`; anything else throws a broken detail. */
function git(cwd, args, ok = [0]) {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, LC_ALL: "C" },
		windowsHide: true,
	});
	if (res.error) throw new Error(`git could not run (${res.error.message})`);
	if (!ok.includes(res.status))
		throw new Error(`git ${args[0]} failed: ${(res.stderr ?? "").trim().split("\n")[0]}`);
	return { status: res.status, out: (res.stdout ?? "").trim() };
}

const gitOut = (cwd, args) => git(cwd, args).out;

const REPEATED = new Set(["--decision"]);
const SINGLE = new Set(["--next", "--artifact", "--slice", "--lane"]);

/** `{ next, artifact, slice, lane, decisions }` from the `write` arguments; a
    bad call throws, so nothing is written. */
function parseArgs(argv) {
	if (argv[0] !== "write") throw new Error(`usage: handoff.mjs write --next "<command>" …`);
	const opts = { decisions: [] };
	for (let i = 1; i < argv.length; i += 2) readOption(argv[i], argv[i + 1], opts);
	checkOptions(opts);
	return opts;
}

/** Reads one `name value` pair into `opts`; an unknown name or a missing value throws. */
function readOption(name, value, opts) {
	const known = REPEATED.has(name) || SINGLE.has(name);
	if (!known) throw new Error(`unknown option: ${name}`);
	if (value === undefined) throw new Error(`${name} needs a value`);
	if (REPEATED.has(name)) opts.decisions.push(value);
	else opts[name.slice(2)] = value;
}

/** Throws unless the options make a handoff worth writing. */
function checkOptions(opts) {
	if (!opts.next) throw new Error("--next needs a command");
	if (opts.lane !== undefined && !LANES.includes(opts.lane))
		throw new Error("lane must be fast, normal or rigorous");
}

/** HEAD's symbolic ref, or "" when HEAD is detached (git's quiet exit 1); any
    other failure throws (S17 revision 1). */
function headRef(cwd) {
	const { status, out } = git(cwd, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
	return status === 1 ? "" : out;
}

/** The handoff record for `opts`, written from `cwd`'s worktree. */
function record(opts, cwd) {
	const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
	const ref = headRef(cwd);
	let artifact = null;
	if (opts.artifact !== undefined) {
		const full = resolve(cwd, opts.artifact);
		artifact = {
			path: relative(top, full).replaceAll("\\", "/"),
			content_hash: contentHashOf(readFileSync(full, "utf-8")),
		};
	}
	return {
		v: 1,
		time: new Date().toISOString(),
		next: opts.next,
		artifact,
		slice: opts.slice ?? null,
		lane: opts.lane ?? null,
		branch: ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null,
		decisions: opts.decisions,
	};
}

/** The writer's stdout for `argv` run in `cwd`; throws a broken detail. */
export function runCli(argv, cwd) {
	const opts = parseArgs(argv);
	const rec = record(opts, cwd);
	const path = `${gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"])}/rpiv/handoff.json`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
	return `handoff: written ${path}\n`;
}

if (isMain(import.meta.url)) {
	try {
		process.stdout.write(runCli(process.argv.slice(2), process.cwd()));
	} catch (err) {
		process.stderr.write(`handoff: broken: ${err?.message ?? err}\n`);
		process.exitCode = 2;
	}
}
