// _literal-variables.mjs — Bash variables whose value the approval hook can know
// from the command itself, so `S=/tmp/sp; $S/run.sh` is read as `/tmp/sp/run.sh`
// (one script file, D11 residual risk) instead of a computed command word.
//
// A variable qualifies only when every doubt is ruled out; otherwise it stays
// computed and the hook keeps asking (fail closed, D13):
//   - it is assigned exactly once, by a top-level segment that holds nothing but
//     plain assignments: not in a group, a pipe, a substitution or a background job;
//   - the value is a non-empty literal of path-safe characters (no blanks, globs,
//     quotes or expansions), so it can never split into several words;
//   - the assignment runs unconditionally before its uses: first, after `;` or a
//     newline, or inside an `&&` chain that runs to the end of the command;
//   - no use of the variable comes before the assignment;
//   - no builtin that can change or re-read variables appears (`read`, `export`,
//     `eval`, `for`, …), in which case no variable qualifies.
//
// Importable (pure, given the hook's tokenizer segments): withLiteralVariables.

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SAFE_VALUE = /^[A-Za-z0-9_./:@%+,~-]+$/;
const CHANGES_VARIABLES = new Set([
	"read", "for", "select", "case", "while", "until", "export", "declare",
	"local", "typeset", "readonly", "unset", "mapfile", "readarray", "getopts",
	"eval", "source", ".", "let",
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isPlainAssignment = (word) => !word.dynamic && ASSIGNMENT.test(word.value);

/** True for a segment in the command's own shell: top level, no group, no pipe,
    followed by `;`/newline or `&&`. */
const runsInOwnShell = (segment) =>
	[segment.depth === 1, segment.group === null, !segment.piped, ["seq", "and"].includes(segment.joiner)].every(Boolean);

/** True for a top-level segment made only of plain literal assignments. */
const isAssignmentSegment = (segment) =>
	runsInOwnShell(segment) && segment.words.every(isPlainAssignment);

/** Does the segment at `index` of `top` run whenever the command runs past it:
    first, after `;`/newline, or in an `&&` chain that reaches the end? */
function runsUnconditionally(top, index) {
	const before = top[index - 1];
	if (!before || before.joiner === "seq") return true;
	if (before.joiner !== "and") return false;
	return top.slice(index, -1).every((s) => s.joiner === "and" || s.joiner === "pipe");
}

/** How many words, anywhere in the command, assign each name. */
function assignmentCounts(segments) {
	const counts = new Map();
	for (const segment of segments)
		for (const word of segment.words) {
			const name = ASSIGNMENT.exec(word.value)?.[1];
			if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	return counts;
}

/** True when a segment holds a builtin that can change or re-read variables. `.`
    (source) counts only as the command word: as an argument it is a directory. */
const changesVariables = (segment) => {
	const command = segment.words.findIndex((w) => !ASSIGNMENT.test(w.value));
	return segment.words.some(
		(w, i) => CHANGES_VARIABLES.has(w.value) && (w.value !== "." || i === command),
	);
};

/** Name -> value for the variables that qualify (see the header). */
function literalValues(segments) {
	if (segments.some(changesVariables)) return new Map();
	const counts = assignmentCounts(segments);
	const top = segments.filter((s) => s.depth === 1);
	const assignments = top
		.filter((segment, index) => isAssignmentSegment(segment) && runsUnconditionally(top, index))
		.flatMap((segment) => segment.words.map((w) => ASSIGNMENT.exec(w.value).slice(1)));
	return new Map(
		assignments.filter(([name, value]) => counts.get(name) === 1 && SAFE_VALUE.test(value)),
	);
}

/** True when the command's text assigns `name` once and uses it only after that. */
function usedOnlyAfterAssignment(command, name) {
	const assigns = [...command.matchAll(new RegExp(`(?:^|[\\s;&|])${escapeRegExp(name)}=`, "g"))];
	if (assigns.length !== 1) return false;
	const use = command.search(new RegExp(`\\$\\{?${escapeRegExp(name)}(?![A-Za-z0-9_])`));
	return use === -1 || use > assigns[0].index;
}

/** `command` with each qualifying `$NAME` / `${NAME}` replaced by its literal value,
    or `command` itself when nothing qualifies. `segments` are the hook's tokenizer
    segments of `command` (Bash). */
export function withLiteralVariables(command, segments) {
	let out = command;
	for (const [name, value] of literalValues(segments)) {
		if (!usedOnlyAfterAssignment(command, name)) continue;
		const uses = new RegExp(`\\$\\{${escapeRegExp(name)}\\}|\\$${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
		out = out.replace(uses, () => value);
	}
	return out;
}
