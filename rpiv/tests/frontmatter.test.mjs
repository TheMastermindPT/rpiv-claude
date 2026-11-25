// tests/frontmatter.test.mjs — contract tests for the shared artifact-frontmatter
// parser pair (skills/_shared/frontmatter.mjs). Pins the exact behaviour of the
// definitions moved verbatim out of regen-decisions-index.mjs, so the relocation is
// provably behaviour-preserving (quote-stripping, EOF close, unclosed degrade).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseFrontmatter, splitFrontmatter } from "../skills/_shared/frontmatter.mjs";
import { stampArtifact, validateArtifact } from "../skills/_shared/validate-artifact.mjs";

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

	it("reads a CRLF file's fields like an LF file's, the last field included", () => {
		const crlf = '---\r\na: 1\r\nb: "q"\r\n---\r\nbody\r\n';
		expect(parseFrontmatter(crlf)).toEqual({ a: "1", b: "q" });
		expect(splitFrontmatter(crlf)).toEqual({ fm: { a: "1", b: "q" }, body: "body\r\n" });
	});

	it("reads a lone quote as an empty value", () => {
		expect(parseFrontmatter("---\na: \"\nb: '\n---\n")).toEqual({ a: "", b: "" });
	});

	it("degrades unclosed frontmatter to an empty map", () => {
		expect(parseFrontmatter("---\nunclosed")).toEqual({});
	});
});

// A core.autocrlf checkout gives every artifact CRLF line endings; validate and stamp
// must read it like the LF file git stores.
describe("validate-artifact on a CRLF artifact", () => {
	const TMP = mkdtempSync(join(tmpdir(), "rpiv-fm-crlf-"));
	afterAll(() => rmSync(TMP, { recursive: true, force: true }));
	const LF = [
		"---",
		"date: 2026-11-25",
		'author: "A"',
		"commit: abc",
		"branch: main",
		"repository: r",
		"status: ready",
		"---",
		"",
		"# Doc",
		"",
		"Body.",
		"",
	].join("\n");
	const CRLF = LF.replaceAll("\n", "\r\n");

	it("finds every required field", () => {
		const file = join(TMP, "a.md");
		writeFileSync(file, CRLF);
		expect(validateArtifact(file, TMP).errors).toEqual([]);
	});

	it("stamps a hash the next run accepts, keeping every line CRLF", () => {
		const file = join(TMP, "b.md");
		writeFileSync(file, CRLF);
		const hash = stampArtifact(file);
		const stamped = readFileSync(file, "utf8");
		expect(stamped).toContain(`\r\ncontent_hash: ${hash}\r\n---\r\n`);
		expect(stamped.replaceAll("\r\n", "")).not.toContain("\n");
		expect(parseFrontmatter(stamped).content_hash).toBe(hash);
		expect(validateArtifact(file, TMP).errors).toEqual([]);
	});

	it("still catches a body edited after the stamp", () => {
		const file = join(TMP, "c.md");
		writeFileSync(file, CRLF);
		stampArtifact(file);
		writeFileSync(file, readFileSync(file, "utf8").replace("Body.", "Edited."));
		expect(validateArtifact(file, TMP).errors).toEqual([
			"content_hash mismatch: body edited after finalization (re-stamp if intentional)",
		]);
	});

	it("catches an edit to a file stamped LF and checked out CRLF", () => {
		const file = join(TMP, "d.md");
		writeFileSync(file, LF);
		stampArtifact(file);
		const checkedOut = readFileSync(file, "utf8").replaceAll("\n", "\r\n");
		writeFileSync(file, checkedOut);
		expect(validateArtifact(file, TMP).errors).toEqual([]);
		writeFileSync(file, checkedOut.replace("Body.", "Edited."));
		expect(validateArtifact(file, TMP).errors).toEqual([
			"content_hash mismatch: body edited after finalization (re-stamp if intentional)",
		]);
	});
});
