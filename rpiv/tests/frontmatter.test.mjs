// tests/frontmatter.test.mjs — contract tests for the shared artifact-frontmatter
// parser pair (skills/_shared/frontmatter.mjs). Pins the exact behaviour of the
// definitions moved verbatim out of regen-decisions-index.mjs, so the relocation is
// provably behaviour-preserving (quote-stripping, EOF close, unclosed degrade).

import { describe, expect, it } from "vitest";
import { parseFrontmatter, splitFrontmatter } from "../skills/_shared/frontmatter.mjs";

describe("parseFrontmatter / splitFrontmatter", () => {
	it("parses single-line values and strips wrapping quotes", () => {
		expect(parseFrontmatter('---\na: 1\nb: "q"\n---\nbody')).toEqual({ a: "1", b: "q" });
	});

	it("splits into fm + body after the closing ---", () => {
		expect(splitFrontmatter('---\na: 1\nb: "q"\n---\nbody')).toEqual({
			fm: { a: "1", b: "q" },
			body: "body",
		});
	});

	it("passes text with no frontmatter through as body", () => {
		expect(splitFrontmatter("no fm")).toEqual({ fm: {}, body: "no fm" });
	});

	it("handles a closing --- at EOF with no trailing newline", () => {
		expect(splitFrontmatter("---\na: 1\n---")).toEqual({ fm: { a: "1" }, body: "" });
	});

	it("degrades unclosed frontmatter to an empty map", () => {
		expect(parseFrontmatter("---\nunclosed")).toEqual({});
	});
});
