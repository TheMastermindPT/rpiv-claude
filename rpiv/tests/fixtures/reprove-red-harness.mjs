// tests/fixtures/reprove-red-harness.mjs — shared helpers for the reprove-red CLI tests
// of S2-scratch-copy (.rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md).
// Throwaway git repositories live under the OS temp folder; `cleanup()` removes them.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const HELPER = join(ROOT, "skills/_shared/reprove-red.mjs");
export const NODE = process.execPath;
export const TEST_TIMEOUT = 120_000;

const dirs = [];
/** Removes every folder `tempDir` made; call it from `afterEach`. */
export const cleanup = () => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
};

export const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-reprove-scratch-"));
	dirs.push(dir);
	return dir;
};

export const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A fresh repository with no commit, in `at` (default: a new temp folder). */
export const newRepo = (at = tempDir()) => {
	mkdirSync(at, { recursive: true });
	git(at, "init", "-q", "-b", "main");
	git(at, "config", "user.email", "s2@example.invalid");
	git(at, "config", "user.name", "s2");
	git(at, "config", "core.autocrlf", "false");
	return at;
};

/** Writes `content` to `repo/path`, creating parent directories. */
export const put = (repo, path, content) => {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
};

/** Removes `repo/path`, file or folder. */
export const drop = (repo, path) =>
	rmSync(join(repo, path), { recursive: true, force: true });

/** Commits the working tree plus `gitlinks` (`{ path: sha }`, submodule entries with
    no folder); returns the new commit's full SHA. */
export const commitAll = (repo, message, gitlinks = {}) => {
	git(repo, "add", "-A");
	for (const [path, sha] of Object.entries(gitlinks)) {
		git(repo, "update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
	}
	git(repo, "commit", "-q", "-m", message);
	return git(repo, "rev-parse", "HEAD");
};

/** Exit code, stdout, stderr and stdout lines of the helper run in `cwd`, with `env`
    merged over the caller's environment (`undefined` removes a variable). */
export const runHelper = (args, cwd, env = {}) => {
	const merged = { ...process.env };
	for (const [key, value] of Object.entries(env)) {
		for (const name of Object.keys(merged)) {
			if (name.toLowerCase() === key.toLowerCase()) delete merged[name];
		}
		if (value !== undefined) merged[key] = value;
	}
	const result = spawnSync(NODE, [HELPER, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 60_000,
		env: merged,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		lines: result.stdout.split(/\r?\n/).filter(Boolean),
	};
};

/** `git rev-parse --git-path <path>` resolved against the repository. */
export const gitPath = (repo, path) =>
	resolve(repo, git(repo, "rev-parse", "--git-path", path));

export const lastLine = (lines) => lines.at(-1);

/** The lines after `base:` and before `exit:` (or the end): the path and diagnostic lines. */
export const headerBody = (lines) => {
	const from = lines.findIndex((line) => line.startsWith("base: ")) + 1;
	const to = lines.findIndex((line) => line.startsWith("exit: "));
	return lines.slice(from, to < 0 ? undefined : to);
};

// The runner stand-in, committed as `rec.mjs` in each base. `--out <file>` saves its
// arguments, folder, environment, guard and every file it sees (with content) as JSON;
// in a Python run it writes record files into `records/` of the guard folder named first
// on its PYTHONPATH: `--records <json>` (`[{ name, text }]`, `{cwd}` and `{guard}`
// filled in), else one clean record. `--copy <src>` copies a report to the
// `--junitxml=` path, `--linger <s>` leaves a detached child working in the run folder
// for that long, `--sleep <s>` waits, `--code <n>` is the exit code.
export const RECORDER = `import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
const args = process.argv.slice(2);
const opt = (name) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const guard = (process.env.PYTHONPATH ?? "").split(delimiter)[0];
const records = guard ? join(guard, "records") : "";
const fill = (text) => text.replaceAll("{cwd}", process.cwd()).replaceAll("{guard}", guard);
const report = args.find((arg) => arg.startsWith("--junitxml="))?.slice(11);
if (opt("--copy") && report) copyFileSync(opt("--copy"), report);
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return walk(path);
		return entry.isFile() ? [path] : [];
	});
if (opt("--out")) {
	const cwd = process.cwd();
	const files = Object.fromEntries(
		walk(cwd).map((path) => [relative(cwd, path).replaceAll("\\\\", "/"), readFileSync(path, "utf-8")]),
	);
	const site = join(guard, "sitecustomize.py");
	writeFileSync(opt("--out"), JSON.stringify({
		args,
		cwd,
		env: {
			PYTHONPATH: process.env.PYTHONPATH ?? null,
			PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE ?? null,
			RPIV_PROBE: process.env.RPIV_PROBE ?? null,
		},
		guard: guard && existsSync(records) && existsSync(site) ? { dir: guard, site: readFileSync(site, "utf-8") } : null,
		files,
	}));
}
if (records && existsSync(records)) {
	const specs = opt("--records")
		? JSON.parse(readFileSync(opt("--records"), "utf-8"))
		: [{ name: "clean", text: "start: 10\\npackage: {guard}\\nmodule: {cwd}/rec.mjs\\nend: 10\\n" }];
	for (const { name, text } of specs) writeFileSync(join(records, name), fill(text));
}
if (opt("--linger")) {
	const { spawn } = await import("node:child_process");
	const ms = Number(opt("--linger")) * 1000;
	spawn(process.execPath, ["-e", "setTimeout(() => {}, " + ms + ")"], {
		cwd: process.cwd(),
		detached: true,
		stdio: "ignore",
	}).unref();
}
if (opt("--sleep")) await new Promise((done) => setTimeout(done, Number(opt("--sleep")) * 1000));
process.exit(Number(opt("--code") ?? 0));
`;
