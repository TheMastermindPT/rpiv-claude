import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { adaptSupportMarkdown } from "../opencode/adapter.mjs";
import * as lane from "../skills/_shared/lane.mjs";

// Lanes at the front of the chain (S12): the validator check runs the real CLI; the skill
// assertions are prompt regressions that inspect files, not agent compliance.
const repo = fileURLToPath(new URL("../", import.meta.url));
const validator = join(repo, "skills/_shared/validate-artifact.mjs");

describe("lane frontmatter in the artifact validator", () => {
	const root = mkdtempSync(join(tmpdir(), "lane-skills-"));
	const designs = join(root, ".rpiv", "artifacts", "designs");
	mkdirSync(designs, { recursive: true });
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const validate = (name, laneLines) => {
		const file = join(designs, `${name}.md`);
		writeFileSync(
			file,
			`---\ndate: 2026-10-06\nauthor: a\ncommit: c\nbranch: b\nrepository: r\nstatus: in-progress\n${laneLines}---\n\n# T\n\nBody.\n`,
		);
		const run = spawnSync("node", [validator, file, "--root", root], {
			encoding: "utf8",
		});
		return { status: run.status, stderr: run.stderr };
	};

	it.each([
		[
			"unknown lane",
			'lane: quick\nlane_reasons: ["x"]\n',
			"invalid lane: quick (expected fast, normal or rigorous)",
		],
		[
			"wrong case",
			'lane: Fast\nlane_reasons: ["x"]\n',
			"invalid lane: Fast (expected fast, normal or rigorous)",
		],
		["lane without reasons", "lane: fast\n", "missing lane_reasons for lane: fast"],
		[
			"empty reasons",
			'lane: fast\nlane_reasons: ""\n',
			"missing lane_reasons for lane: fast",
		],
		["reasons without lane", 'lane_reasons: ["x"]\n', "lane_reasons without lane"],
		[
			"empty reasons list",
			"lane: fast\nlane_reasons: []\n",
			"missing lane_reasons for lane: fast",
		],
		[
			"spaced empty reasons list",
			"lane: fast\nlane_reasons: [ ]\n",
			"missing lane_reasons for lane: fast",
		],
	])("checks the lane and lane_reasons frontmatter: rejects %s", (name, lines, error) => {
		const result = validate(name.replaceAll(" ", "-"), lines);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(error);
	});

	it.each([
		[
			"a valid lane",
			'lane: rigorous\nlane_reasons: ["sensitive word: auth (src/auth.ts)"]\n',
		],
		["no lane fields", ""],
	])("checks the lane and lane_reasons frontmatter: accepts %s", (name, lines) => {
		expect(validate(name.replaceAll(" ", "-"), lines)).toEqual({
			status: 0,
			stderr: "",
		});
	});

	it("checks the lane and lane_reasons frontmatter: one lane list, owned by lane.mjs", () => {
		expect(lane.LANES).toEqual(["fast", "normal", "rigorous"]);
		expect(Object.isFrozen(lane.LANES)).toBe(true);
		const source = readFileSync(validator, "utf8");
		expect(source).toMatch(
			/import \{[^}]*\bLANES\b[^}]*\} from "\.\/lane\.mjs"/,
		);
		expect(source).not.toMatch(/const LANES =/);
		expect(source).toMatch(/^\/\/\s+- .*`lane`/m);
	});
});

const read = (path) => readFileSync(join(repo, path), "utf8");
const joined = (path) => read(path).replace(/\s+/g, " ");
const workflowTexts = () => {
	const source = read("skills/_shared/candidate-workflow.md");
	return [source, adaptSupportMarkdown(source)].map((text) =>
		text.replace(/\s+/g, " "),
	);
};

