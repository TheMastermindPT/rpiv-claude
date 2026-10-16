// tests/append-only.test.mjs — contract tests for skills/_shared/append-only.mjs, the
// owner of candidate-workflow.md's append-only check (does a later version of an
// approved document keep its approval?). The CLI is spawned against files in a
// throwaway folder under the OS temp folder.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "skills/_shared/append-only.mjs");
const NODE = process.execPath;

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-append-only-"));
	dirs.push(dir);
	return dir;
};

const FRONTMATTER = {
	status: "ready",
	lane: "normal",
	lane_reasons: "[paths: skills]",
	last_updated: "2026-10-16",
	content_hash: "aaaa",
};

const SECTIONS = {
	Decisions: ["- D1: keep the check in one helper."],
	"Developer Context": ["- 2026-10-16: approved."],
	"TDD Evidence (implement)": ["- none yet"],
	"Follow-up": ["- none yet"],
};

/** A design document: frontmatter, a title, then each `## ` section. */
const doc = (frontmatter = {}, sections = {}) => {
	const fm = { ...FRONTMATTER, ...frontmatter };
	const lines = [
		"---",
		...Object.entries(fm).map(([k, v]) => `${k}: ${v}`),
		"---",
	];
	lines.push("", "# Design");
	for (const [heading, body] of Object.entries({ ...SECTIONS, ...sections }))
		lines.push("", `## ${heading}`, "", ...body);
	return `${lines.join("\n")}\n`;
};

/** Runs the helper on an approved copy and a later version written to disk. */
const check = (approved, artifact, { env } = {}) => {
	const dir = tempDir();
	const approvedPath = join(dir, "approved-aaaa.md");
	const artifactPath = join(dir, "design.md");
	if (approved !== null) writeFileSync(approvedPath, approved);
	writeFileSync(artifactPath, artifact);
	const run = spawnSync(NODE, [HELPER, approvedPath, artifactPath], {
		encoding: "utf-8",
		env: env ?? process.env,
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

describe("append-only check keeps approval", () => {
	it("keeps it for added lines in the three sections and the bookkeeping frontmatter", () => {
		const result = check(
			doc(),
			doc(
				{
					status: "implemented",
					last_updated: "2026-10-17",
					content_hash: "bbbb",
				},
				{
					"Developer Context": [
						"- 2026-10-16: approved.",
						"- 2026-10-17: accepted S1.",
					],
					"TDD Evidence (implement)": ["- none yet", "- S1 red then green."],
					"Follow-up": ["- none yet", "- revisit the cap."],
				},
			),
		);
		expect(result).toMatchObject({ status: 0, stderr: "" });
		expect(result.stdout).toBe("append-only: keep\n");
	});

	it("keeps it when the only difference is CRLF line endings", () => {
		const approved = doc();
		const result = check(approved, approved.replace(/\n/g, "\r\n"));
		expect(result).toMatchObject({ status: 0, stdout: "append-only: keep\n" });
	});

	it("keeps it for a lane raise recorded in Developer Context", () => {
		const result = check(
			doc(),
			doc(
				{ lane: "rigorous", lane_reasons: "[paths: skills, hooks]" },
				{
					"Developer Context": [
						"- 2026-10-16: approved.",
						"- Lane raised to rigorous: hooks changed.",
					],
				},
			),
		);
		expect(result).toMatchObject({ status: 0, stdout: "append-only: keep\n" });
	});
});

describe("append-only check reopens approval", () => {
	it("reopens on an edited line outside the three sections and names it", () => {
		const result = check(
			doc(),
			doc({}, { Decisions: ["- D1: keep the check in two helpers."] }),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/^append-only: reopen\n/);
		expect(result.stdout).toContain("- D1: keep the check in one helper.");
		expect(result.stdout).toContain("- D1: keep the check in two helpers.");
	});

	it("reopens on a removed line, even inside Developer Context", () => {
		const result = check(doc(), doc({}, { "Developer Context": [] }));
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/removed .*- 2026-10-16: approved\./);
	});

	it("reopens on a changed frontmatter line outside the bookkeeping keys", () => {
		const result = check(doc(), doc({ title: "new" }));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("title: new");
	});

	it("reopens when a lane is lowered, even with a Developer Context entry", () => {
		const result = check(
			doc(),
			doc(
				{ lane: "fast" },
				{
					"Developer Context": [
						"- 2026-10-16: approved.",
						"- Lane lowered to fast.",
					],
				},
			),
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/lane .*not a raise/);
	});

	it("reopens a lane raise that no Developer Context entry records", () => {
		const result = check(doc(), doc({ lane: "rigorous" }));
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(
			/lane raise .*no `## Developer Context` entry/,
		);
	});

	it("reopens lane_reasons changed without a lane raise", () => {
		const result = check(doc(), doc({ lane_reasons: "[paths: skills, docs]" }));
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/lane .*not a raise/);
	});

	it("reopens an added heading that moves approved lines into an allowed section", () => {
		const approved = doc();
		const artifact = approved.replace(
			"## Decisions\n\n",
			"## Decisions\n\n## Developer Context\n\n",
		);
		const result = check(approved, artifact);
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(
			/moved .*- D1: keep the check in one helper\./,
		);
	});

	it("reopens when the approved copy is missing; it never passes by default", () => {
		const result = check(null, doc());
		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(
			/^append-only: reopen\napproved copy missing: .*approved-aaaa\.md\n$/,
		);
	});
});

describe("append-only check is broken, never a result", () => {
	it("exits 2 with a diagnostic when git cannot run", () => {
		const result = check(doc(), doc(), {
			env: { PATH: dirname(NODE), SystemRoot: process.env.SystemRoot ?? "" },
		});
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/^append-only: broken: git/);
	});

	it("exits 2 on a wrong argument count", () => {
		const run = spawnSync(NODE, [HELPER, "only-one.md"], { encoding: "utf-8" });
		expect(run.status).toBe(2);
		expect(run.stderr).toMatch(/^append-only: broken: usage/);
	});
});
