// tests/alternatives-workflow.test.mjs — slice S11-rpiv-alternatives of
// .rpiv/artifacts/designs/2026-11-22_14-04-13_python-project-support.md (rpiv issue draft
// 20261122-204743-8babd307): contracts are settled after an un-anchored agent proposes
// structurally different mechanisms, review triage asks patch-or-mechanism for every
// blocker before fixing it, a switch is bounded by the round cap, and design points to
// explore for an irreversible open choice. One pin per load-bearing clause.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = (path) => readFileSync(join(ROOT, path), "utf-8");
const joined = (path) => raw(path).replace(/\s+/g, " ");
/** [path, phrase] rows for each path. */
const rows = (paths, phrases) =>
	paths.flatMap((path) => phrases.map((phrase) => [path, phrase]));
const check = (table) => {
	for (const [path, phrase] of table) expect.soft(joined(path), path).toMatch(phrase);
};

const SWEEP = [
	"skills/_shared/dimension-sweep-and-checkpoint.md",
	"opencode/generated/skills/_shared/dimension-sweep-and-checkpoint.md",
];
const DESIGN = ["skills/design/SKILL.md", "opencode/generated/skills/rpiv-design/SKILL.md"];
const REVISE = ["skills/revise/SKILL.md", "opencode/generated/skills/rpiv-revise/SKILL.md"];
const DISPATCH = [
	"skills/_shared/artifact-review-dispatch.md",
	"opencode/generated/skills/_shared/artifact-review-dispatch.md",
];
const WORKFLOW = [
	"skills/_shared/candidate-workflow.md",
	"opencode/generated/skills/_shared/candidate-workflow.md",
];

describe("alternative mechanisms in rpiv's workflow (S11-rpiv-alternatives)", () => {
	it("B55: the mechanism-options step has its narrow trigger, un-anchored packet, states, citation and per-run evidence", () => {
		check(
			rows(SWEEP, [
				/## Mechanism Options/,
				/decides what reads as broken, clean, skipped or exempt/i,
				/owns state or ordering across a process, file or network boundary/i,
				/fixes an output or format that is persisted or crosses a process boundary/i,
				/Not in the fast lane/,
				/One scout per slice/,
				/`mechanism options: not run \(covered by <mechanism>\)`/,
				/`mechanism options: not run \(no load-bearing mechanism\)`/,
				/`mechanism options: not run \(explored: <path>\)`/,
				/the seam as it is at the slice's base revision/i,
				/`do not read:` list/,
				/`rpiv:mechanism-scout` never sees the chosen mechanism/,
				/`D<n>\.R<n>`/,
				/its citation is the option's `fails at:` location/,
				/`ungrounded: no citation`/,
				/`mechanism options: unavailable`/,
				/`mechanism options: broken: <what is missing>` — never read as "no alternatives"/,
				/a count that differs from the `OPTION` rows/,
				/`mechanism options: anchored: <what it saw>`/,
				/open questions there, never a clean result/,
				/mechanism-options-<slice-id>-<n>\.md/,
				/A later run never overwrites an earlier one/,
				/Mechanism options \(advisory\):/,
			]),
		);
		check(
			rows(DESIGN, [
				/In the normal lane \(\*\*Lanes\*\*\), when the next slice adds or changes a load-bearing mechanism/,
				/\*\*Mechanism Options\*\*/,
				/A choice `explore` already compared is not scouted again/,
				/Pass its state line to the intent review beside the Approach check rows/,
			]),
		);
		check(
			rows(REVISE, [
				/\*\*Mechanism Options\*\*/,
				/candidate-review blocker tagged `mechanism` in triage is being switched/,
				/Revise runs no Approach Check: the rejections this creates go to the revised slice's review as open questions/,
			]),
		);
		check(
			rows(WORKFLOW, [
				/\| Mechanism options \| no \| yes \|/,
				/Detail the next slice just in time; in the normal lane, run \*\*Mechanism Options\*\*/,
			]),
		);
	});

	it("B56: mechanism-scout is a read-only agent with fixed option rows, an anchored line and no straw men", () => {
		const agent = raw("agents/mechanism-scout.md");
		expect.soft(agent).toMatch(/^---\r?\nname: mechanism-scout\r?\n/);
		expect.soft(agent).toMatch(/^tools: Read, Grep, Glob\r?$/m);
		const text = agent.replace(/\s+/g, " ");
		for (const phrase of [
			/OPTION <n> \| <mechanism> \| fails when: <input> -> <wrong outcome> \| fails at: <path:line or n\/a> \| switch cost: <[^>]+> \| grounding: <path:line or precedent>/,
			/anchored: <what showed you the chosen mechanism>/,
			/fewer than two real options: <why>/,
			/`options: <k>` is always last and counts the `OPTION` rows/,
			/Never open a file on the `do not read:` list/,
			/straw man/,
		]) {
			expect.soft(text).toMatch(phrase);
		}
		expect.soft(text).not.toMatch(/\brg\b/);
	});

	it("B57: triage owns the patch-or-mechanism question for every reviewer's blockers and asks before patching", () => {
		check(
			rows(DISPATCH, [
				/tag it `patch` or `mechanism`/,
				/from any reviewer \(code, coverage, slice-verifier `VIOLATION`\)/,
				/never waits on a reviewer's optional section/,
				/dispatch one `rpiv:mechanism-scout`/,
				/`unknown: <state>`/,
				/never patched without the developer's answer to one question: patch, or switch to <the option>/,
				/`fixed — patch: <reason>` or `fixed — mechanism: switched to <option>`/,
			]),
		);
		check(
			rows(WORKFLOW, [
				/in a candidate review, it is a revise of the active slice and counts as reopening the approach, starting the new cap once/,
				/A second switch on the same slice is not started/,
				/in an intent review, design or plan reopens the affected commitment and reruns \*\*Mechanism Options\*\* itself/,
			]),
		);
		// The switch (blocker 1 of the S11 review) moved the duty to triage: the code
		// reviewer's Alternatives stay advisory, with no per-blocker rule to contradict.
		const reviewer = joined("agents/artifact-code-reviewer.md");
		expect.soft(reviewer).not.toMatch(/none for <row>/);
		expect.soft(reviewer).toMatch(/`None` is a good answer\. Alternatives inform the developer and never block\./);
	});

	it("B58: design points to explore for an irreversible or cross-cutting open choice", () => {
		check(rows(DESIGN, [/irreversible or cross-cutting choice[^.]*`explore`/i]));
	});
});
