// tests/target-context.test.mjs — contract tests for the shared git/target preamble
// (skills/architectural-review/_helpers/target-context.mjs). Pins the pure path helpers
// to the exact behaviour of the copies they replace (coverage.mjs / mutation.mjs /
// semantic.mjs), so the extraction is provably behaviour-preserving.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { relOf, toPosix, underTarget } from "../skills/architectural-review/_helpers/target-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TC_URL = pathToFileURL(resolve(HERE, "..", "skills", "architectural-review", "_helpers", "target-context.mjs")).href;

describe("toPosix / relOf / underTarget", () => {
	it("toPosix flips every backslash", () => {
		expect(toPosix("a\\b\\c")).toBe("a/b/c");
	});

	it("relOf strips the cwd prefix, passes non-prefix paths through", () => {
		expect(relOf("/x/y/z.js", "/x/y")).toBe("z.js");
		expect(relOf("/a/b.js", "/x/y")).toBe("/a/b.js");
	});

	it("underTarget matches the dir and its children, never a false prefix", () => {
		expect(underTarget("skills/x", "skills")).toBe(true);
		expect(underTarget("skillsX", "skills")).toBe(false);
		expect(underTarget("x", ".")).toBe(true);
	});
});

describe("resolveTargets union semantics", () => {
	// resolveTargets reads process.cwd() + git, so evaluate it in a spawned node
	// process whose cwd is a throwaway git repo with dirs a/ and b/.
	const tmp = mkdtempSync(join(tmpdir(), "tc-union-"));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	it("unions, dedups, defaults to '.', and skips flags", () => {
		mkdirSync(join(tmp, "a"), { recursive: true });
		mkdirSync(join(tmp, "b"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: "ignore" });
		const script = [
			`import { resolveTargets } from ${JSON.stringify(TC_URL)};`,
			`const r = resolveTargets(["a", "b"]);`,
			`process.stdout.write(JSON.stringify({`,
			`	len: r.targets.length,`,
			`	underA: r.underAny("a/x.mjs"),`,
			`	underB: r.underAny("b/y.mjs"),`,
			`	underC: r.underAny("c/z.mjs"),`,
			`	label: r.targetLabel,`,
			`	dedup: resolveTargets(["a", "a"]).targets.length,`,
			`	emptyDefault: resolveTargets([]).targets[0].target,`,
			`	flagSkip: resolveTargets(["--flag", "a"]).targets.length,`,
			`}));`,
		].join("\n");
		const out = execFileSync("node", ["--input-type=module", "-e", script], { cwd: tmp, encoding: "utf-8" });
		expect(JSON.parse(out)).toEqual({
			len: 2,
			underA: true,
			underB: true,
			underC: false,
			label: "a b",
			dedup: 1,
			emptyDefault: ".",
			flagSkip: 1,
		});
	});
});
