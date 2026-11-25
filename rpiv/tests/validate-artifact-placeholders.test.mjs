// tests/validate-artifact-placeholders.test.mjs — the leftover-placeholder check (check 3)
// flags TODO / TBD / FIXME only where a placeholder stands, never the same word used inside a
// sentence (odin#18). A finalized report whose gates line said "rg found no TODO markers"
// failed with "placeholder left in prose: TODO" and could not pass without rewording its
// evidence. A real leftover placeholder must still fail the gate.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateArtifact } from "../skills/_shared/validate-artifact.mjs";

const VALIDATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"skills/_shared/validate-artifact.mjs",
);

const FRONTMATTER =
	"---\ndate: x\nauthor: x\ncommit: x\nbranch: x\nrepository: x\ntopic: x\nstatus: ready\nlast_updated: x\nlast_updated_by: x\n---\n";

const root = mkdtempSync(join(tmpdir(), "validate-placeholders-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
/** A ready artifact whose body is `body`, written into the throwaway root. */
const write = (body) => {
	count += 1;
	const file = join(root, `a${count}.md`);
	writeFileSync(file, `${FRONTMATTER}# T\n\n${body}\n`);
	return file;
};
const placeholderErrors = (body) =>
	validateArtifact(write(body), root).errors.filter((e) =>
		e.startsWith("placeholder left in prose"),
	);

describe("a placeholder word used inside a sentence is not a placeholder", () => {
	it.each([
		["the issue's gates line", "rg found no TODO markers."],
		["a word in a sentence", "The TODO list was cleared before review."],
		[
			"all three words as search terms",
			"rg found no TODO, TBD or FIXME output.",
		],
		[
			"a word ending a clause",
			"Gates: rg -n found no FIXME, and lint is clean.",
		],
	])("%s passes", (_label, body) => {
		expect(placeholderErrors(body)).toEqual([]);
	});

	it.each([
		["an inline code span", "We grep for `TODO` markers."],
		["an inline code span at line start", "`FIXME` markers: none."],
		["a fenced code block", "```sh\nrg -n TODO src\n```"],
		["a fenced block holding only the word", "```\nTBD\n```"],
	])("a word inside %s passes", (_label, body) => {
		expect(placeholderErrors(body)).toEqual([]);
	});

	it.each([
		["double quotes", 'Searched for "TODO" and found nothing.'],
		["single quotes", "Searched for 'TBD' and found nothing."],
		["curly quotes", "Searched for “FIXME” and found nothing."],
		["double quotes at line start", '"TODO" markers: none.'],
	])("a word in %s passes", (_label, body) => {
		expect(placeholderErrors(body)).toEqual([]);
	});
});

describe("a placeholder in placeholder position still fails", () => {
	it.each([
		["a bullet holding only the word", "- TODO", "TODO"],
		["a numbered item holding only the word", "1. TBD", "TBD"],
		["a checkbox item", "- [ ] FIXME", "FIXME"],
		["a line starting with the word and a colon", "TODO: fill in", "TODO"],
		["a line starting with the word and a dash", "TBD — decide later", "TBD"],
		["a line starting with the word", "TODO wire this up", "TODO"],
		["a lone line", "FIXME", "FIXME"],
		["an emphasized lone line", "**TBD**", "TBD"],
		["a heading", "## TODO", "TODO"],
		["a block quote", "> TODO: confirm", "TODO"],
		[
			"a table cell holding only the word",
			"| Owner | Due |\n| --- | --- |\n| Ana | TBD |",
			"TBD",
		],
		["a table cell with emphasis", "| Owner | **TODO** |", "TODO"],
		["the value after a label", "Owner: TBD", "TBD"],
		["the value after a bold label", "**Rollback plan:** TBD.", "TBD"],
		["the word alone in brackets", "Release date (TBD) is set later.", "TBD"],
		[
			"a marker inside a sentence",
			"The cache is fine. TODO: add a test.",
			"TODO",
		],
		["a marker with an owner", "Retry logic, FIXME(ana): handle 429.", "FIXME"],
	])("%s fails", (_label, body, token) => {
		expect(placeholderErrors(body)).toEqual([
			`placeholder left in prose: ${token}`,
		]);
	});

	it("a quoted search term does not hide a real placeholder on the same line", () => {
		expect(placeholderErrors('Searched for "TODO". TODO: rerun')).toEqual([
			"placeholder left in prose: TODO",
		]);
	});

	it("a sentence use does not hide a real placeholder on another line", () => {
		expect(placeholderErrors("rg found no TODO markers.\n\n- TBD")).toEqual([
			"placeholder left in prose: TBD",
		]);
	});

	it("an unclosed fence stays prose, so it cannot hide a placeholder", () => {
		expect(placeholderErrors("```\n- TODO")).toEqual([
			"placeholder left in prose: TODO",
		]);
	});
});

describe("unfilled {template tokens} behave as before", () => {
	const tokenErrors = (body) =>
		validateArtifact(write(body), root).errors.filter((e) =>
			e.startsWith("unfilled template token"),
		);

	it("a {token} in prose fails", () => {
		expect(tokenErrors("fill {placeholder} here")).toEqual([
			"unfilled template token in prose: {placeholder}",
		]);
	});

	it("a {token} in a code span passes", () => {
		expect(tokenErrors("see `{placeholder}` here")).toEqual([]);
	});
});

describe("the issue's command line repro", () => {
	it("a ready report saying rg found no TODO markers exits 0", () => {
		const file = write("## Gates\n\nrg found no TODO markers.");
		const r = spawnSync(process.execPath, [VALIDATE, file, "--root", root], {
			encoding: "utf-8",
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});
