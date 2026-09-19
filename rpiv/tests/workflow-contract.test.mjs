import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptSkill } from "../opencode/adapter.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// These guard the shipped instructions, not an agent's runtime compliance.
describe("lean planning contract", () => {
	it.each(["design", "plan", "blueprint"])(
		"%s keeps implementation in source rather than duplicating it in artifacts",
		(name) => {
			const source = read(`skills/${name}/SKILL.md`);
			expect(source).not.toMatch(
				/Generate complete, copy-pasteable code|NEW files get full implementation|insert the code blocks from the design|slice boundaries become phase boundaries 1:1/i,
			);
			expect(source).toContain("candidate-workflow.md");
			expect(source).toMatch(/deferred|just-in-time|progressive/i);
		},
	);

	it.each(["design", "plan", "blueprint", "implement", "revise", "validate"])(
		"%s exposes the same workflow contract to Claude and OpenCode",
		(name) => {
			const source = read(`skills/${name}/SKILL.md`);
			const pointer = "skills/_shared/candidate-workflow.md";
			expect(source).toContain(`\${CLAUDE_PLUGIN_ROOT}/${pointer}`);
			expect(adaptSkill(source, name).content).toContain(
				`$RPIV_PLUGIN_ROOT/${pointer}`,
			);
			expect(read(pointer)).toMatch(/## Intent|## Brief/);
		},
	);
});
