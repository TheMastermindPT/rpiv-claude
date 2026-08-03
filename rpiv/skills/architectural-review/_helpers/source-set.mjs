// source-set.mjs — the AR helpers' import surface for the "reviewable source file"
// vocabulary (metrics, mutation, semantic, layer-rules). The vocabulary itself is
// OWNED by skills/_shared/source-vocab.mjs (shared-vocab-union: one owner for both
// skills — the citation grammar consumes the same extension sets); this module
// re-exports it unchanged so existing consumers keep their import path, and holds
// the AR-specific Fe thresholds that are metrics calibration, not language vocab.
// Importable-only: no CLI, no isMain.
//
// Importable: SOURCE_EXT, isSource, isTest, isFixture, TEST_EXCLUDE_RE,
//             ENVY_MIN_REFS, ENVY_MIN_RATIO.

export {
	SOURCE_EXT,
	extOf,
	isFixture,
	isSource,
	isTest,
	TEST_EXCLUDE_RE,
} from "../../_shared/source-vocab.mjs";

export const ENVY_MIN_REFS = 5; // Fe: a module must be referenced at least this many times to count
export const ENVY_MIN_RATIO = 0.6; // Fe: external refs / (external + own) must clear this
