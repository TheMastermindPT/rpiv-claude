// tests/research-routing.test.mjs — two research gaps reported from a real project
// (Odin issues #10 and #11): a checkpoint whose questions the project routes to another
// authority has a path, and facts about outside tools are checked before dispatch,
// since codebase-analyzer has no shell and no web access.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) =>
	readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const research = read("skills/research/SKILL.md");

describe("research checkpoint routed to another authority", () => {
	it("asks the authority the project names and records the question as pending", () => {
		expect(research).toContain(
			"ask that authority through the channel the instructions name, not the developer",
		);
		expect(research).toContain("`routed to <authority>: <question> — pending`");
	});

	it("lets an all-routed checkpoint write, then wait before the handoff", () => {
		expect(research).toContain("A routed question counts as asked for this checkpoint");
		expect(research).toContain(
			"stop before the Step 5 handoff and say which answers it waits for",
		);
		expect(research).toContain("record it as a Step 6 Follow-up");
		expect(research).toContain(
			"a question the project routes to another authority is asked there and counts as asked",
		);
	});

	it("never treats a routed answer as the developer's approval", () => {
		expect(research).toContain(
			"A routed answer is the authority's input, never the developer's approval of anything.",
		);
	});
});

describe("research external tool facts", () => {
	it("checks outside-tool facts before dispatch and passes them in", () => {
		expect(research).toContain(
			"`codebase-analyzer` has no shell and no web access",
		);
		expect(research).toContain("under `Verified external facts:` with where it came from");
	});

	it("marks every other outside-tool claim unverified, never a finding", () => {
		expect(research).toContain("mark any other claim about an outside tool or library `unverified`");
		expect(research).toContain("as `unverified: <claim>`, never as findings");
	});

	it("says the codebase index never holds external docs", () => {
		expect(research).toContain("It indexes this codebase only, never external docs");
	});

	it("matches the analyzer's actual tools: no shell, no web", () => {
		const tools = /^tools: (.*)$/m.exec(
			readFileSync(new URL("../agents/codebase-analyzer.md", import.meta.url), "utf8"),
		)?.[1];
		expect(tools).toBeDefined();
		expect(tools).not.toMatch(/\b(Bash|PowerShell|WebFetch|WebSearch)\b/);
	});
});
