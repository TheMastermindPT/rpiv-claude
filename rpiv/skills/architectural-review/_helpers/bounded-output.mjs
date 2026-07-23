// bounded-output.mjs — the single owner of the `---label---` stdout block grammar the
// AR helpers speak: `key: value` header lines, then `---label---` blocks of rows, with
// a byte/line budget and a `(... N more truncated ...)` marker. Both sides live here —
// makeBoundedEmitter (producers: metrics, stability) AND parseInto/parseBlocks (consumer:
// warrant) — so a format change breaks loudly at the shared module instead of silently
// across a private regex. Extracted from the byte-identical closures at metrics.mjs:1053
// and stability.mjs:359 and the private parser at warrant.mjs:64. Importable-only.
//
// Importable: makeBoundedEmitter, parseInto, parseBlocks.

// Bounded block emitter. `head` seeds the byte budget (producers emit `key: value`
// header lines first; truncation math must count them, matching the extracted closures).
// Returns { block, body }: call block(label, rows) per block, then body() for the
// full accumulated output.
export const makeBoundedEmitter = (lineCap, byteCap, head = "") => {
	let body = head;
	const budget = { bytes: head.length };
	const block = (label, rows) => {
		let out = `---${label}---\n`;
		let count = 0;
		for (const row of rows) {
			const next = `${row}\n`;
			if (budget.bytes + out.length + next.length > byteCap) break;
			if (count >= lineCap) break;
			out += next;
			count += 1;
		}
		if (count < rows.length) out += `(... ${rows.length - count} more truncated ...)\n`;
		budget.bytes += out.length;
		body += out;
	};
	return { block, body: () => body };
};

// Parser for the same grammar. Headers (`key: value`) are only read before the FIRST
// block of a source — block rows like `table:foo\twriters=1` also contain colons, so
// header detection must stop once blocks begin. Mutates `blocks`/`headers` in place so
// multiple sources (stdin + a --semantic file) merge, matching warrant's two-call usage.
export const parseInto = (text, blocks, headers) => {
	let cur = null;
	for (const line of text.split(/\r?\n/)) {
		const b = line.match(/^---(.+)---\s*$/);
		if (b) {
			cur = b[1];
			blocks[cur] ??= [];
			continue;
		}
		if (cur === null) {
			const h = line.match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
			if (h) headers[h[1]] = h[2];
			continue;
		}
		if (line.trim()) blocks[cur].push(line);
	}
};

/** Convenience single-source form: returns fresh { blocks, headers }. */
export const parseBlocks = (text) => {
	const blocks = {};
	const headers = {};
	parseInto(text, blocks, headers);
	return { blocks, headers };
};
