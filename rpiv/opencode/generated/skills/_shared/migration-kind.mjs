// migration-kind.mjs — is a migration change additive (lane normal) or risky (rigorous)?
// A one-line CREATE INDEX forced the rigorous lane exactly like a table rebuild, so
// lane.mjs grades a migration by the SQL its diff adds. Conservative by design: only a
// new SQL file (or new lines in one) whose every statement creates a table, creates a
// non-unique index, or adds an unconstrained column is additive; anything else —
// deleted lines, data changes, drops, UNIQUE/NOT NULL, non-SQL migrations, nothing to
// judge — stays risky. A plain CREATE INDEX still locks writes on a large Postgres
// table while it builds; the normal lane's full review is where that gets weighed.
//
// Importable-only: no CLI, no isMain.
// Importable: diffLines, migrationKind.

const ADDITIVE_STATEMENTS = [
	/^create\s+table\b/i,
	/^create\s+index\b/i,
	/^alter\s+table\s+\S+\s+add\s+(column\s+)?(?!constraint\b)/i,
];
// A column added with these validates or rewrites existing rows.
const CONSTRAINED_COLUMN = /\b(not\s+null|unique|primary\s+key)\b/i;

const isAdditive = (statement) =>
	ADDITIVE_STATEMENTS.some((re) => re.test(statement)) &&
	!(/^alter\b/i.test(statement) && CONSTRAINED_COLUMN.test(statement));

/** The SQL statements in `lines`, with `--` comments (drizzle's
    `--> statement-breakpoint` included) removed. */
const statementsOf = (lines) =>
	lines
		.map((line) => line.replace(/--.*$/, ""))
		.join("\n")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);

/** `"additive"` or `"risky"` for a migration at `path` whose change adds `added`
    lines and deletes `deleted` lines. */
export const migrationKind = (path, { added, deleted }) => {
	if (!/\.sql$/i.test(path) || deleted > 0) return "risky";
	const statements = statementsOf(added);
	return statements.length > 0 && statements.every(isAdditive)
		? "additive"
		: "risky";
};

/** Added lines and the deleted-line count of a unified diff, read from hunk bodies
    only (a deleted `-- comment` line and the `--- a/` header look alike). */
export const diffLines = (diff) => {
	const added = [];
	let deleted = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) inHunk = true;
		else if (line.startsWith("diff --git")) inHunk = false;
		else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
		else if (inHunk && line.startsWith("-")) deleted += 1;
	}
	return { added, deleted };
};
