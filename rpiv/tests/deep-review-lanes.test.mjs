import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptSupportMarkdown } from "../opencode/adapter.mjs";

// Deep-review by lane (S13): prompt regressions that inspect files, not agent compliance.
const repo = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(repo, path), "utf8");
const joined = (text) => text.replace(/\s+/g, " ");
const linesOf = (text) => text.split(/\r?\n/);

const deepReview = read("skills/deep-review/SKILL.md");
const deepReviewJoined = joined(deepReview);
const deepReviewLines = linesOf(deepReview);
const implement = read("skills/implement/SKILL.md");
const workflow = read("skills/_shared/candidate-workflow.md");

const lineWith = (needle) =>
	deepReviewLines.filter((line) => line.includes(needle));

describe("deep-review depth by lane", () => {
	it("deep-review takes the higher of the passed lane and the diff lane", () => {
		const hint = deepReviewLines.find((line) => /^argument-hint:/.test(line));
		expect(hint).toContain("lane=");
		for (const phrase of [
			/`lane=<lane>`/,
			/lane\.mjs --range/,
			/lane\.mjs --working/,
			/higher of the passed `lane=<lane>` token and `lane\.mjs`/i,
			/`broken passed lane: <value>`/,
			/A missing or broken lane means `normal` \(full depth\), never `fast`/i,
			/`fast` → light, `normal` → full, `rigorous` → rigorous/,
		]) {
			expect.soft(deepReviewJoined).toMatch(phrase);
		}
		expect(deepReview).toMatch(/^Depth: +\{light \| full \| rigorous\}/m);
		expect.soft(hint).toContain("design=");
		expect.soft(deepReviewJoined).toMatch(/`design=<design-path>`/);
		const trailing = lineWith("pre-rendered trailing sections");
		expect(trailing).toHaveLength(1);
		expect.soft(trailing[0]).toContain("Reconciliation Notes");
	});

	it("the fast lane runs gates, one Quality agent per shard and the claim-verifier", () => {
		for (const phrase of [
			/In the fast lane \(light\), dispatch no `integration-scanner`, no `precedent-locator`, no Security lens, no sink-candidate sweep and no Wave-3 agent/i,
			/one Quality `diff-analyst` per shard/i,
			/`skipped \(fast lane\)`/,
			/deterministic pre-wave gates run in every lane/i,
			/claim verification runs in every lane/i,
		]) {
			expect.soft(deepReviewJoined).toMatch(phrase);
		}
		const invariants = deepReviewLines.filter(
			(line) =>
				line.includes("gate Wave-2") ||
				line.includes("Wave-3: 4a + 4b dispatch"),
		);
		expect(invariants.length).toBeGreaterThanOrEqual(2);
		expect
			.soft(invariants.filter((line) => !/fast lane/i.test(line)))
			.toEqual([]);
		const scannerRole = lineWith("`integration-scanner` (Wave-1) —");
		expect(scannerRole).toHaveLength(1);
		expect.soft(scannerRole[0]).toContain("not in the fast lane");
	});

	it("the precedent hard gate names the fast-lane exception", () => {
		const gateLines = deepReviewLines.filter(
			(line) =>
				line.includes("hard gate") ||
				line.includes("MUST NOT begin until the Precedents"),
		);
		expect(gateLines.length).toBeGreaterThan(0);
		expect(gateLines.filter((line) => !/fast lane/i.test(line))).toEqual([]);
		expect(deepReviewJoined).toMatch(/`precedents: skipped \(fast lane\)`/);
		const weighting = linesOf(
			read("skills/deep-review/references/severity-model.md"),
		).filter((line) => line.includes("Severity weighting"));
		expect(weighting).toHaveLength(1);
		expect(weighting[0]).toMatch(/fast lane/i);
	});

	it("the rigorous lane forces Security and the Wave-3 sweeps", () => {
		for (const phrase of [
			/In the rigorous lane, Security runs on every shard, test and docs shards included/i,
			/the interaction sweep \(4b\) and the gap-finder \(4c\) run whenever 2 or more files changed/i,
			/lenses that need input data stay data-gated/i,
		]) {
			expect.soft(deepReviewJoined).toMatch(phrase);
		}
		for (const needle of [
			"docs-only and test-only shards skip Security",
			"fewer than 4 total observations",
			"× review shards (Wave-2)",
		]) {
			const lines = lineWith(needle);
			expect(lines).toHaveLength(1);
			expect.soft(lines[0]).toContain("rigorous");
		}
	});
});

