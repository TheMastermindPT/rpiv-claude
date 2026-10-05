// tests/lane-cli.test.mjs — contract tests for the lane CLI in
// skills/_shared/lane.mjs (slice S5-lane-cli, D17, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// The CLI is spawned in throwaway git repositories under the OS temp folder.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANE = join(ROOT, "skills/_shared/lane.mjs");
const TEST_TIMEOUT = 120_000;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-lane-cli-"));
	dirs.push(dir);
	return dir;
};

const git = (repo, ...args) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();

/** A fresh repository with no commit. */
const newRepo = () => {
	const repo = tempDir();
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "s5@example.invalid");
	git(repo, "config", "user.name", "s5");
	git(repo, "config", "core.autocrlf", "false");
	return repo;
};

/** Writes `content` to `repo/path`, creating parent directories. */
const put = (repo, path, content) => {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), content);
};

/** `count` distinct lines, each ending in a newline. */
const lines = (count, tag = "l") =>
	Array.from({ length: count }, (_, i) => `${tag}${i + 1}\n`).join("");

/** Exit code, stdout and stderr of the lane CLI run in `cwd`. */
const runLane = (args, { cwd, env } = {}) => {
	const result = spawnSync(process.execPath, [LANE, ...args], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...env },
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** A successful run printing exactly `outputLines`. */
const printed = (...outputLines) => ({
	status: 0,
	stdout: outputLines.map((line) => `${line}\n`).join(""),
	stderr: "",
});

describe("lane CLI (S5)", () => {
	it(
		"classifies a planned path list",
		() => {
			const repo = newRepo();
			const cases = [
				[
					["--paths", "src/a.ts", "--slices", "1"],
					["lane: fast", "reason: within fast limits", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"],
				],
				[
					["--slices", "1", "--paths", "src/a.ts"],
					["lane: fast", "reason: within fast limits", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"],
				],
				[
					["--paths", "./src/auth/x.ts", "--slices", "1"],
					["lane: rigorous", "reason: sensitive word: auth (src/auth/x.ts)", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"],
				],
				[
					["--paths", "src/a.ts"],
					["lane: fast", "reason: within fast limits", "diagnostic: slices unknown", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"],
				],
				[
					["--paths", "src/a.ts", "dist/a.js", "img/logo.png", "--slices", "1"],
					["lane: fast", "reason: within fast limits", "diagnostic: lines unknown", "diagnostic: hub signal unavailable", "diagnostic: excluded generated/media files: 2"],
				],
				[
					["--paths", "dist/a.js", "--slices", "1"],
					["lane: normal", "reason: no changed files", "diagnostic: no changed files", "diagnostic: excluded generated/media files: 1"],
				],
			];
			for (const [args, want] of cases) {
				expect.soft(runLane(args, { cwd: repo }), args.join(" ")).toEqual(printed(...want));
			}
			// Thresholds come from the repository root, also from a sub-directory.
			put(repo, ".rpiv-lanes.json", '{"fast":{"maxFiles":1}}');
			mkdirSync(join(repo, "src"), { recursive: true });
			expect
				.soft(runLane(["--paths", "src/a.ts", "src/b.ts", "--slices", "1"], { cwd: join(repo, "src") }))
				.toEqual(
					printed("lane: normal", "reason: files: 2 > 1", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"),
				);
		},
		TEST_TIMEOUT,
	);

	it(
		"classifies a commit range from numstat",
		() => {
			const repo = newRepo();
			const commit = (message) => {
				git(repo, "add", "-A");
				git(repo, "commit", "-q", "-m", message);
				return git(repo, "rev-parse", "HEAD");
			};
			put(repo, "src/a.ts", lines(50, "old"));
			put(repo, "src/auth/x.ts", lines(2));
			const c0 = commit("c0");
			put(repo, "src/a.ts", lines(100, "new"));
			const c1 = commit("c1");
			put(repo, "src/a.ts", `${lines(100, "new")}one more\n`);
			const c2 = commit("c2");
			put(repo, "data/blob.bin", Buffer.from([0, 1, 2, 0, 3]));
			put(repo, "img/x.png", Buffer.from([137, 80, 78, 71, 0, 0]));
			const c3 = commit("c3");
			mkdirSync(join(repo, "src/core"));
			git(repo, "mv", "src/auth/x.ts", "src/core/x.ts");
			const c4 = commit("c4");
			put(repo, "src/auth ação.ts", "one\n");
			const c5 = commit("c5");
			const range = (from, to) => runLane(["--range", `${from}..${to}`, "--slices", "1"], { cwd: repo });
			expect.soft(range(c0, c1), "C0..C1").toEqual(
				printed("lane: fast", "reason: within fast limits", "diagnostic: hub signal unavailable"),
			);
			expect.soft(range(c0, c2), "C0..C2").toEqual(
				printed("lane: normal", "reason: lines: 151 > 150", "diagnostic: hub signal unavailable"),
			);
			expect.soft(range(c2, c3), "C2..C3").toEqual(
				printed(
					"lane: fast",
					"reason: within fast limits",
					"diagnostic: lines unknown",
					"diagnostic: hub signal unavailable",
					"diagnostic: excluded generated/media files: 1",
				),
			);
			expect.soft(range(c3, c4), "C3..C4").toEqual(
				printed("lane: rigorous", "reason: sensitive word: auth (src/auth/x.ts)", "diagnostic: hub signal unavailable"),
			);
			expect.soft(range(c4, c5), "C4..C5").toEqual(
				printed("lane: rigorous", "reason: sensitive word: auth (src/auth ação.ts)", "diagnostic: hub signal unavailable"),
			);
			const bad = runLane(["--range", "nope..HEAD"], { cwd: repo });
			expect.soft(bad.status).toBe(2);
			expect.soft(bad.stdout).toBe("");
			expect.soft(bad.stderr).toMatch(/^lane: broken: [^\n]*git[^\n]*\n$/);
		},
		TEST_TIMEOUT,
	);

	it(
		"classifies the working tree",
		() => {
			const working = (repo) => runLane(["--working", "--slices", "1"], { cwd: repo });
			const repo = newRepo();
			put(repo, "src/a.ts", lines(10));
			put(repo, ".gitignore", "ignored.txt\n");
			put(repo, ".rpiv-lanes.json", '{"fast":{"maxLines":0}}');
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "c0");
			expect.soft(working(repo), "clean").toEqual(
				printed("lane: normal", "reason: no changed files", "diagnostic: no changed files"),
			);
			put(repo, "src/a.ts", `${lines(10)}${lines(5, "more")}`);
			put(repo, "src/b.ts", lines(3));
			git(repo, "add", "src/b.ts");
			put(repo, "src/c.ts", "x\ny\nz\nw");
			put(repo, "src/e.ts", "");
			put(repo, "ignored.txt", lines(50));
			expect.soft(working(repo), "tracked + untracked").toEqual(
				printed("lane: normal", "reason: lines: 12 > 0", "diagnostic: hub signal unavailable"),
			);
			put(repo, "data/x.bin", Buffer.from([1, 0, 2]));
			expect.soft(working(repo), "untracked binary").toEqual(
				printed("lane: fast", "reason: within fast limits", "diagnostic: lines unknown", "diagnostic: hub signal unavailable"),
			);
			const unborn = newRepo();
			put(unborn, "src/a.ts", lines(151));
			git(unborn, "add", "src/a.ts");
			expect.soft(working(unborn), "no commit yet").toEqual(
				printed("lane: normal", "reason: lines: 151 > 150", "diagnostic: hub signal unavailable"),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"reads hubs from an import graph",
		() => {
			const repo = newRepo();
			const dep = (resolved, extra = {}) => ({ resolved, ...extra });
			// dependency-cruiser: each importer lists what it imports.
			const importer = (source) => ({
				source,
				dependencies: [
					dep("src/core.ts"),
					dep("src/gone.ts", { couldNotResolve: true }),
					dep("node_modules/x/index.js"),
					dep("fs", { coreModule: true }),
				],
			});
			const a = importer("src/a.ts");
			a.dependencies.push(dep("src/core.ts"), dep("src/two.ts"), dep("src/self.ts"));
			const b = importer("src/b.ts");
			b.dependencies.push(dep("src/two.ts"), dep("src/self.ts"));
			const dc = {
				modules: [
					a,
					b,
					importer("src/c.ts"),
					{ source: "src/self.ts", dependencies: [dep("src/self.ts")] },
					{ source: "src/core.ts", dependencies: [] },
				],
			};
			put(repo, "graphs/dc.json", JSON.stringify(dc));
			put(
				repo,
				"graphs/sub.json",
				JSON.stringify({
					modules: ["x", "y", "z"].map((name) => ({
						source: `skills/${name}.mjs`,
						dependencies: [dep("skills/core.mjs")],
					})),
				}),
			);
			const madge = {
				"src/a.ts": ["src/core.ts"],
				"src/b.ts": ["src/core.ts"],
				"src/c.ts": ["src/core.ts", "src/core.ts"],
				"src/core.ts": [],
			};
			put(repo, "graphs/madge.json", JSON.stringify(madge));
			const { "src/c.ts": _c, ...madgeTwo } = madge;
			put(repo, "graphs/madge-two.json", JSON.stringify(madgeTwo));
			const withGraph = (path, graph) =>
				runLane(["--paths", path, "--slices", "1", "--graph", graph], { cwd: repo });
			const hub = (path) => printed("lane: rigorous", `reason: hub: ${path}`, "diagnostic: lines unknown");
			const fast = printed("lane: fast", "reason: within fast limits", "diagnostic: lines unknown");
			for (const [path, graph, want] of [
				["src/core.ts", "graphs/dc.json", hub("src/core.ts")],
				["src\\core.ts", "graphs/dc.json", hub("src\\core.ts")],
				["src/two.ts", "graphs/dc.json", fast],
				["src/self.ts", "graphs/dc.json", fast],
				["src/gone.ts", "graphs/dc.json", fast],
				["src/core.ts", "graphs/madge.json", hub("src/core.ts")],
				["src/core.ts", "graphs/madge-two.json", fast],
				["rpiv/skills/core.mjs", "graphs/sub.json", hub("rpiv/skills/core.mjs")],
				["rpiv/xskills/core.mjs", "graphs/sub.json", fast],
			]) {
				expect.soft(withGraph(path, graph), `${path} with ${graph}`).toEqual(want);
			}
			// A broken graph is not "unavailable": it says so and raises fast one step.
			put(repo, "graphs/invalid.json", "{not json");
			put(repo, "graphs/array.json", "[]");
			put(repo, "graphs/modules5.json", '{"modules":5}');
			put(repo, "graphs/madge-string.json", '{"src/a.ts":"src/core.ts"}');
			const brokenLine = (graph) => new RegExp(`^diagnostic: hub signal broken: ${graph}: .+$`);
			for (const graph of [
				"graphs/missing.json",
				"graphs/invalid.json",
				"graphs/array.json",
				"graphs/modules5.json",
				"graphs/madge-string.json",
			]) {
				const result = withGraph("src/a.ts", graph);
				const out = result.stdout.trimEnd().split("\n");
				expect.soft(result.status, graph).toBe(0);
				expect.soft(result.stderr, graph).toBe("");
				expect
					.soft(out.slice(0, 4), graph)
					.toEqual([
						"lane: normal",
						"reason: within fast limits",
						"reason: hub signal broken: raised to normal",
						"diagnostic: lines unknown",
					]);
				expect.soft(out[4], graph).toMatch(brokenLine(graph));
				expect.soft(out, graph).toHaveLength(5);
			}
			const sensitive = withGraph("src/auth/x.ts", "graphs/array.json");
			const out = sensitive.stdout.trimEnd().split("\n");
			expect
				.soft(out.slice(0, 3))
				.toEqual(["lane: rigorous", "reason: sensitive word: auth (src/auth/x.ts)", "diagnostic: lines unknown"]);
			expect.soft(out[3]).toMatch(brokenLine("graphs/array.json"));
			expect.soft(out).toHaveLength(4);
		},
		TEST_TIMEOUT,
	);

	it(
		"rejects a broken call without a lane",
		() => {
			const repo = newRepo();
			put(repo, "src/a.ts", lines(2));
			git(repo, "add", "-A");
			git(repo, "commit", "-q", "-m", "c0");
			put(repo, "src/a.ts", lines(3));
			git(repo, "commit", "-q", "-am", "c1");
			const isBroken = (result, token, label) => {
				expect.soft(result.status, label).toBe(2);
				expect.soft(result.stdout, label).toBe("");
				expect.soft(result.stderr, label).toMatch(/^lane: broken: [^\n]+\n$/);
				expect.soft(result.stderr, label).toContain(token);
			};
			for (const [args, token] of [
				[[], "mode"],
				[["--range", "HEAD~1..HEAD", "--working"], "mode"],
				[["--working", "--working"], "mode"],
				[["--working", "--frob"], "--frob"],
				[["--range"], "--range"],
				[["--range", "--working"], "--range"],
				[["--paths"], "--paths"],
				[["--paths", "--slices", "1"], "--paths"],
				[["--paths", "a", "--slices", "0"], "--slices"],
				[["--paths", "a", "--slices", "1.5"], "--slices"],
				[["--paths", "a", "--slices", "x"], "--slices"],
				[["--paths", "a", "--slices"], "--slices"],
				[["--paths", "a", "--graph"], "--graph"],
			]) {
				isBroken(runLane(args, { cwd: repo }), token, args.join(" ") || "(none)");
			}
			const parent = tempDir();
			const outside = join(parent, "not-a-repo");
			mkdirSync(outside);
			isBroken(
				runLane(["--paths", "a"], { cwd: outside, env: { GIT_CEILING_DIRECTORIES: parent } }),
				"git",
				"outside a repository",
			);
			// Pin: a broken .rpiv-lanes.json still classifies (D16).
			put(repo, ".rpiv-lanes.json", "{not json");
			const broken = runLane(["--paths", "src/a.ts", "--slices", "1"], { cwd: repo });
			const out = broken.stdout.trimEnd().split("\n");
			expect.soft(broken.status).toBe(0);
			expect.soft(broken.stderr).toBe("");
			expect
				.soft(out.slice(0, 3))
				.toEqual(["lane: normal", "reason: within fast limits", "reason: broken config: raised to normal"]);
			expect.soft(out[3]).toMatch(/^diagnostic: broken config: \.rpiv-lanes\.json: invalid JSON \(.+\)$/);
			expect.soft(out.slice(4)).toEqual(["diagnostic: lines unknown", "diagnostic: hub signal unavailable"]);
		},
		TEST_TIMEOUT,
	);
});
