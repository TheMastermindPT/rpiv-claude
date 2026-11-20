// tests/test-contract.test.mjs — contract tests for skills/_shared/test-contract.mjs (the
// Test line grammar test-contract-authoring.md writes down) and for the finalization gate
// validate-artifact.mjs builds on it. The regression rows are Test lines copied verbatim
// from SlopStop's phase-3 brief (2026-10-25 arch-review phase 3), lines 277-1025, which
// slice-preflight listed as `unchecked` on every slice before the file form existed.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	contractProblems,
	contractSections,
	isTestPath,
	parseTestContract,
} from "../skills/_shared/test-contract.mjs";
import { validateArtifact } from "../skills/_shared/validate-artifact.mjs";

const VALIDATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"../skills/_shared/validate-artifact.mjs",
);

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const put = (dir, path, text) => {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
	return join(dir, path);
};

/** The tests one Test line yields, read as the only line of a one-behavior contract. */
const readLine = (testLine) => {
	const [b] = parseTestContract(
		`### Test Contract: s\n\n- **Behavior B1**: x\n  - Test: ${testLine}\n`,
		"s",
	).behaviors;
	return { tests: b.tests, unchecked: b.unchecked.map((u) => u.text) };
};

// [brief line, Test line text, whole files it names]
const PHASE3_FILE_LINES = [
	[
		811,
		"`packages/protocol/src/harness-fatal-log-protocol.test.ts`.",
		["packages/protocol/src/harness-fatal-log-protocol.test.ts"],
	],
	[
		824,
		"`apps/harness/src/harness-request-diagnostics.test.ts`, with `createHarnessLogger(<captured destination>)` (the real Pino options).",
		["apps/harness/src/harness-request-diagnostics.test.ts"],
	],
	[
		832,
		"`apps/harness/src/harness-runtime.test.ts`, with a recording port (it records `{ boundary, failure }` and asserts `failure` by identity, `toBe`).",
		["apps/harness/src/harness-runtime.test.ts"],
	],
	[
		838,
		"`apps/harness/src/project-storage-application.test.ts`, `apps/harness/src/workspace-application.test.ts`, with the recording port.",
		[
			"apps/harness/src/project-storage-application.test.ts",
			"apps/harness/src/workspace-application.test.ts",
		],
	],
	[
		844,
		'`apps/harness/src/process-bootstrap.test.ts`, through the real `startHarnessProcessRuntime` (the "routes the process runtime through its edges" pattern), with `createHarnessLogger(<captured destination>)` as `logger`.',
		["apps/harness/src/process-bootstrap.test.ts"],
	],
	[
		848,
		"`apps/desktop/src/main/harness-log-lines.test.ts`.",
		["apps/desktop/src/main/harness-log-lines.test.ts"],
	],
	[
		855,
		'`apps/desktop/tests/e2e/electron-launch.ts` `expectDesktopLog`, used by every journey: zero lines with `msg: "Harness request failure."`.',
		["apps/desktop/tests/e2e/electron-launch.ts"],
	],
	[
		998,
		"`apps/harness/src/harness-request-diagnostics.test.ts`, through `createHarnessRequestDiagnostics(createHarnessLogger(<captured destination>))` and the strict `HarnessRequestFailureLogLineSchema` decode (the P3-B12 seam).",
		["apps/harness/src/harness-request-diagnostics.test.ts"],
	],
	[
		1011,
		"`apps/harness/src/storage/storage-error-contract.test.ts` (new), constructing each exported class and subclass through its module export.",
		["apps/harness/src/storage/storage-error-contract.test.ts"],
	],
	[
		1025,
		"`apps/harness/src/canonical-project-application.test.ts` `invalidResult`, its existing oracle tightened in place.",
		["apps/harness/src/canonical-project-application.test.ts"],
	],
];

