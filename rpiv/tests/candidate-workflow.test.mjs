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