describe("deep-review findings become fix commits", () => {
	it("deep-review routes findings to fix commits and a clear review to validate", () => {
		const next = deepReviewLines.filter((line) =>
			/^\s*\*\*Next step:\*\* `\/rpiv:([a-z-]+)/.test(line),
		);
		expect(next).toHaveLength(1);
		expect(next[0].match(/`\/rpiv:([a-z-]+)/)[1]).toBe("validate");
		expect(next[0]).toMatch(/run `\/clear` first, then this command/i);
		expect
			.soft(next[0])
			.toContain("`/rpiv:validate <design-path> <reviewed-range>`");
		expect(deepReviewJoined).not.toMatch(/fix plan/i);
		expect(deepReviewJoined).not.toMatch(/After 2 fix rounds/i);
		expect(deepReviewJoined).not.toMatch(/rpiv:design "Address findings/);
		expect(
			deepReviewLines.filter((line) =>
				/start a fresh session with `\/new`/.test(line),
			),
		).toEqual([]);
		for (const phrase of [
			/`\/rpiv:implement <review-path>`/,
			/fix commits on the branch/i,
			/After 1 fix round[^.]*`Merge: blocked`[^.]*`ask_user_question`/i,
			/deep-review stays read-only/i,
			/without a `design=` token, validate asks for the contract/i,
			/Before presenting, count the fix commits on the branch that name a review artifact/i,
		]) {
			expect.soft(deepReviewJoined).toMatch(phrase);
		}
	});

	it("implement fixes review findings as fix commits and passes the lane on", () => {
		const implementJoined = joined(implement);
		for (const phrase of [
			/deep-review artifact/i,
			/verified 🔴 and 🟡 findings/,
			/one fix commit per round/i,
			/never amends a slice commit/i,
			/names the review artifact and its fix round/i,
			/each behavior-changing fix starts with its own expected red/i,
			/A deep-review artifact has no approved copy/i,
			/recorded in the owning design's `## Developer Context`, is its approval/i,
			/In the rigorous lane, a fix commit voids the slice's acceptance/i,
		]) {
			expect.soft(implementJoined).toMatch(phrase);
		}
		const next = linesOf(implement).filter((line) =>
			/^\s*\*\*Next step:\*\*/.test(line),
		);
		expect(next).toHaveLength(1);
		expect(next[0]).toContain(
			"`/rpiv:deep-review <candidate-branch-or-range> lane=<lane> design=<design-path>`",
		);
		expect(next[0]).not.toMatch(/once the slice's gates pass/i);
		expect(implementJoined).not.toMatch(
			/once the lane's acceptance is recorded/i,
		);
	});

	it("implement, deep-review and validate state one review timing", () => {
		// S21-review-timing-wording, B114 (D30): one sentence, verbatim, in all three.
		const SENTENCE =
			"Deep-review and validate run once over the whole feature's range after its last authorized slice (rigorous: after that slice's human acceptance).";
		const occurrences = (text) => joined(text).split(SENTENCE).length - 1;
		const nextStep = (text) =>
			linesOf(text).filter((line) => /^\s*\*\*Next step:\*\*/.test(line));
		const validate = read("skills/validate/SKILL.md");
		for (const text of [implement, deepReview, validate]) {
			expect.soft(occurrences(text)).toBe(1);
		}
		const implementNext = nextStep(implement);
		expect(implementNext).toHaveLength(1);
		expect(implementNext[0]).toContain(SENTENCE);
		expect(implementNext[0]).toContain(
			"`/rpiv:deep-review <candidate-branch-or-range> lane=<lane> design=<design-path>`",
		);
		expect(implementNext[0]).not.toMatch(/once the slice's gates pass/i);
		expect(nextStep(validate)[0]).toContain(SENTENCE);
		const scope = deepReviewLines.find((line) =>
			line.startsWith("`$ARGUMENTS` — scope:"),
		);
		expect(scope).toContain(SENTENCE);
		for (const skill of ["implement", "deep-review", "validate"]) {
			expect
				.soft(read(`opencode/generated/skills/rpiv-${skill}/SKILL.md`))
				.toContain(SENTENCE);
		}
	});

	it.each([
		["source", workflow],
		["opencode", adaptSupportMarkdown(workflow)],
	])(
		"the workflow puts deep-review before validate with separate fix commits (%s)",
		(_adapter, text) => {
			expect(text).toMatch(
				/^\| Deep-review depth \| light \| full \| rigorous \|$/m,
			);
			expect(joined(text)).toMatch(/deep-review runs before validate/i);
			expect(joined(text)).toMatch(
				/Deep-review fixes are separate fix commits, one per fix round, that never amend a slice commit/i,
			);
			expect(joined(text)).toMatch(
				/deep-review has its own cap: after 1 fix round/i,
			);
			expect(joined(text)).toMatch(
				/findings left after the fix-round cap \(2 for slice reviews, 1 for deep-review\)/i,
			);
		},
	);
});
