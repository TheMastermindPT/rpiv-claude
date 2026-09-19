import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { adaptAgent, adaptSupportMarkdown } from "../opencode/adapter.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const reviewers = [
	"slice-verifier",
	"artifact-code-reviewer",
	"artifact-coverage-reviewer",
];

// Guard the shipped prompt contract and registration, not model compliance.
describe("candidate reviewer contract", () => {
	it.each(reviewers)(
		"%s separates intent review from inspection of a frozen candidate",
		(name) => {
			const source = read(`agents/${name}.md`);
			const adapted = adaptAgent(source, name);

			expect(adapted.id).toBe(`rpiv:${name}`);
			expect(adapted.config.tools).toEqual({
				"*": false,
				read: true,
				grep: true,
				glob: true,
			});
			expect(adapted.config.permission).toEqual({
				edit: "deny",
				bash: "deny",
				task: "deny",
				todowrite: "deny",
			});
			for (const prompt of [source, adapted.config.prompt]) {
				expect(prompt).toContain("workflow_path");
				expect(prompt).toMatch(/absolute path/i);
				expect(prompt).toContain("mode=intent");
				expect(prompt).toContain("mode=candidate");
				expect(prompt).toMatch(
					/intent[\s\S]*cannot claim[\s\S]*implementation correctness/i,
				);
				expect(prompt).toMatch(/actual diff[\s\S]*files[\s\S]*tests/i);
				expect(prompt).toContain("base_commit");
				expect(prompt).toContain("candidate_revision");
				expect(prompt).toMatch(/parent[\s\S]*read-only[\s\S]*Git/i);
				expect(prompt).not.toMatch(
					/current_slice_code|projected intermediate state|walk every (?:Phase|slice) code fence/i,
				);
				expect(prompt).toMatch(/incomplete[\s\S]*unavailable[\s\S]*broken/i);
			}
		},
	);

	it("retains the slice rows and pair columns while separating inspection gaps", () => {
		const slice = adaptAgent(read("agents/slice-verifier.md"), "slice-verifier")
			.config.prompt;
		expect(
			[...slice.matchAll(/^- (Decisions|Cross-slice|Research):/gm)].map(
				(match) => match[1],
			),
		).toEqual(["Decisions", "Cross-slice", "Research"]);
		expect(slice).toContain("INCOMPLETE:");
		expect(slice).toContain("UNAVAILABLE:");
		expect(slice).toContain("BROKEN:");

		for (const name of reviewers.slice(1)) {
			const prompt = adaptAgent(read(`agents/${name}.md`), name).config.prompt;
			expect(prompt).toContain(
				"| plan-loc | codebase-loc | severity | dimension | finding | recommendation |",
			);
			expect(prompt).toMatch(
				/no-findings marker only after completed inspection/,
			);
			expect(prompt).toMatch(/diagnostics outside the findings table/);
		}
	});
});

describe.each(["Claude", "OpenCode"])("%s frozen review dispatch", (host) => {
	it.each(["intent", "candidate"])(
		"sends the identical %s packet to both independent roles",
		(mode) => {
			const source = read("skills/_shared/artifact-review-dispatch.md");
			const dispatch =
				host === "Claude" ? source : adaptSupportMarkdown(source);
			const tool = host === "Claude" ? "Agent" : "task";
			const example = [
				...dispatch.matchAll(/^```(?:javascript|js)?\r?\n([\s\S]*?)\r?\n```/gm),
			]
				.map((match) => match[1])
				.find((code) => code.includes(`${tool}({`));
			expect(example, "executable reviewer dispatch example").toBeTypeOf(
				"string",
			);
			const packet = JSON.stringify({
				mode,
				workflow_path: "/plugin/skills/_shared/candidate-workflow.md",
				artifact_path: "/fixture/brief.md",
				repository_path: "/fixture/candidate",
				base_commit: "a".repeat(40),
				candidate_revision: mode === "candidate" ? "b".repeat(40) : null,
				evidence_paths: mode === "candidate" ? ["/fixture/green.log"] : [],
			});
			const calls = [];
			runInNewContext(
				example,
				{
					review_packet: packet,
					[tool]: (input) => calls.push(input),
				},
				{ timeout: 1000 },
			);

			expect(calls.map((call) => call.subagent_type)).toEqual([
				"rpiv:artifact-code-reviewer",
				"rpiv:artifact-coverage-reviewer",
			]);
			expect(calls.map((call) => call.prompt)).toEqual([packet, packet]);
		},
	);

	it("blocks missing or broken mandatory reviews instead of falling back to ready", () => {
		const source = read("skills/_shared/artifact-review-dispatch.md");
		const dispatch = host === "Claude" ? source : adaptSupportMarkdown(source);
		const rootVariable =
			host === "Claude" ? "${CLAUDE_PLUGIN_ROOT}" : "$RPIV_PLUGIN_ROOT";
		expect(dispatch).toContain(
			`${rootVariable}/skills/_shared/candidate-workflow.md`,
		);
		expect(dispatch).toMatch(/incomplete[\s\S]*blocks ready\/acceptance/i);
		expect(dispatch).toMatch(/capability[^\n]*unavailable/i);
		expect(dispatch).toMatch(/crash[^\n]*malformed[^\n]*timeout[^\n]*broken/i);
		expect(dispatch).toMatch(/defects[^\n]*failed/i);
		expect(dispatch).toMatch(/inspection completion.*finding disposition/i);
		expect(dispatch).toMatch(/nonblocking concerns.*residual risk/i);
		expect(dispatch).toMatch(/fresh evidence[^\n]*new identity/i);
		expect(dispatch).toMatch(/defer[^\n]*dismiss[^\n]*waiv/i);
		expect(dispatch).not.toMatch(
			/proceeded to developer review without|Proceed to the triage-step regardless|at most two|max(?:imum)? (?:of )?2/i,
		);
	});
});
