import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptSupportMarkdown } from "../opencode/adapter.mjs";

const workflow = new URL(
	"../skills/_shared/candidate-workflow.md",
	import.meta.url,
);

describe("candidate workflow authority", () => {
	it.each([
		["bounded intent", /Build authorization/, /Candidate acceptance/],
		["separate integration", /Integration authorization/, /target.*changed/i],
		["safe workspace", /not a command sandbox/, /uncommitted/],
		["complete identity", /base_commit/, /untracked/, /contract.*hash/i],
		["observed TDD", /Expected red/, /independent review\/refactor/i],
		[
			"honest gates",
			/unavailable/,
			/broken/,
			/block\s+readiness\s+or\s+acceptance/i,
		],
	])("preserves %s in both adapters", (_name, ...obligations) => {
		const source = readFileSync(workflow, "utf8");
		for (const text of [source, adaptSupportMarkdown(source)]) {
			for (const obligation of obligations) {
				expect(text).toMatch(obligation);
			}
		}
	});
});

// "Joined text": every run of whitespace as one space, so wrapped phrases match.
const joined = (text) => text.replace(/\s+/g, " ");
const dispatchPath = new URL(
	"../skills/_shared/artifact-review-dispatch.md",
	import.meta.url,
);
const implementPath = new URL("../skills/implement/SKILL.md", import.meta.url);
const validatePath = new URL("../skills/validate/SKILL.md", import.meta.url);
const workflowTexts = () => {
	const source = readFileSync(workflow, "utf8");
	return [source, adaptSupportMarkdown(source)].map(joined);
};

