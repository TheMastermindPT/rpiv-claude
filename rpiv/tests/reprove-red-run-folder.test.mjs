// tests/reprove-red-run-folder.test.mjs — reprove-red for a package in a subfolder (rpiv
// issue draft 20261124-123428-d6faf9de): `--in <folder>` runs the command there, a
// `--test` path written from the repository's top folder (as Test Contracts write it)
// matches the report the runner writes from its own folder, and outside a Python run a
// call that names tests runs only their files.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	lastLine,
	NODE,
	newRepo,
	put,
	RECORDER,
	runHelper,
	TEST_TIMEOUT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

const TITLE = "B1: rejects x";

/** A vitest report holding one failed case of `classname`. */
const reportOf = (classname) =>
	`<?xml version="1.0" encoding="UTF-8" ?><testsuites><testsuite name="${classname}"><testcase classname="${classname}" name="${TITLE}"><failure message="expected 1 to be 2"/></testcase></testsuite></testsuites>`;

/** A repository with a package in `web/` (the recorder as its runner) and a slice
    adding two of its test files. */
const packageSlice = () => {
	const repo = newRepo();
	put(repo, "web/package.json", "{}\n");
	put(repo, "web/rec.mjs", RECORDER);
	commitAll(repo, "base");
	put(repo, "web/tests/unit/a.test.mjs", `it("${TITLE}", () => {});\n`);
	put(repo, "web/tests/unit/b.test.mjs", "c\n");
	return { repo, commit: commitAll(repo, "slice") };
};

/** The helper on the slice from `callerCwd` with `options`, naming `id`; the recorder
    copies a report of `classname` and exits 1. Returns the run, `{tests}` and the
    recorder's folder. */
const run = ({ repo, commit }, { callerCwd, options, id, classname }) => {
	const dir = tempDir();
	const out = join(dir, "out.json");
	const report = join(dir, "report.xml");
	writeFileSync(report, reportOf(classname));
	const result = runHelper(
		[
			"--commit",
			commit,
			...options,
			"--test",
			id,
			"--",
			NODE,
			join(repo, "web/rec.mjs"),
			"--out",
			out,
			"--junitxml={junit}",
			"--copy",
			report,
			"--from",
			"{tests}",
			"--code",
			"1",
		],
		callerCwd,
	);
	if (result.status !== 0 || result.stderr) return { ...result, tests: [] };
	const recorded = JSON.parse(readFileSync(out, "utf-8"));
	const { args } = recorded;
	const tests = args.slice(args.indexOf("--from") + 1, args.indexOf("--code"));
	return { ...result, tests, cwd: recorded.cwd };
};

const resultsOf = (result) =>
	result.lines.filter((line) => line.startsWith("test-result: "));

describe("reprove-red for a package in a subfolder", () => {
	it(
		"--in runs from the package, and a test path from the top folder matches its report",
		() => {
			const s = packageSlice();
			const id = `web/tests/unit/a.test.mjs::${TITLE}`;
			const result = run(s, {
				callerCwd: s.repo,
				options: ["--in", "web"],
				id,
				classname: "tests/unit/a.test.mjs",
			});
			expect.soft(result.stderr).toBe("");
			expect.soft(result.cwd.replaceAll("\\", "/")).toMatch(/\/web$/);
			expect.soft(result.tests).toEqual(["tests/unit/a.test.mjs"]);
			expect.soft(resultsOf(result)).toEqual([`test-result: failed ${id}`]);
			expect.soft(lastLine(result.lines)).toBe("result: red");
		},
		TEST_TIMEOUT,
	);

	it(
		"a caller in the package naming the test from the package still matches",
		() => {
			const s = packageSlice();
			const id = `tests/unit/a.test.mjs::${TITLE}`;
			const result = run(s, {
				callerCwd: join(s.repo, "web"),
				options: [],
				id,
				classname: "tests/unit/a.test.mjs",
			});
			expect.soft(result.stderr).toBe("");
			expect.soft(result.tests).toEqual(["tests/unit/a.test.mjs"]);
			expect.soft(resultsOf(result)).toEqual([`test-result: failed ${id}`]);
		},
		TEST_TIMEOUT,
	);

	it(
		"a report written from the top folder matches the test path from the top folder",
		() => {
			const s = packageSlice();
			const id = `web/tests/unit/a.test.mjs::${TITLE}`;
			const result = run(s, {
				callerCwd: s.repo,
				options: ["--in", "web"],
				id,
				classname: "web/tests/unit/a.test.mjs",
			});
			expect.soft(resultsOf(result)).toEqual([`test-result: failed ${id}`]);
		},
		TEST_TIMEOUT,
	);

	it(
		"an --in folder that does not exist is a broken call",
		() => {
			const s = packageSlice();
			const result = run(s, {
				callerCwd: s.repo,
				options: ["--in", "nope"],
				id: `web/tests/unit/a.test.mjs::${TITLE}`,
				classname: "tests/unit/a.test.mjs",
			});
			expect.soft(result.status).toBe(2);
			expect
				.soft(result.stderr)
				.toBe("reprove-red: broken: --in folder missing: nope\n");
			expect.soft(result.stdout).toBe("");
		},
		TEST_TIMEOUT,
	);
});
