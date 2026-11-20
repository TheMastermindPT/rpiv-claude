// test-contract.mjs — the one reader of a slice's Test Contract. It owns the Test line
// grammar that test-contract-authoring.md writes down: a Test line is `; `-separated
// clauses, each one of
//   `T` [and `T`]* -> `P`         titles in one file
//   `T` in `P` [prose]            one title in one file
//   rewrite in `P` (`T`)          one rewritten title
//   `P` [, `P`]* [prose]          whole files, no title named (the file form)
// Anything else is unreadable: slice-preflight.mjs lists it as `unchecked:`, and
// validate-artifact.mjs --finalizing rejects it in a section not yet approved.
//
// Importable (pure): parseTestContract, contractSections, contractProblems, isTestPath.

import { parseFences } from "./fences.mjs";
import { isTest } from "./source-vocab.mjs";

const HEADING = /^(#{2,6})\s+(.*)$/;
const CONTRACT = /^Test Contract:\s*(\S.*)$/;
// `**Behavior B1**: x`, also with a parenthetical after the ID and/or the colon inside
// the bold (`**Behavior B1 (X-1):** x`), as briefs from the design skill write it. The
// word Behavior may be left out (`**B1: x**`) when the ID holds a digit, so a bold
// label such as `**Note:**` is never read as a behavior.
const BEHAVIOR =
	/^- \*\*(?:Behavior ([A-Za-z0-9-]+)|([A-Za-z]+-?\d[A-Za-z0-9-]*))(?: \(.*?\))?(?:\*\*:|:\*\*|:) (.+)$/;
const EXEMPT = /^- \*\*TDD-exempt\*\*/;
const SUB = /^ {2}- (Tests?|Expected red[^:]*):\s*(.*)$/;
// One item of the nested list under a `Tests:` sub-bullet, read as its own Test clause.
const NESTED = /^ {4,}- (.*)$/;
const RED_AT = /\bat `?([0-9a-f]{7,40})`?/gi;
const PIN = /^none\s*[—-]\s*pin\b/i;

/** Lines outside fenced code blocks (fences.mjs owns fence parsing), 1-based. */
const unfenced = (text) => {
	const lines = text.split(/\r?\n/);
	const { fences, unterminated } = parseFences(text);
	const inside = new Set();
	const mark = (start, end) => {
		for (let no = start; no <= end; no++) inside.add(no);
	};
	for (const fence of fences) mark(fence.start, fence.end);
	if (unterminated)
		throw new Error(
			`unterminated code fence opened at line ${unterminated.start} of the brief`,
		);
	return lines
		.map((line, i) => ({ line, no: i + 1 }))
		.filter(({ no }) => !inside.has(no));
};

/** The body lines of the section that starts at heading index `i` of `lines`. */
const sectionBody = (lines, i, level) => {
	const body = [];
	for (const entry of lines.slice(i + 1)) {
		const h = HEADING.exec(entry.line);
		if (h && h[1].length <= level) break;
		body.push(entry);
	}
	return body;
};

/** Every `Test Contract: <id>` section of `text`, in order: `{ id, line, body }`. */
export const contractSections = (text) => {
	const lines = unfenced(text);
	return lines.flatMap((entry, i) => {
		const h = HEADING.exec(entry.line);
		const c = h && CONTRACT.exec(h[2].trim());
		return c
			? [
					{
						id: c[1].trim(),
						line: entry.no,
						body: sectionBody(lines, i, h[1].length),
					},
				]
			: [];
	});
};

/** The section of `sliceId`; throws unless exactly one. */
const contractSection = (text, sliceId) => {
	const found = contractSections(text).filter((s) => s.id === sliceId);
	if (found.length === 0)
		throw new Error(`no \`### Test Contract: ${sliceId}\` section`);
	if (found.length > 1)
		throw new Error(
			`${found.length} \`### Test Contract: ${sliceId}\` sections`,
		);
	return found[0].body;
};

const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The parenthesis depth and code-span state after reading `ch`. */
const scan = (state, ch) => {
	if (ch === "`") return { ...state, code: !state.code };
	if (state.code) return state;
	if (ch === "(") return { ...state, depth: state.depth + 1 };
	if (ch === ")") return { ...state, depth: Math.max(0, state.depth - 1) };
	return state;
};

/** True when `text[i]` is a clause-separating `; ` outside parentheses and code. */
const splitsAt = (state, text, i) =>
	!state.code &&
	state.depth === 0 &&
	text[i] === ";" &&
	/\s/.test(text[i + 1] ?? "");

/** A Test line's clauses: split on `; ` only outside parentheses and code spans. */
const clauses = (text) => {
	const out = [];
	let state = { depth: 0, code: false };
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (splitsAt(state, text, i)) {
			out.push(text.slice(start, i));
			start = i + 1;
		} else state = scan(state, text[i]);
	}
	out.push(text.slice(start));
	return out.map((c) => c.trim()).filter(Boolean);
};
const withoutParens = (text) =>
	text.replace(/`[^`]*`|\([^()]*\)/g, (m) => (m.startsWith("`") ? m : " "));

