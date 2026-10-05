import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../skills/", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
// "Joined text": every run of whitespace as one space, so wrapped phrases match.
const joinWhitespace = (text) => text.replace(/\s+/g, " ");
const paragraphs = (text) => text.split(/\r?\n\s*\r?\n/);

// Prompt regressions: these inspect instructions, not runtime agent compliance.
describe("candidate execution instructions", () => {
	it("retains availability-based checks without granting validation write access", () => {
		const source = read("_shared/candidate-workflow.md");
		expect(source).toMatch(/Run available test-quality lint/i);
		expect(source).toMatch(/connected CodeScene.*review/i);
		expect(source).toMatch(/applicable mutation command.*behavior-changing/i);
		expect(read("validate/SKILL.md")).toMatch(/read-only/i);
	});

	it("defines contract identity as the whole-document hash with an approved copy", () => {
		const source = read("_shared/candidate-workflow.md");
		for (const phrase of [
			/There is no hash per section/,
			/approved copy/i,
			/approved-<content_hash>\.md/,
			/git diff --no-index/,
			/append-only check/i,
			/Any other change reopens approval/,
			/missing approved copy fails/i,
			/stale(?:,| unless)[^.]*append-only check/i,
		]) {
			expect(source).toMatch(phrase);
		}
		for (const heading of [
			"## Developer Context",
			"## TDD Evidence (implement)",
			"## Follow-up",
		]) {
			expect(source).toContain(heading);
		}
		const joined = joinWhitespace(source);
		for (const phrase of [
			/nothing but added lines/i,
			/latest approved copy/i,
			/--ignore-cr-at-eol/,
			/broken check/i,
			/candidate identity is unchanged/i,
			/stamp[^.]*before saving/i,
		]) {
			expect(joined).toMatch(phrase);
		}
		for (const field of [
			"status",
			"last_updated",
			"last_updated_by",
			"last_updated_note",
			"content_hash",
		]) {
			expect(joined).toContain(`\`${field}\``);
		}
		const slice = source.slice(
			source.indexOf("## Slice Loop"),
			source.indexOf("## Integration"),
		);
		expect(slice).toMatch(/append-only check/i);
	});

	it("no skill or agent describes a per-section contract hash", () => {
		const perSection = [
			/normative[^.]*hash/i,
			/\b(?:hash(?:es)?|pin(?:s|ned)?)\b[^.]*normative/i,
			/section hash/i,
			/\b(?:approved-contract|approval|required|missing) pin\b/i,
			/pinned content/i,
			/\bre-pin/i,
		];
		const matches = (text) => perSection.some((rule) => rule.test(text));
		const hits = [];
		for (const dir of ["skills", "agents"]) {
			const base = new URL(`../${dir}/`, import.meta.url);
			for (const file of readdirSync(base, { recursive: true })) {
				const path = file.replaceAll("\\", "/");
				if (!path.endsWith(".md")) continue;
				const text = readFileSync(new URL(path, base), "utf8");
				text.split(/\r?\n/).forEach((line, index) => {
					if (matches(line)) hits.push(`${dir}/${path}:${index + 1}`);
				});
				if (matches(joinWhitespace(text))) hits.push(`${dir}/${path} (joined)`);
			}
		}
		expect(hits).toEqual([]);
	});

	it("accepts a short approved input and stops for exact-revision acceptance", () => {
		const source = read("implement/SKILL.md");
		expect(source).toMatch(/approved (?:short )?brief/i);
		expect(source).toMatch(/allowed-tools:.*Agent.*ask_user_question/);
		expect(source).toMatch(/human accepts the exact candidate revision/i);
		expect(source).not.toMatch(
			/implement every phase|Trust that completed work is done|stop immediately after that phase's checks pass/i,
		);
	});

	it("keeps observed red-green separate from independent review and refactoring", () => {
		const source = read("implement/SKILL.md");
		expect(source).toMatch(
			/observed[\s\S]*Expected red[\s\S]*minimal[\s\S]*green/i,
		);
		expect(source).toMatch(/separate independent review\/refactor gate/i);
		expect(source).toMatch(/mode=candidate/);
		expect(source).toMatch(/re-?run.*tests.*reviews/i);
	});

	it.each(["implement", "validate", "revise"])(
		"%s verifies document hashes rather than trusting prior completion",
		(name) => {
			const source = read(`${name}/SKILL.md`);
			expect(source).toMatch(/on (?:start and )?resume/i);
			expect(source).toContain("content_hash");
			expect(source).toMatch(/validate-artifact\.mjs/);
			expect(source).toMatch(/append-only check/i);
			expect(source).toMatch(/approved copy/i);
			const resume = paragraphs(source).find(
				(paragraph) =>
					/on (?:start and )?resume/i.test(paragraph) &&
					paragraph.includes("content_hash"),
			);
			expect(resume).toMatch(/append-only check/i);
			expect(resume).toMatch(/approved copy/i);
			expect(resume).not.toMatch(/evidence and progress/i);
			if (name === "validate") {
				const reviews = paragraphs(source).find((paragraph) =>
					paragraph.includes("Match every independent review"),
				);
				expect(reviews).toMatch(/append-only check/i);
			}
		},
	);

	it("validates read-only and leaves missing historical proof as a gap", () => {
		const source = read("validate/SKILL.md");
		expect(source).toMatch(/read-only/i);
		expect(source).toMatch(/no verified candidate[\s\S]*blocked/i);
		expect(source).toMatch(/missing.*red.*(?:fail|gap)/i);
		expect(source).not.toMatch(
			/auto-fix chosen|Offer to auto-fix|fix them in-place|pre-TDD plan.*skip the evidence audit|or the plan is pre-TDD/i,
		);
	});

	it.each(["implement", "validate"])(
		"%s follows project gates without hardcoded tool mandates",
		(name) => {
			const source = read(`${name}/SKILL.md`);
			expect(source).toMatch(/project.*gate/i);
			expect(source).toMatch(/unavailable/);
			expect(source).toMatch(/broken/);
			expect(source).not.toMatch(
				/score.*(?:9\.0|9\.3)|npm run mutate:plan|make check test|mutation testing \(mandatory|never fail on absence/i,
			);
		},
	);

	it("revises pending slices without deriving contracts or proof from old fences", () => {
		const source = read("revise/SKILL.md");
		expect(source).toMatch(/split, merge, or reorder/i);
		expect(source).toMatch(/intent IDs/);
		expect(source).toContain("Deferred Work");
		expect(source).toMatch(/historical proposals/i);
		expect(source).toMatch(/mode=intent/);
		expect(source).not.toMatch(
			/derive.*from.*code fence|implemented pre-TDD; behavior covered by existing checked criteria|omit.*to run all phases sequentially/i,
		);
	});

	it("reports identity, acceptance, and integrated proof separately from document readiness", () => {
		const source = read("validate/SKILL.md");
		const template = read("validate/templates/validation.md");
		expect(source).toContain("enum: [in-progress, in-review, ready]");
		expect(source).toContain("enum: [pass, fail]");
		expect(source).toMatch(/separate integration (?:consent|authorization)/i);
		expect(source).toMatch(/integrated-tree validation/i);
		for (const field of [
			"artifact_path",
			"slice_id",
			"repository_path",
			"base_commit",
			"candidate_revision",
			"evidence_paths",
		]) {
			expect(template).toContain(field);
		}
		expect(template).toMatch(/Human Acceptance/);
		expect(template).toMatch(/Integration Authorization/);
		expect(template).toMatch(/Remaining Scope/);
		expect(template).not.toMatch(
			/Ready to commit|Pre-TDD plan.*not applicable|No regressions detected/,
		);
	});
});
