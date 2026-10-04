import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adaptSupportMarkdown } from "../opencode/adapter.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const skill = "skills/architectural-review/";

// Prompt regressions: these inspect instructions, not runtime agent compliance.
describe("architectural-review instructions", () => {
	it("detects shallow modules by the deletion test with evidence and rescues", () => {
		for (const path of [
			`${skill}references/wave2-lenses.md`,
			`${skill}references/dimension-sweep.md`,
		]) {
			const source = read(path);
			for (const text of [source, adaptSupportMarkdown(source)]) {
				expect(text).toMatch(/\*\*deletion test\*\*/);
				expect(text).toMatch(
					/complexity to its callers unchanged|complexity would move to the callers unchanged/,
				);
				expect(text).toMatch(/verbatim signature/);
				expect(text).toMatch(/>= 2 implementations or a test substitute/);
			}
		}
		expect(read(`${skill}SKILL.md`)).toMatch(
			/shallow \(deletion-test\) candidates/,
		);
	});

	it("loads, suppresses, and records standing decisions without silent drops", () => {
		const main = read(`${skill}SKILL.md`);
		expect(main).toMatch(/`references\/standing-decisions\.md` \(Step 2\.4/);
		expect(main).toMatch(/\*\*Load standing decisions\.\*\*/);
		expect(main).toMatch(/never silently dropped/);
		expect(main).toMatch(/\*\*Durable rejection:\*\*/);

		const reference = read(`${skill}references/standing-decisions.md`);
		expect(reference).toMatch(/`status: accepted`/);
		expect(reference).toMatch(/unreadable: <path> — <diagnostic>/);
		expect(reference).toMatch(/premise no longer holds/);
		expect(reference).toMatch(/Keep local to this review \(Recommended\)/);
		expect(reference).toMatch(
			/skills\/_shared\/decision-ledger\.md` Steps 2-3/,
		);
		expect(reference).toMatch(/regen-decisions-index\.mjs/);
		expect(read(`${skill}references/slop-map.md`)).toMatch(
			/^Standing decisions:/m,
		);
		expect(read("agents/lens-analyst.md")).toMatch(/`Standing decisions` row/);
	});

	it("keeps remediation test strategy on real seams", () => {
		expect(read(`${skill}SKILL.md`)).toMatch(
			/one adapter is a hypothetical seam, two adapters make a real one/,
		);
	});
});
