// skills/_shared/import-red.mjs — whether a pytest load failure in a reprove-red run is
// the slice's expected red (rpiv issue draft 20261123-231126-941be8d9): a test or a
// conftest that imports what the slice adds cannot load on the base, so pytest stops
// with exit 2 (a test module) or exit 4 (a conftest) before any test runs. Such a failure
// is red only when the error names a module or a name the slice adds: the module has a
// file at the slice commit and none at the base, or the name is in the module's file at
// the slice commit and not at the base. Anything else (a missing dependency, a syntax
// error) stays broken (degrade-distinguishes-broken).

const IMPORT_ERRORS = [
	{
		re: /^ModuleNotFoundError: No module named '([^']+)'/,
		of: (m) => ({ module: m[1] }),
	},
	{
		re: /^ImportError: cannot import name '([^']+)' from '([^']+)'/,
		of: (m) => ({ module: m[2], name: m[1] }),
	},
	{
		re: /^AttributeError: module '([^']+)' has no attribute '([^']+)'/,
		of: (m) => ({ module: m[1], name: m[2] }),
	},
];

/** The import error a load failure's reason states: `{ message, module, name? }`, with
    the message cut before the file path an `ImportError` adds; undefined otherwise. */
export const importErrorOf = (reason) => {
	for (const { re, of } of IMPORT_ERRORS) {
		const match = re.exec(reason);
		if (match) return { message: match[0], ...of(match) };
	}
	return undefined;
};

const slashed = (module) => module.replaceAll(".", "/");

/** The `.py` files at a revision that make up `module` (a module file, or any file of
    its package), at the top folder or below another folder (a `src/` layout). */
const moduleTree = (files, module) => {
	const p = slashed(module);
	return files.filter(
		(file) =>
			file.endsWith(".py") &&
			(file === `${p}.py` ||
				file.startsWith(`${p}/`) ||
				file.endsWith(`/${p}.py`) ||
				file.includes(`/${p}/`)),
	);
};

/** The files that define `module` itself: its module file or its package's
    `__init__.py`. */
const moduleFiles = (files, module) => {
	const p = slashed(module);
	return files.filter((file) =>
		[`${p}.py`, `${p}/__init__.py`].some(
			(own) => file === own || file.endsWith(`/${own}`),
		),
	);
};

/** The first file of `module` the slice adds: one at the commit while the base has none. */
const addedModule = ({ baseFiles, commitFiles }, module) =>
	moduleTree(baseFiles, module).length === 0
		? moduleTree(commitFiles, module)[0]
		: undefined;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name in <file>` when the slice adds `name` to `module`: a word in a file of the
    module at the commit, in none of the module's files at the base (which must exist). */
const addedName = (trees, { module, name }) => {
	const before = moduleFiles(trees.baseFiles, module);
	if (before.length === 0) return undefined;
	const word = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`);
	if (before.some((file) => word.test(trees.textAt(trees.base, file)))) {
		return undefined;
	}
	const file = moduleFiles(trees.commitFiles, module).find((path) =>
		word.test(trees.textAt(trees.commit, path)),
	);
	return file && `${name} in ${file}`;
};

/** What the slice adds that `error` names (a file, or `<name> in <file>`); undefined
    when the error names nothing the slice adds. `trees` holds `baseFiles` and
    `commitFiles` (paths at each revision), `base`, `commit` and `textAt(rev, path)`. */
export const sliceAddition = (error, trees) => {
	if (error.name === undefined) return addedModule(trees, error.module);
	return (
		addedModule(trees, `${error.module}.${error.name}`) ??
		addedName(trees, error)
	);
};

/** One `load-error:` line per load failure and whether they all are the slice's import
    red: `{ red, lines }`. `reasons` are the failures' one-line reasons. */
export const judgeLoadErrors = (reasons, trees) => {
	const judged = [...new Set(reasons)].map((reason) => {
		const error = importErrorOf(reason);
		const added = error && sliceAddition(error, trees);
		return added
			? {
					red: true,
					line: `load-error: ${error.message} (the slice adds ${added})`,
				}
			: {
					red: false,
					line: `load-error: ${reason} (not an import of something the slice adds)`,
				};
	});
	return {
		red: judged.length > 0 && judged.every(({ red }) => red),
		lines: judged.map(({ line }) => line),
	};
};
