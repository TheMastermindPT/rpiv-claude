// fences.mjs — the single owner of Markdown code-fence parsing for rpiv's helpers and hooks
// (D26 of .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
//
// Line-anchored and backtick-count-aware: an opener is up to 3 spaces, a run of 3+ backticks
// and an info string holding no backtick; a closer is up to 3 spaces and a run of at least the
// opener's backticks followed only by spaces or tabs. Inside an open fence nothing else opens,
// so a 3-backtick line inside a 4-backtick fence is content. Lines split on \r?\n. Tilde fences
// are out of scope. An opener that never closes is reported, never silently dropped.
//
// Importable: parseFences.

const OPENER = /^ {0,3}(`{3,})([^`]*)$/;
const CLOSER = /^ {0,3}(`{3,})[ \t]*$/;

/**
 * Every fenced code block in `text`.
 * Returns { fences, unterminated }: each fence is { start, end, ticks, info, lang, lines } with
 * 1-based opening/closing line numbers; `unterminated` is null or { start, ticks, info, lang,
 * lines } for an opener never closed (its lines run to the end of the text).
 */
export function parseFences(text) {
	const fences = [];
	let open = null;
	text.split(/\r?\n/).forEach((line, i) => {
		if (open === null) {
			const m = line.match(OPENER);
			if (m) {
				const info = m[2].trim();
				open = {
					start: i + 1,
					ticks: m[1].length,
					info,
					lang: info.split(/\s+/)[0].toLowerCase(),
					lines: [],
				};
			}
			return;
		}
		const close = line.match(CLOSER);
		if (close && close[1].length >= open.ticks) {
			fences.push({
				start: open.start,
				end: i + 1,
				ticks: open.ticks,
				info: open.info,
				lang: open.lang,
				lines: open.lines,
			});
			open = null;
			return;
		}
		open.lines.push(line);
	});
	return { fences, unterminated: open };
}
