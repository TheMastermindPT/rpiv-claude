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
			"measured refactor",
			/record a baseline score for each touched file/,
			/one\s+small behavior-preserving change at a time/,
			/re-measure after each/,
			/declared threshold is met/,
			/no touched file regresses from its baseline/,
			/measurement as `unavailable`, or as `broken`/,
		],
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
				/missing `Lane:` line or a broken lane call means `normal`, never `fast`/i,
				/\| Workspace \| branch in the main working tree \| linked worktree \| linked worktree \|/,
				/\| Intent review \| no \| no \| yes \|/,
				/\| slice-verifier \| yes \| yes \| yes \|/,
				/\| Code\/coverage reviewer pair \| no \| no \| yes \|/,
				/\| Per-slice human acceptance \| no \| no \| yes \|/,
				/falls back to a linked worktree when the main working tree has uncommitted changes/i,
				/never stash/i,
				/deterministic checks[^.]*before[^.]*review agent/i,
			]) {
				expect(text).toMatch(rule);
			}
		}
	});

	it("caps fix loops at two rounds, then asks the developer", () => {
		const [claude, opencode] = workflowTexts();
		for (const text of [claude, opencode]) {
			expect(text).toMatch(/After 2 fix rounds, stop and ask the developer/i);
			expect(text).toMatch(/never start a third round/i);
		}
		// The OpenCode adapter renames the ask tool (opencode/adapter.mjs).
		expect(claude).toMatch(/ask_user_question/);
		expect(opencode).toMatch(/`question`/);
		const dispatch = joined(readFileSync(dispatchPath, "utf8"));
		expect(dispatch).toMatch(/After 2 fix rounds/i);
		expect(dispatch).not.toMatch(/no fixed retry cap/i);
	});

	it("ends each slice as one commit amended only while unpushed", () => {
		for (const text of workflowTexts()) {
			for (const rule of [
				/exactly one commit/i,
				/do not commit intermediate/i,
				/amend that commit while it is unpushed/i,
				/Never amend a pushed commit/i,
				/commit message carries the red and green evidence/i,
			]) {
				expect(text).toMatch(rule);
			}
		}
		expect(joined(readFileSync(implementPath, "utf8"))).toMatch(
			/exactly one commit/i,
		);
	});
});