describe("the Test line grammar", () => {
	it.each(PHASE3_FILE_LINES)(
		"reads SlopStop phase-3 line %i as whole-file tests",
		(_, testLine, paths) => {
			expect(readLine(testLine)).toEqual({
				tests: paths.map((path) => ({ path })),
				unchecked: [],
			});
		},
	);

	it("reads the titled forms, and a phase-3 title form with prose after it", () => {
		expect(
			readLine(
				"`classifies each storage error code once` in `project-storage-node-errors.test.ts`.",
			).tests,
		).toEqual([
			{
				title: "classifies each storage error code once",
				path: "project-storage-node-errors.test.ts",
			},
		]);
		expect(
			readLine("`a` and `b` -> `t/x.test.ts`; rewrite in `t/y.test.ts` (`c`)")
				.tests,
		).toEqual([
			{ title: "a", path: "t/x.test.ts" },
			{ title: "b", path: "t/x.test.ts" },
			{ title: "c", path: "t/y.test.ts" },
		]);
	});

	it("leaves a line in none of the four forms unreadable (SlopStop phase-3 line 497)", () => {
		const line497 =
			"two rows added to the existing `classifies a stored reservation … as corrupt` table in `registration-confirmation-store.test.ts`:";
		expect(readLine(line497)).toEqual({ tests: [], unchecked: [line497] });
		expect(
			readLine("`Schema.SchemaError`, then `a/b.test.ts`").unchecked,
		).toHaveLength(1);
	});

	it.each([
		["a/b.ts", true],
		["x.test.ts", true],
		["./tests/hook.test.mjs", true],
		["Schema.SchemaError", false],
		["error.cause", false],
		["createHarnessLogger(<captured destination>)", false],
		["invalidResult", false],
		["a/b", false],
		["a b/c.ts", false],
	])("isTestPath(%s) is %s", (token, expected) => {
		expect(isTestPath(token)).toBe(expected);
	});
});

describe("contractSections and contractProblems", () => {
	it("lists every contract section and what in it a reader cannot check", () => {
		const text = [
			"## Slice one",
			"#### Test Contract: s1",
			"- **Behavior B1**: x",
			"  - Test: `t` -> `a.test.ts`",
			"- **Behavior B2**: y",
			"  - Expected red: none — pin",
			"## Slice two",
			"#### Test Contract: s2",
			"- **Behavior B3**: z",
			"  - Test: every title in some file",
		].join("\n");
		const sections = contractSections(text);
		expect(sections.map((s) => [s.id, s.line])).toEqual([
			["s1", 2],
			["s2", 8],
		]);
		expect(contractProblems(sections[0].body)).toEqual([
			{ line: 5, problem: "B2 has no Test line" },
		]);
		expect(contractProblems(sections[1].body)).toEqual([
			{
				line: 10,
				problem: "B3 unreadable Test clause: every title in some file",
			},
		]);
	});
});