describe("lane rules", () => {
	it("defines the lanes and what each one runs", () => {
		for (const text of workflowTexts()) {
			expect(text).toContain("## Lanes");
			for (const rule of [
				/`Lane:` line/,
				/lane\.mjs --paths/,
				/lane\.mjs --range/,
				/only raises the lane/i,
				/missing `Lane:` line, a missing feature lane, or a broken lane call means `normal`, never `fast`/i,
				/Every slice runs in one lane: `fast` or `normal`/,
				/older artifact's\s+`rigorous` reads as `normal`/i,
				/never words in file names/i,
				/the developer confirms it/i,
				/\| Workspace \| branch in the main working tree \| linked worktree \|/,
				/\| Intent review \| no \| yes \|/,
				/\| slice-verifier \| yes \| yes \|/,
				/\| Code\/coverage reviewer pair \| no \| yes \|/,
				/\| Per-slice human acceptance \| no \| yes \|/,
				/\| Deep-review depth \| light \| full \|/,
				/falls back to a linked worktree when the main working tree has uncommitted changes/i,
				/never stash/i,
				/deterministic checks[^.]*before[^.]*review agent/i,
				/skills\/_shared\/lane\.mjs/,
				/broken call never lowers a recorded lane/i,
				/`lane: broken:` diagnostic is kept/i,
				/A raise is recorded as an appended `## Developer Context` entry/i,
				/remaining steps follow the raised lane/i,
				/before dispatching any candidate-mode review agent/i,
				/wherever rpiv says accepted predecessor, fast means the gate-passed predecessor/i,
			]) {
				expect(text).toMatch(rule);
			}
		}
	});

	it("counts one intent round inside the cap and offers reopening the approach at the cap stop", () => {
		for (const text of workflowTexts()) {
			expect(text).toMatch(/Intent review gets at most 1 round, counted inside the 2-round cap/i);
			expect(text).toMatch(/one more fix round[^.]*accept the post-round fixes as residual risk[^.]*pause[^.]*reopen the approach/i);
			expect(text).toMatch(/skills\/_shared\/convergence\.mjs/);
			expect(text).toMatch(/`convergence: reopen`[^.]*first choice/i);
			expect(text).toMatch(/`convergence: broken:`[^.]*never[^.]*keep/i);
			expect(text).toMatch(/\| Approach check \| no \| yes \|/);
			expect(text).toMatch(/skills\/_shared\/slice-preflight\.mjs/);
			expect(text).toMatch(/exit 2 is a broken gate that blocks/i);
			expect(text).toMatch(/`preflight: not run \(no slice commit\)`, never a pass/i);
			expect(text).toMatch(/--artifact <brief> --slice <slice-id> --base <base> --candidate <candidate>/);
			expect(text).toMatch(/That round includes its confirming rerun/i);
			expect(text).toMatch(/Reopening the approach starts a new 2-round cap/i);
			expect(text).toMatch(/`convergence: not run \(one candidate round\)`/);
		}
		const revise = joined(readFileSync(new URL("../skills/revise/SKILL.md", import.meta.url), "utf8"));
		expect(revise).toMatch(/within the shared \*\*Lanes\*\* round cap/i);
		const dispatch = joined(readFileSync(dispatchPath, "utf8"));
		expect(dispatch).toMatch(/an intent review that needed fixes counts as one of them; a clean intent review spends none/i);
		expect(dispatch).toMatch(/start it with one of `fixed`, `dismissed`, `deferred`, `residual` or `follow-up`/);
		expect(dispatch).toMatch(/skills\/_shared\/review-yield\.mjs/);
		const plan = joined(readFileSync(new URL("../skills/plan/SKILL.md", import.meta.url), "utf8"));
		expect(plan).toMatch(/Rerun intent review only when the projection splits, merges or reorders slices/i);
		expect(plan).toMatch(/The rerun stays inside the slice's one intent round/i);
		const design = joined(readFileSync(new URL("../skills/design/SKILL.md", import.meta.url), "utf8"));
		expect(design).toMatch(/Approach check/);
		expect(design).toMatch(/never blocks/i);
		expect(design).toMatch(/Only Verified rows count as verified upstream facts/);
		expect(design).toMatch(/rerun stays inside the one intent round/i);
		const checkpoint = joined(readFileSync(new URL("../skills/_shared/dimension-sweep-and-checkpoint.md", import.meta.url), "utf8"));
		for (const state of ["approach check: unavailable", "approach check: broken:", "approach check: not run (no rejected options)", "ungrounded: no citation"]) {
			expect(checkpoint).toContain(state);
		}
		expect(checkpoint).toMatch(/a missing row is never read as Verified/i);
		expect(checkpoint).toMatch(/`<decision>\.R<n>~RR<m>`/);
		expect(checkpoint).toMatch(/duplicate or unknown row ID[^.]*malformed/i);
	});

	it("caps fix loops at two rounds, then asks the developer", () => {
		const [claude, opencode] = workflowTexts();
		for (const text of [claude, opencode]) {
			expect(text).toMatch(/After 2 fix rounds, stop and ask the developer/i);
			expect(text).toMatch(/never start a third round/i);
			expect(text).toMatch(/never turns unresolved findings/i);
			expect(text).toMatch(
				/accept fixes made after the last round without a further review/i,
			);
		}
		// The OpenCode adapter renames the ask tool (opencode/adapter.mjs).
		expect(claude).toMatch(
			/stop and ask the developer with `ask_user_question`/,
		);
		expect(opencode).toMatch(/stop and ask the developer with `question`/);
		const dispatch = joined(readFileSync(dispatchPath, "utf8"));
		expect(dispatch).toMatch(/After 2 fix rounds/i);
		expect(dispatch).not.toMatch(/no fixed retry cap/i);
		expect(dispatch).toMatch(/never converts unresolved findings/i);
		expect(dispatch).toMatch(
			/pair runs for slice candidate reviews where the slice's lane requires it/i,
		);
	});

	it("ends each slice as one commit amended only while unpushed", () => {
		for (const text of workflowTexts()) {
			for (const rule of [
				/exactly one commit/i,
				/do not commit intermediate/i,
				/amend that commit while it is unpushed/i,
				/Never amend a pushed commit/i,
				/commit message carries the red and green evidence/i,
				/When commits are authorized, each slice ends as exactly one commit/i,
				/Without commit authority[^.]*frozen snapshot/i,
				/parent commit plus a digest of its complete working-tree patch/i,
				/fix after the slice commit was pushed is a stop/i,
			]) {
				expect(text).toMatch(rule);
			}
		}
		expect(joined(readFileSync(implementPath, "utf8"))).toMatch(
			/exactly one commit/i,
		);
	});

	it("drops the measured-refactor rule and keeps the advisory target", () => {
		for (const text of workflowTexts()) {
			for (const removed of [
				/record a baseline score for each touched file/,
				/declared threshold is met/,
				/no touched file regresses from its baseline/,
				/re-measure after each/,
			]) {
				expect(text).not.toMatch(removed);
			}
			expect(text).toMatch(/at least 9\.0/);
			expect(text).toMatch(/does not block on its own/i);
			expect(text).toMatch(
				/small behavior-preserving steps and rerun the relevant tests after each/i,
			);
		}
	});

	it("mutation runs once after the last review round", () => {
		// D35, verbatim (S24).
		const RUN_ONCE =
			"Mutation runs once, on the final candidate after the last review round's fixes or after the developer ends reviews; a run on an earlier candidate never counts for a later one.";
		const REUSE =
			"Validate reuses a recorded mutation run only when it ran on the revision being validated; otherwise it runs mutation once on that revision.";
		const count = (text, phrase) => text.split(phrase).length - 1;
		for (const text of workflowTexts()) {
			expect(count(text, RUN_ONCE)).toBe(1);
			const checks = text.indexOf("Available Quality Checks");
			const integration = text.indexOf("## Integration");
			expect(text.indexOf(RUN_ONCE)).toBeGreaterThan(checks);
			expect(text.indexOf(RUN_ONCE)).toBeLessThan(integration);
			expect(text).toContain(
				"Run the deterministic checks (tests, types, lint, and CodeScene where available) before dispatching any candidate-mode review agent.",
			);
		}
		const implement = joined(readFileSync(implementPath, "utf8"));
		const section3 = implement.slice(implement.indexOf("## 3."), implement.indexOf("## 4."));
		expect(section3).toContain(RUN_ONCE);
		const validate = joined(readFileSync(validatePath, "utf8"));
		expect(validate).toContain(RUN_ONCE);
		expect(validate).toContain(REUSE);
		for (const skill of ["implement", "validate"]) {
			const generated = joined(
				readFileSync(new URL(`../opencode/generated/skills/rpiv-${skill}/SKILL.md`, import.meta.url), "utf8"),
			);
			expect(generated, skill).toContain(RUN_ONCE);
		}
		expect(
			joined(readFileSync(new URL("../opencode/generated/skills/rpiv-validate/SKILL.md", import.meta.url), "utf8")),
		).toContain(REUSE);
	});

	it("accepts per slice only in the normal lane", () => {
		for (const text of workflowTexts()) {
			expect(text).toMatch(
				/In fast, a slice whose gates pass becomes the predecessor for the next slice without a human stop/i,
			);
			expect(text).toMatch(
				/accepts the combined result once before integration/i,
			);
			expect(text).toMatch(
				/In the normal lane, the human accepts each slice/i,
			);
			expect(text).toMatch(/Every lane still stops for/i);
			expect(text).toMatch(
				/missing, failed, broken, unavailable, pending, or stale/i,
			);
		}
		const implement = joined(readFileSync(implementPath, "utf8"));
		expect(implement).toMatch(
			/In the normal lane, stop until the human accepts the exact candidate revision/i,
		);
		expect(implement).toMatch(
			/accepts the combined result once before integration/i,
		);
		expect(implement).toMatch(/workspace the lane requires/i);
		expect(implement).toContain("lane workspace setup");
		const asks = implement.match(/[^.]*ask the human to accept[^.]*\./gi) ?? [];
		expect(asks.filter((sentence) => !/normal lane/i.test(sentence))).toEqual([]);
		const validate = joined(readFileSync(validatePath, "utf8"));
		expect(validate).toMatch(/normal slice[^.]*without[^.]*acceptance/i);
		expect(validate).toMatch(/in fast[^.]*combined result/i);
		expect(validate).not.toMatch(/if absent, report awaiting acceptance/i);
		expect(validate).toMatch(/acceptance the slice's lane requires is absent/i);
		expect(validate).toMatch(/included normal slice without its acceptance/i);
	});

	it("revise and the validation template follow the lane", () => {
		const revise = joined(
			readFileSync(
				new URL("../skills/revise/SKILL.md", import.meta.url),
				"utf8",
			),
		);
		expect(revise).not.toMatch(/exact-revision human acceptance/i);
		expect(revise).toMatch(/reviews and acceptance its lane requires/i);
		const template = joined(
			readFileSync(
				new URL("../skills/validate/templates/validation.md", import.meta.url),
				"utf8",
			),
		);
		expect(template).not.toMatch(/permission to advance/i);
		expect(template).toMatch(/acceptance the lane requires/i);
	});
});
