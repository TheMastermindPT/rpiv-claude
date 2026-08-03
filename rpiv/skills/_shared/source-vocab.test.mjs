// source-vocab.test.mjs — union-identity proofs for the owning vocabulary module
// (shared-vocab-union: prove the union before migrating consumers). No dependencies;
// prints "OK" on success.
//
//   node skills/_shared/source-vocab.test.mjs
import assert from "node:assert/strict";
import { CITE_EXT, SOURCE_EXT, TEST_EXCLUDE_RE, extOf, isFixture, isSource, isTest } from "./source-vocab.mjs";

// ── Union identity: CITE_EXT ⊇ both prior copies ─────────────────────────────
{
	// The old citation-grammar whitelist, expanded from its regex alternation.
	const oldCite = ["ts", "tsx", "mjs", "cjs", "js", "jsx", "sql", "css", "scss", "json", "yaml", "yml", "toml", "md"];
	for (const e of oldCite) assert.ok(CITE_EXT.has(e), `CITE_EXT keeps old citation ext .${e}`);
	for (const e of SOURCE_EXT) assert.ok(CITE_EXT.has(e), `CITE_EXT covers source ext .${e}`);
	console.log("OK — CITE_EXT is the union of the two prior copies.");
}

// ── isTest: every OLD JS/TS pattern still matches (no regression) ────────────
{
	for (const p of ["a/b.test.ts", "a/b.spec.js", "x/__tests__/y.tsx", "b.test.mjs", "B.SPEC.TS"]) {
		assert.ok(isTest(p), `old JS/TS pattern still a test: ${p}`);
	}
	for (const p of ["a/b.ts", "src/service.ts", "a/latest.ts", "contest.go", "protester.py"]) {
		assert.ok(!isTest(p), `production file not a test: ${p}`);
	}
	console.log("OK — isTest keeps the JS/TS vocabulary intact.");
}

// ── isTest: per-language conventions now classify (the foo_test.go defect) ───
{
	for (const p of [
		"pkg/foo_test.go", "app/util_test.py", "app/test_util.py", "lib/thing_test.rb",
		"src/FooTest.java", "src/FooTests.cs", "src/BarTest.kt", "spec/models/user_spec.rb",
		"src/test/java/FooIT.java", "lib/parser_test.exs",
	]) {
		assert.ok(isTest(p), `non-JS test convention classifies: ${p}`);
	}
	// The deliberate omission: generic test/ trees do NOT reclassify (JS baselines move).
	assert.ok(!isTest("test/helpers.js"), "generic test/ dir deliberately NOT matched");
	assert.ok(!isTest("pkg/foo.go"), "plain Go source is production");
	assert.ok(!isTest("src/contest.java") && !isTest("app/protest.php"), "lowercase ...test suffix is NOT the CamelCase convention");
	console.log("OK — non-JS test conventions classify; generic dirs stay out.");
}

// ── TEST_EXCLUDE_RE byte-identity (generated depcruise configs must not move) ─
{
	assert.equal(TEST_EXCLUDE_RE, "\\.(test|spec)\\.[a-z]+$|(^|/)__tests__/", "byte-identical to the prior literal");
	console.log("OK — TEST_EXCLUDE_RE unchanged.");
}

// ── extOf / isSource / isFixture smoke ───────────────────────────────────────
{
	assert.equal(extOf("a/b/C.TSX"), "tsx");
	assert.equal(extOf("a/Makefile"), "");
	assert.ok(isSource("x/y.py") && !isSource("x/y.sql"), "source vs citable-only split");
	assert.ok(isFixture("e2e/run.ts") && isFixture("a/__mocks__/m.ts") && !isFixture("src/mockingbird.ts"));
	console.log("OK — extOf/isSource/isFixture.");
}

console.log("OK");
