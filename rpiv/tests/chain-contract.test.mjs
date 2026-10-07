import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Prompt regressions for the single rpiv chain (S11): they inspect files, not agent compliance.
const repo = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(repo, path), "utf8");

const filesUnder = (dir) =>
	readdirSync(join(repo, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));

describe("one rpiv chain", () => {
	it("retires blueprint from live sources", () => {
		expect(existsSync(join(repo, "skills/blueprint"))).toBe(false);
		expect(
			existsSync(join(repo, "opencode/generated/skills/rpiv-blueprint")),
		).toBe(false);
		const live = [
			...["skills", "agents", "evals"].flatMap(filesUnder),
			join(repo, "../.claude-plugin/marketplace.json"),
		];
		const mentions = live
			.filter((file) => /blueprint|\bBP-1\b/i.test(readFileSync(file, "utf8")))
			.map((file) => relative(repo, file).replaceAll("\\", "/"));
		expect(mentions).toEqual([]);
	});

	it("implement is model-invocable and still agrees the build", () => {
		const implement = read("skills/implement/SKILL.md");
		const frontmatter = implement.split(/^---\s*$/m)[1];
		expect(frontmatter).not.toMatch(/^disable-model-invocation:\s*true/m);
		for (const skill of [implement, read("skills/plan/SKILL.md")]) {
			expect(skill).not.toMatch(/human-invoked|user-invoked/i);
		}
		const joined = implement.replace(/\s+/g, " ");
		expect(joined).toMatch(
			/Another skill may start this skill as its next step/i,
		);
		expect(joined).toMatch(
			/still agrees the brief, workspace, and build authorization with the developer before any source edit/i,
		);
		expect(read("skills/create-handoff/SKILL.md")).toMatch(
			/^disable-model-invocation:\s*true/m,
		);
	});

	const nextStepLines = (skill) =>
		read(`skills/${skill}/SKILL.md`)
			.split(/\r?\n/)
			.filter((line) => /^\s*\*\*Next step:\*\* `\/rpiv:[a-z-]+/.test(line));

	it.each([
		["discover", "research"],
		["research", "design"],
		["design", "implement"],
		["plan", "implement"],
		["implement", "deep-review"],
		["deep-review", "validate"],
		["validate", "pr"],
		["revise", "implement"],
		["explore", "design"],
	])(
		"each pipeline skill names its next step after /clear: %s",
		(skill, next) => {
			const lines = nextStepLines(skill);
			expect(lines).toHaveLength(1);
			expect(lines[0].match(/`\/rpiv:([a-z-]+)/)[1]).toBe(next);
			expect(lines[0]).toMatch(/run `\/clear` first, then this command/i);
		},
	);

	it("pipeline skills write a handoff and the clear hook is registered", () => {
		// S17 (D37): the stage that ends writes the handoff the clear hook shows once.
		for (const skill of ["discover", "research", "design", "plan", "implement", "deep-review", "validate"]) {
			const [line] = nextStepLines(skill);
			expect(line, skill).toContain('handoff.mjs" write --next');
			expect(line, skill).toContain("unless a stop is pending");
			expect(read(`opencode/generated/skills/rpiv-${skill}/SKILL.md`), skill).toContain("handoff.mjs");
		}
		const sessionStart = JSON.parse(read("hooks/hooks.json")).hooks.SessionStart;
		const clear = sessionStart.filter((entry) => entry.matcher === "clear");
		expect(clear).toHaveLength(1);
		expect(clear[0].hooks).toHaveLength(1);
		expect(clear[0].hooks[0].command).toContain(".claude/hooks/chain-handoff-restore.mjs");
		const compact = sessionStart.filter((entry) => entry.matcher === "compact");
		expect(compact).toHaveLength(1);
		expect(compact[0].hooks[0].command).toContain("session-state-restore.mjs");
	});
});
