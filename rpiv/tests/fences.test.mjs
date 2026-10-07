// tests/fences.test.mjs — contract tests for the shared fence parser in
// skills/_shared/fences.mjs (slice S6-fence-rule, D26, B93, of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).

import { describe, expect, it } from "vitest";

import { parseFences } from "../skills/_shared/fences.mjs";

const T = "```";
const F = "````";

describe("S6 fence parser (B93)", () => {
	it("parses fences by line, backtick count and info string", () => {
		const text = `a\n${T}js title=x\nl1\nl2\n${T}\nb`;
		const expected = {
			fences: [
				{
					start: 2,
					end: 5,
					ticks: 3,
					info: "js title=x",
					lang: "js",
					lines: ["l1", "l2"],
				},
			],
			unterminated: null,
		};
		expect(parseFences(text)).toEqual(expected);
		expect(parseFences(text.replaceAll("\n", "\r\n"))).toEqual(expected);

		expect(parseFences(`${F}md\n${T}js\nx\n${T}\n${F}`)).toEqual({
			fences: [
				{
					start: 1,
					end: 5,
					ticks: 4,
					info: "md",
					lang: "md",
					lines: [`${T}js`, "x", T],
				},
			],
			unterminated: null,
		});

		// A longer closer closes; a closer with trailing text is content.
		expect(parseFences(`${T}\nx\n${T}\`\``).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "", lang: "", lines: ["x"] },
		]);
		expect(parseFences(`${T}\nx\n${T} y\n${T}`).fences).toEqual([
			{
				start: 1,
				end: 4,
				ticks: 3,
				info: "",
				lang: "",
				lines: ["x", `${T} y`],
			},
		]);

		// Up to 3 spaces of indentation open and close; 4 do not open.
		expect(parseFences(`   ${T}\nx\n   ${T}`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "", lang: "", lines: ["x"] },
		]);
		expect(parseFences(`    ${T}\nx\n${T}`)).toEqual({
			fences: [],
			unterminated: { start: 3, ticks: 3, info: "", lang: "", lines: [] },
		});

		// A backtick in the info string, or only two backticks, is no fence.
		expect(parseFences(`${T}a\`b\nx`)).toEqual({
			fences: [],
			unterminated: null,
		});
		expect(parseFences("``\nx\n``")).toEqual({
			fences: [],
			unterminated: null,
		});

		expect(parseFences(`${T}\n${T}`)).toEqual({
			fences: [{ start: 1, end: 2, ticks: 3, info: "", lang: "", lines: [] }],
			unterminated: null,
		});

		expect(parseFences(`x\n${T}py\na\nb`)).toEqual({
			fences: [],
			unterminated: {
				start: 2,
				ticks: 3,
				info: "py",
				lang: "py",
				lines: ["a", "b"],
			},
		});

		expect(parseFences(`${T}JS\nx\n${T}`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "JS", lang: "js", lines: ["x"] },
		]);

		// Pins added after S6 mutation (developer choice): a closer starts the line, may end in
		// spaces or tabs, carries nothing else; the info string is trimmed.
		expect(parseFences(`${T}\ntext ${T}\n${T}`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "", lang: "", lines: [`text ${T}`] },
		]);
		expect(parseFences(`${T}\nx\n${T} \t`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "", lang: "", lines: ["x"] },
		]);
		expect(parseFences(`${T}\n${T}y\n${T}`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "", lang: "", lines: [`${T}y`] },
		]);
		expect(parseFences(`${T} js \nx\n${T}`).fences).toEqual([
			{ start: 1, end: 3, ticks: 3, info: "js", lang: "js", lines: ["x"] },
		]);
	});
});
