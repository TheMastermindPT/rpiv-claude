// frontmatter.mjs — the single owner of artifact frontmatter parsing for _shared.
// splitFrontmatter was a de-facto shared parser exported from regen-decisions-index.mjs
// but absent from that module's stated Importable contract (L0-02/IX-3) — two consumers
// (validate-artifact.mjs, store.mjs) imported it anyway, and a maintainer trusting the
// regen header would have broken both. It now lives in a module whose name and contract
// advertise it; regen imports parseFrontmatter back for its own decision-file reads.
// Importable-only: no CLI, no isMain.
//
// Importable: parseFrontmatter, splitFrontmatter.

/** Minimal single-line-value frontmatter parser (deterministic; no multi-line values). */
export function parseFrontmatter(text) {
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end === -1) return {};
	const fm = {};
	for (const line of text.slice(3, end).split("\n")) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		fm[m[1]] = v;
	}
	return fm;
}

/** Split an artifact into { fm, body }: parsed frontmatter map + the text after the closing `---`. */
export function splitFrontmatter(text) {
	if (!text.startsWith("---")) return { fm: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { fm: {}, body: text };
	const afterClose = text.indexOf("\n", end + 4);
	const body = afterClose === -1 ? "" : text.slice(afterClose + 1);
	return { fm: parseFrontmatter(text), body };
}
