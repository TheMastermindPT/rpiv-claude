// review-sections.mjs — replace a deep-review store's pre-rendered trailing sections
// (Reconciliation Notes, Impact, Precedents, ...). The citation gate can flag a bare
// path inside them, and `store init` refuses to re-init, so without this the only fix
// was deleting review.json and rebuilding. Pure: store.mjs owns the file IO.
//
// Importable-only: no CLI, no isMain.

const isStringArray = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");

/** The store with `review.sections` replaced; findings and other metadata untouched. */
export function withReviewSections(store, sections) {
	if (!isStringArray(sections)) throw new Error("update --sections: sections must be a string array");
	if (store?.review == null || typeof store.review !== "object") {
		throw new Error("update --sections: not a DR review store");
	}
	return { ...store, review: { ...store.review, sections } };
}
