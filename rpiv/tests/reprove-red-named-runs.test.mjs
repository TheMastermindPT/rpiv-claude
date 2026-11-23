// tests/reprove-red-named-runs.test.mjs — reprove-red calls that name tests (rpiv issue
// draft 20261123-174308-8fd52ed1): two calls on one commit/base pair naming different tests
// keep separate logs and reports, and a Python run that names tests runs only those, so
// its report and run line cover what was named. Outside a Python run `{tests}` is as before.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanup,
	commitAll,
	NODE,
	newRepo,
	put,
	RECORDER,
	runHelper,
	TEST_TIMEOUT,
	tempDir,
} from "./fixtures/reprove-red-harness.mjs";

afterEach(cleanup);

/** A repository with the recorder at its base and a slice commit adding `paths`. */
const sliceOf = (paths) => {
	const repo = newRepo();
	put(repo, "rec.mjs", RECORDER);
	commitAll(repo, "base");
	for (const path of paths) put(repo, path, `c:${path}\n`);
	return { repo, slice: commitAll(repo, "slice") };
};

/** The helper on `slice` naming `ids`, the recorder as the runner (exit 1); returns the
    run and what `{tests}` expanded to. */
const namedRun = ({ repo, slice }, ids) => {
	const out = join(tempDir(), "out.json");
	const run = runHelper(
		[
			"--commit",
			slice,
			...ids.flatMap((id) => ["--test", id]),
			"--",
			NODE,
			join(repo, "rec.mjs"),
			"--out",
			out,
			"--junitxml={junit}",
			"--from",
			"{tests}",
			"--code",
			"1",
		],
		repo,
	);
	const args = JSON.parse(readFileSync(out, "utf-8")).args;
	const tests = args.slice(args.indexOf("--from") + 1, args.indexOf("--code"));
	return { ...run, tests };
};

const logOf = (run) => run.lines.find((line) => line.startsWith("log: "));

describe("reprove-red calls that name tests", () => {
	it(
		"a Python run that names tests expands {tests} to their pytest node ids only",
		() => {
			const s = sliceOf(["tests/test_a.py", "tests/test_b.py"]);
			const named = namedRun(s, [
				"tests/test_a.py::test_b1_x",
				"tests/test_a.py::TestK::test_y[1]",
			]);
			expect.soft(named.stderr).toBe("");
			expect
				.soft(named.tests)
				.toEqual([
					"tests/test_a.py::test_b1_x",
					"tests/test_a.py::TestK::test_y[1]",
				]);
			const whole = namedRun(s, []);
			expect.soft(whole.tests).toEqual(["tests/test_a.py", "tests/test_b.py"]);
		},
		TEST_TIMEOUT,
	);

	it(
		"outside a Python run {tests} stays every changed test",
		() => {
			const s = sliceOf(["tests/a.test.mjs", "tests/b.test.mjs"]);
			const run = namedRun(s, ["tests/a.test.mjs::x"]);
			expect.soft(run.stderr).toBe("");
			expect.soft(run.tests).toEqual(["tests/a.test.mjs", "tests/b.test.mjs"]);
		},
		TEST_TIMEOUT,
	);

	it(
		"two calls on one pair naming different tests keep separate logs; the same tests in any order share one",
		() => {
			const s = sliceOf(["tests/test_a.py", "tests/test_b.py"]);
			const a = "tests/test_a.py::test_a";
			const b = "tests/test_b.py::test_b";
			const first = logOf(namedRun(s, [a]));
			const second = logOf(namedRun(s, [b]));
			expect.soft(first).toMatch(/-[0-9a-f]{8}\.log$/);
			expect.soft(second).not.toBe(first);
			expect.soft(logOf(namedRun(s, [a, b]))).toBe(logOf(namedRun(s, [b, a])));
			expect.soft(logOf(namedRun(s, []))).not.toMatch(/-[0-9a-f]{8}\.log$/);
		},
		TEST_TIMEOUT,
	);
});