/** `T` [and `T`]* -> `P`: every title before the last arrow, one path after it. */
const arrowClause = (clause) => {
	const arrow = clause.lastIndexOf("->");
	if (arrow === -1) return null;
	const titles = ticked(withoutParens(clause.slice(0, arrow)));
	const path = ticked(clause.slice(arrow + 2))[0];
	const readable = titles.length && path && titles.every((t) => t.trim());
	return readable ? titles.map((title) => ({ title, path })) : null;
};

const IN_FORM = /^`([^`]+)`\s+in\s+`([^`]+)`/;
const REWRITE_FORM = /^rewrite in `([^`]+)`\s*\(`([^`]+)`\)/;

/** `T` in `P`, or rewrite in `P` (`T`). */
const wordClause = (clause) => {
	const inForm = IN_FORM.exec(clause);
	if (inForm) return [{ title: inForm[1], path: inForm[2] }];
	const rewrite = REWRITE_FORM.exec(clause);
	return rewrite ? [{ title: rewrite[2], path: rewrite[1] }] : null;
};

/** True for a code span that names a file: no spaces, an extension, and either a
    folder or a test file's name (so `Schema.SchemaError` or `error.cause` is not one). */
export const isTestPath = (token) =>
	/^[\w.@~+/-]+\.[A-Za-z0-9]+$/.test(token) &&
	(token.includes("/") || isTest(token));

const LEAD_PATH = /^`([^`]+)`/;
const NEXT_PATH = /^\s*(?:,\s*(?:and\s+)?|and\s+)`([^`]+)`/;

/** `P` [, `P`]* then prose: the leading run of file paths, each a whole-file test. */
const fileClause = (clause) => {
	const paths = [];
	let rest = clause;
	let m = LEAD_PATH.exec(rest);
	while (m && isTestPath(m[1])) {
		paths.push(m[1]);
		rest = rest.slice(m[0].length);
		m = NEXT_PATH.exec(rest);
	}
	return paths.length ? paths.map((path) => ({ path })) : null;
};

const readClause = (clause) => {
	if (clause.includes("``")) return null;
	return arrowClause(clause) ?? wordClause(clause) ?? fileClause(clause);
};

/** Record a Test sub-bullet's tests, or its unreadable clauses as unchecked. */
const addTests = (behavior, text, no) => {
	const parts = clauses(text);
	if (parts.length === 0) return;
	behavior.hasTest = true;
	for (const clause of parts) {
		const tests = readClause(clause);
		if (tests) behavior.tests.push(...tests);
		else behavior.unchecked.push({ line: no, text: clause });
	}
};

/** Record an Expected-red sub-bullet: a pin marker and the revisions it names. */
const addRed = (behavior, text) => {
	if (PIN.test(text)) behavior.pin = true;
	// "none observable … at <sha>" names a revision where red was NOT seen: no re-proof.
	if (/^none\b/i.test(text)) return;
	for (const m of text.matchAll(RED_AT)) {
		const sha = m[1].toLowerCase();
		if (!behavior.redAt.includes(sha)) behavior.redAt.push(sha);
	}
};

const newBehavior = (id, line) => ({
	id,
	line,
	tests: [],
	unchecked: [],
	pin: false,
	redAt: [],
	hasTest: false,
});

/** Apply one contract-section line to the behaviors and TDD exemptions read so far. */
const readLine = (parsed, entry) => {
	const nested = parsed.listing && NESTED.exec(entry.line);
	if (nested) {
		addTests(parsed.current, nested[1], entry.no);
		return;
	}
	parsed.listing = false;
	readEntry(parsed, entry);
};

/** A behavior header, TDD exemption, or Test / Expected-red sub-bullet. */
const readEntry = (parsed, { line, no }) => {
	const b = BEHAVIOR.exec(line);
	if (b) {
		parsed.current = newBehavior(b[1] ?? b[2], no);
		parsed.behaviors.push(parsed.current);
		return;
	}
	if (EXEMPT.test(line)) {
		parsed.exempt.push(no);
		parsed.current = null;
		return;
	}
	const sub = SUB.exec(line);
	if (!sub || !parsed.current) return;
	if (!sub[1].startsWith("Test")) return addRed(parsed.current, sub[2]);
	addTests(parsed.current, sub[2], no);
	parsed.listing = true;
};

/** The behaviors and TDD exemptions of one section body. */
const parseBody = (body) => {
	const parsed = { behaviors: [], exempt: [], current: null, listing: false };
	for (const entry of body) readLine(parsed, entry);
	return { behaviors: parsed.behaviors, exempt: parsed.exempt };
};

/** The Test Contract of `sliceId` in brief `text`:
    `{ behaviors: [{ id, line, tests: [{ path, title? }], unchecked: [{ line, text }],
    pin, redAt: [sha] }], exempt: [line] }`. A test without `title` is a whole file.
    Throws on a missing or duplicate section. */
export const parseTestContract = (text, sliceId) =>
	parseBody(contractSection(text, sliceId));

/** What a reader cannot check in one section body: `[{ line, problem }]`. A behavior
    without a Test line is fine: its tests are found at the candidate by the behavior ID
    that starts their titles (slice-preflight.mjs). */
export const contractProblems = (body) =>
	parseBody(body).behaviors.flatMap((b) =>
		b.unchecked.map((u) => ({
			line: u.line,
			problem: `${b.id} unreadable Test clause: ${u.text}`,
		})),
	);
