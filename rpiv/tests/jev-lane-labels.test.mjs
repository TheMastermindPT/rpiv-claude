// tests/jev-lane-labels.test.mjs — contract tests for the developer lane labels
// scripts/jev-lane-labels.mjs and the rotated-log reader readLogLines of
// scripts/jev-gate.mjs (slice S30-lane-labels, D40, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
// The CLI is spawned in throwaway repositories whose .rpiv/logs/ hold hand-written
// shadow rows in S8's row shape (S30 revision 1: rows keep `paths`).

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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, initRepo } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "jev-lane-labels.mjs");
const TEST_TIMEOUT = 60_000;

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-s30-"))).replaceAll(
	"\\",
	"/",
);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let count = 0;

/** A repository on `feat/x`. */
function repo() {
	const dir = initRepo(`${TMP}/r${count++}`);
	git(dir, "switch", "-q", "-c", "feat/x");
	return dir;
}

const logs = (dir) => join(dir, ".rpiv", "logs");
const SHADOW = "jev-lane-shadow.log";
const LABELS = "jev-lane-labels.log";

/** Writes `rows` (objects, or raw text lines) as the log `name`. */
function writeLog(dir, name, rows) {
	mkdirSync(logs(dir), { recursive: true });
	const text = rows
		.map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
		.join("\n");
	writeFileSync(join(logs(dir), name), `${text}\n`);
}

/** The shadow log path as the CLI names it: resolved from git's top level. */
const shadowPath = (dir) =>
	resolve(git(dir, "rev-parse", "--show-toplevel"), ".rpiv/logs", SHADOW);

const readLabels = (dir) => {
	const path = join(logs(dir), LABELS);
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
};

/** A shadow row in S8's shape. */
const row = (ts, paths, fields = {}) => ({
	ts,
	branch: "feat/x",
	mode: "paths",
	slices: 1,
	files: paths.length,
	paths,
	lane: "normal",
	status: "ok",
	jevLane: "normal",
	score: 1,
	...fields,
});