describe("validate-artifact --finalizing gate on Test Contracts", () => {
	const FM =
		"---\ndate: d\nauthor: a\ncommit: c\nbranch: b\nrepository: r\nstatus: in-progress\n---\n";
	const OLD =
		"#### Test Contract: s-old\n\n- **Behavior B1**: old\n  - Test: two rows added to the existing table in `x.test.ts`\n";
	const NEW_OK =
		"#### Test Contract: s-new\n\n- **Behavior B2**: new\n  - Test: `apps/a/new.test.ts` (new), every row.\n";
	const NEW_BAD =
		"#### Test Contract: s-new\n\n- **Behavior B2**: new\n  - Test: the existing suite stays green\n";

	/** A brief at `.rpiv/artifacts/designs/brief.md`, with approved copies of `approved`. */
	const brief = (body, approved = []) => {
		const repo = mkdtempSync(join(tmpdir(), "rpiv-contract-gate-"));
		dirs.push(repo);
		for (const [i, text] of approved.entries())
			put(repo, `.rpiv/evidence/brief/approved-${i}.md`, FM + text);
		return put(repo, ".rpiv/artifacts/designs/brief.md", FM + body);
	};
	// Line numbers count the whole file, front matter (8 lines) included.
	const gate = (path) =>
		validateArtifact(path, dirname(path), { finalizing: true });

	it("rejects an unreadable Test line or a Behavior without one in a section not yet approved", () => {
		const { errors } = gate(brief(`${OLD}\n${NEW_BAD}`));
		expect(errors).toContain(
			"Test Contract s-old line 12: B1 unreadable Test clause: two rows added to the existing table in `x.test.ts`",
		);
		expect(errors).toContain(
			"Test Contract s-new line 17: B2 unreadable Test clause: the existing suite stays green",
		);
		expect(
			gate(brief("#### Test Contract: s\n\n- **Behavior B9**: x\n")).errors,
		).toEqual(["Test Contract s line 11: B9 has no Test line"]);
	});

	it("only warns on a section an approved copy holds verbatim, so an append-only brief can take its next slice", () => {
		const ok = gate(brief(`${OLD}\n${NEW_OK}`, [OLD]));
		expect(ok.errors).toEqual([]);
		expect(ok.warnings).toEqual([
			"Test Contract s-old line 12: B1 unreadable Test clause: two rows added to the existing table in `x.test.ts`",
		]);
		const bad = gate(brief(`${OLD}\n${NEW_BAD}`, [OLD]));
		expect(bad.errors).toEqual([
			"Test Contract s-new line 17: B2 unreadable Test clause: the existing suite stays green",
		]);
	});

	it("treats an approved section edited since approval as new", () => {
		const edited = OLD.replace("old\n", "old, edited\n");
		expect(gate(brief(edited, [OLD])).errors).toHaveLength(1);
	});

	it("rejects a duplicate section id and runs only under --finalizing", () => {
		const path = brief(`${NEW_OK}\n${NEW_OK}`);
		expect(gate(path).errors).toEqual([
			"Test Contract s-new at line 9: duplicate section id",
			"Test Contract s-new at line 14: duplicate section id",
		]);
		expect(validateArtifact(brief(NEW_BAD), "", {}).errors).toEqual([]);
	});

	it("reports an unclosed fence as unreadable contracts only when a contract heading exists", () => {
		const open = "```js\nconst a = 1;\n";
		expect(gate(brief(`${NEW_OK}\n${open}`)).errors).toContain(
			"test contracts unreadable: unterminated code fence opened at line 14 of the brief",
		);
		expect(gate(brief(`# Research\n\n${open}`)).errors).not.toContainEqual(
			expect.stringContaining("test contracts unreadable"),
		);
	});

	// SlopStop phase 3 keeps no approved copies, so --slice names the section being approved.
	it("with --slice, fails only the named slices and warns on every other section", () => {
		const path = brief(`${OLD}\n${NEW_BAD}`);
		const byId = (...slices) =>
			validateArtifact(path, "", { finalizing: true, slices });
		expect(byId("s-old")).toEqual({
			errors: [
				"Test Contract s-old line 12: B1 unreadable Test clause: two rows added to the existing table in `x.test.ts`",
			],
			warnings: [
				"Test Contract s-new line 17: B2 unreadable Test clause: the existing suite stays green",
			],
		});
		expect(byId("s-new").errors).toEqual([
			"Test Contract s-new line 17: B2 unreadable Test clause: the existing suite stays green",
		]);
		expect(byId("s-missing").errors).toEqual([
			"no Test Contract section for --slice s-missing",
		]);
		expect(gate(brief(`${OLD}\n${NEW_OK}`)).errors).toHaveLength(1);
		expect(
			validateArtifact(brief(`${OLD}\n${NEW_OK}`), "", {
				finalizing: true,
				slices: ["s-new"],
			}).errors,
		).toEqual([]);
	});

	// SlopStop keeps .rpiv/evidence gitignored in its main checkout, so a linked worktree
	// (slopstop-p3) never holds the approved copies itself.
	it("finds approved copies in the main worktree when the brief sits in a linked one", () => {
		const parent = mkdtempSync(join(tmpdir(), "rpiv-contract-wt-"));
		dirs.push(parent);
		const main = join(parent, "main");
		const linked = join(parent, "linked");
		mkdirSync(main);
		const git = (cwd, ...args) =>
			execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		git(main, "init", "-q", "-b", "main");
		git(main, "config", "user.email", "p@example.invalid");
		git(main, "config", "user.name", "p");
		put(main, ".gitignore", ".rpiv/evidence/\n");
		git(main, "add", "-A");
		git(main, "commit", "-q", "-m", "base");
		git(main, "worktree", "add", "-q", "-b", "slice", linked);
		const path = put(
			linked,
			".rpiv/artifacts/designs/brief.md",
			`${FM}${OLD}\n${NEW_OK}`,
		);
		expect(gate(path).errors).toHaveLength(1);

		put(main, ".rpiv/evidence/brief/approved-0.md", FM + OLD);
		expect(gate(path)).toEqual({
			errors: [],
			warnings: [
				"Test Contract s-old line 12: B1 unreadable Test clause: two rows added to the existing table in `x.test.ts`",
			],
		});
	});

	it("reads repeated --slice options on the command line and refuses one without a value", () => {
		const path = brief(`${OLD}\n${NEW_OK}`);
		const cli = (...args) =>
			spawnSync(process.execPath, [VALIDATE, path, "--finalizing", ...args], {
				encoding: "utf-8",
			});
		const ok = cli("--slice", "s-new");
		expect(ok.status).toBe(0);
		expect(ok.stderr).toContain("WARN ");
		expect(ok.stderr).toContain("Test Contract s-old line 12");
		expect(cli("--slice", "s-new", "--slice", "s-old").status).toBe(1);
		expect(cli("--slice").status).toBe(2);
	});
});
