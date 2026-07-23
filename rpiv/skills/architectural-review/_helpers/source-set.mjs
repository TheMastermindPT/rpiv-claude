// source-set.mjs — the single owner of the "reviewable source file" vocabulary shared
// across the AR analysis helpers (metrics, mutation, semantic) and the generated
// dependency-cruiser config (layer-rules). Extracted as the UNION of the previously
// hand-copied sets after mutation.mjs's copy silently dropped cts/mts (its "same set as
// metrics.mjs" comment had gone false). Importable-only: no CLI, no isMain.
//
// Importable: SOURCE_EXT, isSource, isTest, TEST_EXCLUDE_RE, ENVY_MIN_REFS, ENVY_MIN_RATIO.

export const SOURCE_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
	"py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "scala",
]);

const extOf = (p) => {
	const b = p.slice(p.lastIndexOf("/") + 1);
	const dot = b.lastIndexOf(".");
	return dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
};

/** True if the path's extension is a reviewable source extension. */
export const isSource = (p) => SOURCE_EXT.has(extOf(p));

/** True if the path is a test/spec file or lives under a __tests__ dir. */
export const isTest = (p) =>
	/\.(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)__tests__\//.test(p);

// Regex-source STRING for the generated .dependency-cruiser.cjs (layer-rules), kept
// byte-identical to the prior inline literal so the generated CI config is unchanged.
export const TEST_EXCLUDE_RE = "\\.(test|spec)\\.[a-z]+$|(^|/)__tests__/";

export const ENVY_MIN_REFS = 5; // Fe: a module must be referenced at least this many times to count
export const ENVY_MIN_RATIO = 0.6; // Fe: external refs / (external + own) must clear this