function cli(cwd, ...args) {
	const res = spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 30_000,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP },
	});
	return {
		status: res.status,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-02T10:00:00.000Z";
const T3 = "2026-10-03T10:00:00.000Z";

describe("lane labels (S30)", () => {
	it(
		"label joins the newest shadow row measured on the same paths",
		() => {
			const dir = repo();
			const sub = join(dir, "sub");
			mkdirSync(sub);
			const both = ["a.js", "sub/x.js"];
			writeLog(dir, `${SHADOW}.1`, [
				row(T1, both, { lane: "fast", jevLane: "normal", score: 0.8 }),
			]);
			writeLog(dir, SHADOW, [
				row(T2, both, { lane: "normal", jevLane: "rigorous", score: 1.7 }),
				row(T3, ["b.js"]),
			]);
			const res = cli(
				sub,
				"label",
				"--slice",
				"S9",
				"--lane",
				"rigorous",
				"--",
				"../a.js",
				"x.js",
			);
			expect(res.stderr).toBe("");
			expect(res.status).toBe(0);
			expect(res.stdout).toBe(
				`label: rigorous for S9 (shadow row ${T2}, rule normal, jev rigorous)\n`,
			);
			// S30 revision 2 (W5): exactly one line per call.
			expect(readLabels(dir)).toHaveLength(1);
			const [label] = readLabels(dir);
			expect(label).toEqual({
				ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
				slice: "S9",
				label: "rigorous",
				branch: "feat/x",
				row: {
					ts: T2,
					lane: "normal",
					status: "ok",
					jevLane: "rigorous",
					score: 1.7,
				},
			});
			// order and duplicates do not matter
			expect(
				cli(
					sub,
					"label",
					"--slice",
					"S9",
					"--lane",
					"fast",
					"--",
					"x.js",
					"../a.js",
					"x.js",
				).stdout,
			).toBe(
				`label: fast for S9 (shadow row ${T2}, rule normal, jev rigorous)\n`,
			);
			// with R2 gone, the rotated generation is read
			writeLog(dir, SHADOW, [row(T3, ["b.js"])]);
			expect(
				cli(
					sub,
					"label",
					"--slice",
					"S9",
					"--lane",
					"normal",
					"--",
					"../a.js",
					"x.js",
				).stdout,
			).toBe(
				`label: normal for S9 (shadow row ${T1}, rule fast, jev normal)\n`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"a label is written without a matching shadow row",
		() => {
			const dir = repo();
			expect(
				cli(dir, "label", "--slice", "S9", "--lane", "fast", "--", "a.js"),
			).toEqual({
				status: 0,
				stdout: "label: fast for S9 (no shadow row)\n",
				stderr: "",
			});
			expect(readLabels(dir)[0]).toMatchObject({
				slice: "S9",
				label: "fast",
				row: null,
			});

			const unavailable = row(T1, ["a.js"], {
				status: "unavailable",
				reason: "no key",
			});
			delete unavailable.jevLane;
			delete unavailable.score;
			writeLog(dir, SHADOW, [
				unavailable,
				row(T2, ["a.js"], { mode: "range" }),
			]);
			expect(
				cli(dir, "label", "--slice", "S9", "--lane", "fast", "--", "a.js")
					.stdout,
			).toBe(`label: fast for S9 (shadow row ${T1}, rule normal, jev none)\n`);
			expect(readLabels(dir)[1].row).toEqual({
				ts: T1,
				lane: "normal",
				status: "unavailable",
				jevLane: null,
				score: null,
			});

			// a row written before S30 has no paths and never joins
			const old = row(T3, ["a.js"]);
			delete old.paths;
			writeLog(dir, SHADOW, [old]);
			expect(
				cli(dir, "label", "--slice", "S9", "--lane", "fast", "--", "a.js")
					.stdout,
			).toBe("label: fast for S9 (no shadow row)\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"bad label calls and malformed logs are broken",
		() => {
			const dir = repo();
			writeLog(dir, LABELS, [{ slice: "S0", label: "fast", row: null }]);
			const before = readFileSync(join(logs(dir), LABELS), "utf8");
			const cases = [
				[
					["label", "--slice", "S9", "--lane", "slow", "--", "a.js"],
					"jev-lane-labels: broken: lane must be fast, normal or rigorous\n",
				],
				[
					["label", "--lane", "fast", "--", "a.js"],
					"jev-lane-labels: broken: --slice needs an id\n",
				],
				[
					["label", "--slice", "S9", "--lane", "fast", "--"],
					"jev-lane-labels: broken: label needs the measured paths after --\n",
				],
				[
					["label", "--slice", "S9", "--lane", "fast"],
					"jev-lane-labels: broken: label needs the measured paths after --\n",
				],
				[["relabel"], "jev-lane-labels: broken: unknown command: relabel\n"],
			];
			for (const [args, stderr] of cases) {
				expect
					.soft(cli(dir, ...args), args.join(" "))
					.toEqual({ status: 2, stdout: "", stderr });
			}
			writeLog(dir, SHADOW, [row(T1, ["a.js"]), "{oops"]);
			const malformed = cli(
				dir,
				"label",
				"--slice",
				"S9",
				"--lane",
				"fast",
				"--",
				"a.js",
			);
			expect(malformed.status).toBe(2);
			expect(malformed.stdout).toBe("");
			// S30 revision 2 (W5): the exact path.
			expect(malformed.stderr).toBe(
				`jev-lane-labels: broken: malformed line 2 in ${shadowPath(dir)}\n`,
			);
			expect(readFileSync(join(logs(dir), LABELS), "utf8")).toBe(before);

			const outside = `${TMP}/outside${count++}`;
			mkdirSync(outside);
			const out = cli(
				outside,
				"label",
				"--slice",
				"S9",
				"--lane",
				"fast",
				"--",
				"a.js",
			);
			expect(out.status).toBe(2);
			expect(out.stdout).toBe("");
			expect(out.stderr.startsWith("jev-lane-labels: broken: ")).toBe(true);
		},
		TEST_TIMEOUT,
	);

	const label = (lane, r, slice = "S1") => ({
		ts: T1,
		slice,
		label: lane,
		branch: "feat/x",
		row: r,
	});
	const shadowOf = (lane, jevLane, score) => ({
		ts: T1,
		lane,
		status: "ok",
		jevLane,
		score,
	});

	it(
		"report counts labels by lane and score band across both log generations",
		() => {
			const dir = repo();
			writeLog(dir, `${LABELS}.1`, [
				label("fast", shadowOf("fast", "normal", 0.6), "S1"),
			]);
			writeLog(dir, LABELS, [
				label("normal", shadowOf("normal", "normal", 0.5), "S2"),
				label("normal", shadowOf("fast", "rigorous", 1.5), "S3"),
				label("rigorous", null, "S4"),
			]);
			expect(cli(dir, "report")).toEqual({
				status: 0,
				stderr: "",
				stdout: [
					"labels: 4",
					"enforce: not ready (4 of 20 labels)",
					"label fast: 1 (rule lower 0, same 1, higher 0, none 0; jev lower 0, same 0, higher 1, none 0)",
					"label normal: 2 (rule lower 1, same 1, higher 0, none 0; jev lower 0, same 1, higher 1, none 0)",
					"label rigorous: 1 (rule lower 0, same 0, higher 0, none 1; jev lower 0, same 0, higher 0, none 1)",
					"band 0-0.5: 0 (fast 0, normal 0, rigorous 0)",
					"band 0.5-1.5: 2 (fast 1, normal 1, rigorous 0)",
					"band 1.5-2: 1 (fast 0, normal 1, rigorous 0)",
					"band none: 1 (fast 0, normal 0, rigorous 1)",
					"",
				].join("\n"),
			});

			const many = (n) =>
				Array.from({ length: n }, (_, i) =>
					label("fast", shadowOf("fast", "fast", 0), `S${i}`),
				);
			const fresh = repo();
			writeLog(fresh, LABELS, many(19));
			const nineteen = cli(fresh, "report").stdout.split("\n");
			expect(nineteen.slice(0, 2)).toEqual([
				"labels: 19",
				"enforce: not ready (19 of 20 labels)",
			]);
			expect(nineteen).toContain(
				"band 0-0.5: 19 (fast 19, normal 0, rigorous 0)",
			);
			writeLog(fresh, LABELS, many(20));
			expect(cli(fresh, "report").stdout.split("\n")[1]).toBe(
				"enforce: enough labels (20 of 20)",
			);

			expect(cli(repo(), "report").stdout).toBe(
				[
					"labels: 0",
					"enforce: not ready (0 of 20 labels)",
					"label fast: 0 (rule lower 0, same 0, higher 0, none 0; jev lower 0, same 0, higher 0, none 0)",
					"label normal: 0 (rule lower 0, same 0, higher 0, none 0; jev lower 0, same 0, higher 0, none 0)",
					"label rigorous: 0 (rule lower 0, same 0, higher 0, none 0; jev lower 0, same 0, higher 0, none 0)",
					"band 0-0.5: 0 (fast 0, normal 0, rigorous 0)",
					"band 0.5-1.5: 0 (fast 0, normal 0, rigorous 0)",
					"band 1.5-2: 0 (fast 0, normal 0, rigorous 0)",
					"band none: 0 (fast 0, normal 0, rigorous 0)",
					"",
				].join("\n"),
			);

			const bad = repo();
			writeLog(bad, LABELS, ["{oops"]);
			const broken = cli(bad, "report");
			expect(broken.status).toBe(2);
			expect(broken.stdout).toBe("");
			expect(broken.stderr).toMatch(
				/^jev-lane-labels: broken: malformed line 1 in .*jev-lane-labels\.log\n$/,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"report counts the latest label per slice",
		() => {
			// S30 revision 2 (B194): a slice labelled twice counts once, by its last label.
			const dir = repo();
			writeLog(dir, LABELS, [
				label("fast", null, "S1"),
				label("rigorous", null, "S2"),
				label("normal", null, "S1"),
			]);
			const lines = cli(dir, "report").stdout.split("\n");
			expect(lines[0]).toBe("labels: 2");
			expect(lines.slice(2, 5)).toEqual([
				"label fast: 0 (rule lower 0, same 0, higher 0, none 0; jev lower 0, same 0, higher 0, none 0)",
				"label normal: 1 (rule lower 0, same 0, higher 0, none 1; jev lower 0, same 0, higher 0, none 1)",
				"label rigorous: 1 (rule lower 0, same 0, higher 0, none 1; jev lower 0, same 0, higher 0, none 1)",
			]);
			expect(lines).toContain("band none: 2 (fast 0, normal 1, rigorous 1)");
		},
		TEST_TIMEOUT,
	);

	it(
		"label paths go through the shadow row's own path chain",
		() => {
			// S30 revision 2 (B192): generated and media paths are dropped on both
			// sides, and a row keeps only the first 200 paths.
			const dir = repo();
			writeLog(dir, SHADOW, [row(T1, ["src/a.js"])]);
			const dropped = cli(
				dir,
				"label",
				"--slice",
				"S9",
				"--lane",
				"normal",
				"--",
				"src/a.js",
				"opencode/generated/skills/x/SKILL.md",
				"logo.png",
			);
			expect(dropped.stdout).toBe(
				`label: normal for S9 (shadow row ${T1}, rule normal, jev normal)\n`,
			);
			const many = Array.from({ length: 201 }, (_, i) => `p${i}.js`);
			const label201 = () =>
				cli(dir, "label", "--slice", "S9", "--lane", "normal", "--", ...many);
			writeLog(dir, SHADOW, [{ ...row(T2, many.slice(0, 200)), files: 201 }]);
			expect(label201().stdout).toBe(
				`label: normal for S9 (shadow row ${T2}, rule normal, jev normal)\n`,
			);
			writeLog(dir, SHADOW, [{ ...row(T2, many.slice(0, 200)), files: 202 }]);
			expect(label201().stdout).toBe("label: normal for S9 (no shadow row)\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"a label over a row's 200-path prefix does not join",
		() => {
			// S30 review 2 (D-1): a row measured on 201 files keeps a 200-path prefix,
			// so a label over exactly those 200 paths is a different change.
			const dir = repo();
			const many = Array.from({ length: 201 }, (_, i) => `p${i}.js`);
			writeLog(dir, SHADOW, [{ ...row(T2, many.slice(0, 200)), files: 201 }]);
			expect(
				cli(
					dir,
					"label",
					"--slice",
					"S9",
					"--lane",
					"normal",
					"--",
					...many.slice(0, 200),
				).stdout,
			).toBe("label: normal for S9 (no shadow row)\n");
		},
		TEST_TIMEOUT,
	);

	it(
		"a malformed line is reported in its own generation",
		async () => {
			// S30 revision 2 (B193).
			const dir = repo();
			const call = () =>
				cli(dir, "label", "--slice", "S9", "--lane", "fast", "--", "a.js");
			writeLog(dir, `${SHADOW}.1`, [row(T1, ["a.js"]), "", "{oops"]);
			const inRotated = call();
			expect(inRotated.status).toBe(2);
			expect(inRotated.stderr).toBe(
				`jev-lane-labels: broken: malformed line 3 in ${shadowPath(dir)}.1\n`,
			);
			const good = row(T1, ["a.js"]);
			writeLog(dir, `${SHADOW}.1`, [good, good, good]);
			writeLog(dir, SHADOW, ["{oops"]);
			expect(call().stderr).toBe(
				`jev-lane-labels: broken: malformed line 1 in ${shadowPath(dir)}\n`,
			);

			const { readLogEntries } = await import("../scripts/jev-gate.mjs");
			const folder = `${TMP}/entries${count++}`;
			mkdirSync(folder);
			const p = join(folder, "x.log");
			writeFileSync(`${p}.1`, "a\n\nb\n");
			writeFileSync(p, "c\n");
			expect(readLogEntries(p)).toEqual([
				{ file: `${p}.1`, number: 1, text: "a" },
				{ file: `${p}.1`, number: 3, text: "b" },
				{ file: p, number: 1, text: "c" },
			]);
		},
		TEST_TIMEOUT,
	);

	it("readLogLines reads the rotated log before the current one", async () => {
		const { readLogLines } = await import("../scripts/jev-gate.mjs");
		const dir = `${TMP}/lines${count++}`;
		mkdirSync(dir);
		const p = join(dir, "x.log");
		expect(readLogLines(p)).toEqual([]);
		writeFileSync(p, "c\r\n");
		expect(readLogLines(p)).toEqual(["c"]);
		writeFileSync(`${p}.1`, "a\n\nb\n");
		expect(readLogLines(p)).toEqual(["a", "b", "c"]);
		const folder = join(dir, "folder.log");
		mkdirSync(folder);
		expect(() => readLogLines(folder)).toThrow();
	});

	it("implement and design label the approved lane", () => {
		const joined = (path) =>
			readFileSync(join(ROOT, path), "utf-8").replace(/\s+/g, " ");
		for (const skill of ["implement", "design"]) {
			for (const path of [
				`skills/${skill}/SKILL.md`,
				`opencode/generated/skills/rpiv-${skill}/SKILL.md`,
			]) {
				const text = joined(path);
				expect
					.soft(text, path)
					.toMatch(
						/jev-lane-labels\.mjs" label --slice <id> --lane <approved lane> -- <the paths lane\.mjs --paths measured>/,
					);
				expect
					.soft(text, path)
					.toMatch(
						/a `jev-lane-labels: broken:` answer is reported to the developer, never dropped/i,
					);
			}
		}
	});
});