describe("lane rules at the front of the chain", () => {
	it("takes the feature lane from frontmatter and never runs a slice below it", () => {
		for (const text of workflowTexts()) {
			for (const rule of [
				/`lane:` with `lane_reasons:`/,
				/discover estimates it, research confirms it/i,
				/the higher of the feature lane and `lane\.mjs --paths`/i,
				/missing `Lane:` line, a missing feature lane, or a broken lane call means `normal`, never `fast`/i,
				/changed `lane` and `lane_reasons` lines that raise the lane/i,
			]) {
				expect(text).toMatch(rule);
			}
		}
	});
	it("discover estimates the lane and asks at most 3 questions in fast", () => {
		const discover = joined("skills/discover/SKILL.md");
		for (const rule of [
			/`lane:` and `lane_reasons:`/,
			/lane\.mjs --paths/,
			/In the fast lane, ask at most 3 questions in total, the intent question included/i,
			/short teach-back/i,
			/raise the lane and continue the full interview/i,
			/`sensitiveWords` in `source-vocab\.mjs`/,
			/keep its diagnostic in `lane_reasons:`/i,
		]) {
			expect(discover).toMatch(rule);
		}
		expect(discover).not.toMatch(/auth, security, crypto, secret, credential/);
		const template = read("skills/discover/templates/frd.md");
		expect(template).toMatch(/^lane: /m);
		expect(template).toMatch(/^lane_reasons: /m);
	});
	it("research uses one codebase-analyzer in fast and confirms the lane", () => {
		const research = joined("skills/research/SKILL.md");
		for (const rule of [
			/In the fast lane, dispatch one `codebase-analyzer`/i,
			/no `scope-tracer` and no `precedent-locator`/i,
			/lane\.mjs --paths/,
			/`lane:` and `lane_reasons:`/,
			/In the fast lane, the next step is `\/rpiv:implement/i,
			/`broken FRD lane: <value>`/,
		]) {
			expect(research).toMatch(rule);
		}
		const unconditional = read("skills/research/SKILL.md")
			.split(/\r?\n/)
			.filter(
				(line) =>
					/scope-tracer/.test(line) &&
					/ALWAYS|in-band|internally dispatches/.test(line) &&
					!/fast lane/i.test(line),
			);
		expect(unconditional).toEqual([]);
	});
	it("design and plan review intent only in the rigorous lane", () => {
		const design = joined("skills/design/SKILL.md");
		for (const rule of [
			/`lane:` and `lane_reasons:`/,
			/Intent review runs only in the rigorous lane/i,
			/The fast lane skips design/i,
			/`lane_reasons: \["no upstream lane"\]`/,
		]) {
			expect(design).toMatch(rule);
		}
		expect(design).not.toMatch(/may still run design/i);
		const plan = joined("skills/plan/SKILL.md");
		expect(plan).toMatch(/Intent review runs only in the rigorous lane/i);
		expect(plan).toMatch(
			/reads the lane from the brief or design frontmatter/i,
		);
		const dispatch = joined("skills/_shared/artifact-review-dispatch.md");
		expect(dispatch).not.toMatch(/keep their own rule until/i);
		expect(dispatch).toMatch(
			/intent reviews in design and plan follow the same table/i,
		);
	});
	it("implement asks once in fast for the contract and the build", () => {
		const implement = joined("skills/implement/SKILL.md");
		expect(implement).toMatch(
			/fast lane[^.]*approve the behaviors and authorize the build in one question/i,
		);
		expect(implement).toMatch(
			/still agrees the brief, workspace, and build authorization/i,
		);
		expect(implement).toMatch(/one question also covers creating the branch/i);
		expect(implement).toMatch(
			/short brief[^.]*`\.rpiv\/artifacts\/designs\/`/i,
		);
	});
	it("skills ask first and say the hook confirms again", () => {
		for (const text of workflowTexts()) {
			expect(text).toMatch(/approval hook then shows a second confirmation/i);
			expect(text).toMatch(/never try to avoid it/i);
		}
		expect(joined("skills/discover/SKILL.md")).toMatch(
			/approval hook then shows a second confirmation/i,
		);
	});
});
