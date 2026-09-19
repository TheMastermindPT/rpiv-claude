// source-vocab.mjs — the single owner of the language/file vocabulary shared across
// BOTH skills' helpers (shared-vocab-union): which extensions count as reviewable
// source, which extensions a citation can point at, and which paths are tests.
//
// Extracted when two copies were found with OPPOSITE language postures: the AR
// helpers' source set spans ten non-JS languages (source-set.mjs) while the
// citation grammar's extension whitelist was JS/web-only — so on a Python/Go
// target the prose-cite ambiguity gates silently no-oped. The values here are the
// UNION of the prior copies; `skills/architectural-review/_helpers/source-set.mjs`
// re-exports them so its consumers (metrics, mutation, semantic, layer-rules)
// keep their import path.
//
// Importable-only: no CLI, no isMain.
// Importable: SOURCE_EXT, CITE_EXT, extOf, isSource, isTest, isFixture, TEST_EXCLUDE_RE.

/** Extensions that count as reviewable source code (metrics, mutation, semantic). */
export const SOURCE_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
	"py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "scala",
]);

/**
 * Extensions a `file.ext:line` citation can point at: every source extension PLUS
 * the non-code citation targets the old citation-grammar whitelist carried
 * (SQL, styles, config, docs). Strict union of the two prior copies — no novelties.
 */
export const CITE_EXT = new Set([
	...SOURCE_EXT,
	"sql", "css", "scss", "json", "yaml", "yml", "toml", "md",
]);

/** Lower-cased extension of a path ("" when none). */
export const extOf = (p) => {
	const b = p.slice(p.lastIndexOf("/") + 1);
	const dot = b.lastIndexOf(".");
	return dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
};

/** True if the path's extension is a reviewable source extension. */
export const isSource = (p) => SOURCE_EXT.has(extOf(p));

/**
 * True if the path is a test file by ANY supported language's convention — not just
 * the JS/TS `.test./.spec./__tests__` idioms. The per-language FILE patterns are
 * unambiguous; generic `test/`/`tests/`/`spec/` DIRECTORY matching is deliberately
 * NOT included (a JS repo's `test/` utilities dir would silently reclassify and move
 * every metrics baseline) — `src/test/` is the one directory convention included
 * because it is the Maven/Gradle standard and collides with nothing.
 */
export const isTest = (p) =>
	/\.(test|spec)\.[a-z]+$/i.test(p) || // JS/TS: foo.test.ts, foo.spec.js
	/(^|\/)__tests__\//.test(p) || // JS/TS: __tests__ trees
	/_tests?\.(go|py|rb|ex|exs)$/i.test(p) || // Go/Python/Ruby/Elixir: foo_test.go, foo_test.py
	/(^|\/)test_[^/]*\.py$/i.test(p) || // Python: test_foo.py
	/Tests?\.(java|kt|kts|cs|scala|swift|php)$/.test(p) || // JVM/C#/Swift/PHP: FooTest.java, FooTests.cs (case-sensitive — else contest.java classifies)
	/_spec\.rb$/i.test(p) || // Ruby: foo_spec.rb
	/(^|\/)src\/test\//.test(p); // Maven/Gradle standard test tree

/**
 * True if the path lives in a conventional test-SUPPORT directory: e2e harnesses,
 * fixture or mock trees. Deliberately separate from isTest — that names files a
 * runner EXECUTES, this names files that exist to FEED tests, where near-identical
 * shapes are the point rather than a defect.
 */
export const isFixture = (p) =>
	/(^|\/)(e2e|fixtures?|__fixtures__|__mocks__|mocks|testing)(\/|$)/i.test(p);

// Regex-source STRING for the generated .dependency-cruiser.cjs (layer-rules), kept
// byte-identical to the prior inline literal so the generated CI config is unchanged.
// Narrower than isTest ON PURPOSE: dependency-cruiser only cruises JS/TS, so the
// non-JS conventions above would be dead weight in a generated config.
export const TEST_EXCLUDE_RE = "\\.(test|spec)\\.[a-z]+$|(^|/)__tests__/";
