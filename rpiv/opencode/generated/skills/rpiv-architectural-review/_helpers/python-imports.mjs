// python-imports.mjs — resolve a Python file's imports to tracked `.py` files, for
// metrics.mjs's import graph (D42 of the Python-support design, S6-metrics-jscpd).
// Lossy by design, like the JS specifier regexes: `import a.b`, `from a.b import c`
// and the relative forms (`from .x import y`, `from .. import z`), on the first line of
// each statement. Third-party modules resolve to nothing.
//
// An absolute module resolves to the one tracked file whose path ends, at a folder
// boundary, in `a/b/c.py`, `a/b/c/__init__.py`, `a/b.py` or `a/b/__init__.py`, tried in
// that order (an imported name may be a submodule); two files ending the same way
// resolve to nothing. A relative module resolves from the importing file's folder.
//
// Importable-only: no CLI, no isMain.
// Importable: pythonImports, pythonSuffixIndex, resolvePythonImports.

const IMPORT_LINE = /^[ \t]*import[ \t]+([\w. \t,]+)$/gm;
const FROM_LINE = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^)\n#]*)/gm;

/** The names of an `import` list: `a, b as c` → [a, b]. */
const namesOf = (list) =>
	list
		.split(",")
		.map((part) => part.trim().split(/[ \t]+as[ \t]+/)[0].trim())
		.filter((name) => /^[\w.]+$/.test(name));

/** A Python file's import statements: `{ level, module, names }` each, where `level` is
    the count of leading dots and `names` the imported names of a `from` form. */
export const pythonImports = (text) => [
	...[...text.matchAll(IMPORT_LINE)].flatMap((m) =>
		namesOf(m[1]).map((module) => ({ level: 0, module, names: [] })),
	),
	...[...text.matchAll(FROM_LINE)].map((m) => ({
		level: m[1].length,
		module: m[2],
		names: namesOf(m[3]).filter((name) => name !== "*"),
	})),
];

/** Every tracked `.py` path by each of its suffixes at a folder boundary
    (`src/pkg/b.py` under `src/pkg/b.py`, `pkg/b.py` and `b.py`). */
export const pythonSuffixIndex = (paths) => {
	const index = new Map();
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 0; i < parts.length; i += 1) {
			const suffix = parts.slice(i).join("/");
			index.set(suffix, [...(index.get(suffix) ?? []), path]);
		}
	}
	return index;
};

/** The module paths an import may name, most specific first (D42). */
const candidatesOf = (modulePath, names) => [
	...names.flatMap((name) => {
		const sub = modulePath ? `${modulePath}/${name}` : name;
		return [`${sub}.py`, `${sub}/__init__.py`];
	}),
	...(modulePath ? [`${modulePath}.py`, `${modulePath}/__init__.py`] : []),
];

/** The folder a relative import starts from: the file's own folder, then one up per
    extra dot; null when it climbs above the repository. */
const relativeBase = (fromFile, level) => {
	const parts = fromFile.split("/").slice(0, -1);
	if (level - 1 > parts.length) return null;
	return parts.slice(0, parts.length - (level - 1)).join("/");
};

/** The first candidate that names exactly one tracked file. */
const firstUnique = (candidates, lookup) => {
	for (const candidate of candidates) {
		const hits = lookup(candidate);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return null;
	}
	return null;
};

/** The tracked `.py` files one import statement reaches. */
const resolveOne = (fromFile, { level, module, names }, index) => {
	const modulePath = module.replaceAll(".", "/");
	if (level === 0) {
		const targets = (names.length ? names : [null]).map((name) =>
			firstUnique(candidatesOf(modulePath, name ? [name] : []), (c) => index.get(c) ?? []),
		);
		return targets.filter(Boolean);
	}
	const base = relativeBase(fromFile, level);
	if (base === null) return [];
	const exact = (c) => {
		const path = base ? `${base}/${c}` : c;
		return (index.get(path) ?? []).filter((hit) => hit === path);
	};
	const rel = modulePath || "";
	const own = rel ? [] : ["__init__.py"];
	return names.length
		? names
				.map((name) => firstUnique([...candidatesOf(rel, [name]), ...own], exact))
				.filter(Boolean)
		: [firstUnique([...candidatesOf(rel, []), ...own], exact)].filter(Boolean);
};

/** The set of tracked `.py` files that `fromFile`'s `text` imports, itself excluded. */
export const resolvePythonImports = (fromFile, text, index) => {
	const out = new Set();
	for (const statement of pythonImports(text)) {
		for (const target of resolveOne(fromFile, statement, index)) {
			if (target !== fromFile) out.add(target);
		}
	}
	return out;
};
