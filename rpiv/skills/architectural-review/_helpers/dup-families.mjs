// dup-families.mjs — turn a merged jscpd clone list into ARCHITECTURE-review seeds.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/dup-families.mjs" \
//     --clones=<scratchpad>/jscpd-merged.json --root=<repo root>
//
// Why: a raw clone count measures copying, not architecture. On two real Next.js repos the
// merged list held 694 and 443 pairs, of which 75-79% were test code copying test code and
// ~40% sat just over the token bar; the duplication that says something about STRUCTURE —
// the same block living in several modules, e.g. an app-layer copy of a function lib/ already
// exports — was ~50 families. So every clone lands in exactly one bucket:
//
//   test<->test     counted in the header only (test setup repeats by design)
//   test<->prod     ---dup-test-prod---   a test re-implementing production code (T lens)
//   same file       ---dup-same-file---   a function-level cleanup, context only
//   import-only     counted, dropped      a shared import list is not a design defect
//   cross-file prod ---dup-families---    grouped into copy families, ranked by SPREAD
//
// A family is every region joined by clones (one copied block and all its copies). Ranking
// is by spread, not size — a small copy across modules points at a missing shared home or a
// leaky boundary, a large repeat inside one folder usually does not: areas, then folders,
// then files, then copies, then the largest clone's tokens. An AREA is the nearest workspace
// package (a folder with package.json) plus the first folder under it, `src` skipped:
// `apps/desktop:main`, or `lib` in a single-package repo. ---dup-areas--- names them.
//
// Test paths are the shared vocabulary's isTestTree (source-vocab.mjs): test files, fixture
// and e2e trees, test/spec directories and fixture-named files.
//
// Per degrade-distinguishes-broken: an unreadable or malformed clone list prints
// `dup-families: BROKEN <path>: <cause>` and exits 2 with no stdout. A source file that
// cannot be read for the import check keeps its clone (never dropped unseen) and is counted
// in `import_check_unreadable`. The import check covers JS/TS only; other languages' clones
// are never classed import-only.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBoundedEmitter } from "./bounded-output.mjs";
import { parseCliArgs } from "./cli-args.mjs";
import { isTestTree } from "./source-set.mjs";

const OUT_LINE_CAP = 40; // rows per block
const OUT_BYTE_CAP = 16000;
const LOCS_SHOWN = 6; // copies listed per family row
const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;

const slashed = (p) => String(p).split("\\").join("/");

/** Repo-relative, forward-slashed: cpd reports either relative or absolute names. */
const toRel = (root, name) => {
	const p = slashed(name).replace(/^\/\/\?\//, "");
	return isAbsolute(p) ? slashed(relative(root, p)) : p.replace(/^\.\//, "");
};

/** Area = nearest workspace package + the first folder under it (`src` skipped). */
function makeAreaOf(root) {
	const cache = new Map();
	const isPackage = (dir) => {
		if (!cache.has(dir))
			cache.set(dir, existsSync(resolve(root, dir, "package.json")));
		return cache.get(dir);
	};
	return (rel) => {
		const dirs = rel.split("/").slice(0, -1);
		let pkg = 0;
		for (let n = dirs.length; n > 0; n -= 1) {
			if (isPackage(dirs.slice(0, n).join("/"))) {
				pkg = n;
				break;
			}
		}
		const rest = dirs.slice(pkg);
		if (rest[0] === "src") rest.shift();
		const prefix = dirs.slice(0, pkg).join("/");
		if (!prefix) return rest[0] ?? ".";
		return rest.length ? `${prefix}:${rest[0]}` : prefix;
	};
}

// A clone region is import-only when, once comments and every whole or cut-off
// import/export-from statement are removed, nothing but names, commas and braces is left.
const IMPORT_STATEMENT =
	/\b(?:import|export)\b[^;]*?\bfrom\s*(['"`])[^'"`]*\1\s*;?/g;
const BARE_IMPORT = /\bimport\s*(['"])[^'"]*\1\s*;?/g;
const CUT_TAIL = /^[^;]*?\}\s*from\s*(['"`])[^'"`]*\1\s*;?/; // region opened mid-import
const CUT_HEAD = /\b(?:import|export)\b(?:\s+type)?\s*\{[^}]*$/; // region closed mid-import
const NAMES_ONLY = /^[\s\w$,{}*]*$/;

function isImportOnly(text) {
	const left = text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/\/\/[^\n]*/g, " ")
		.replace(CUT_TAIL, " ")
		.replace(IMPORT_STATEMENT, " ")
		.replace(BARE_IMPORT, " ")
		.replace(CUT_HEAD, " ");
	return (
		NAMES_ONLY.test(left) &&
		!/\b(?:const|let|var|function|class|return)\b/.test(left)
	);
}

/** Returns true / false, or null when the file cannot be read. */
function makeRegionIsImportOnly(root) {
	const lines = new Map();
	const read = (rel) => {
		if (!lines.has(rel)) {
			try {
				lines.set(
					rel,
					readFileSync(resolve(root, rel), "utf-8").split(/\r?\n/),
				);
			} catch {
				lines.set(rel, null);
			}
		}
		return lines.get(rel);
	};
	return (side) => {
		if (!JS_TS.test(side.name)) return false;
		const file = read(side.name);
		if (file === null) return null;
		return isImportOnly(file.slice(side.start - 1, side.end).join("\n"));
	};
}

const loc = (s) => `${s.name}:${s.start}-${s.end}`;
const pairRow = (d) => `${loc(d.a)} <-> ${loc(d.b)}\ttokens=${d.tokens}`;

/** The bucket a production-only cross-file clone falls in, and whether a side was unreadable. */
function crossFileKind(d, regionIsImportOnly) {
	const checks = [regionIsImportOnly(d.a), regionIsImportOnly(d.b)];
	return {
		kind: checks.every((c) => c === true) ? "importOnly" : "cross",
		unreadable: checks.includes(null),
	};
}

/** Which bucket one clone falls in (see the header). Sides are already repo-relative. */
function classify(d, regionIsImportOnly) {
	const ta = isTestTree(d.a.name);
	const tb = isTestTree(d.b.name);
	if (ta && tb) return { kind: "testTest" };
	if (ta || tb)
		return { kind: "testProd", clone: ta ? d : { ...d, a: d.b, b: d.a } };
	if (d.a.name === d.b.name) return { kind: "sameFile" };
	return crossFileKind(d, regionIsImportOnly);
}

/** Bucket every clone. Counted buckets hold numbers; listed buckets hold the clones. */
function bucketClones(clones, regionIsImportOnly) {
	const out = {
		testTest: 0,
		testProd: [],
		sameFile: [],
		importOnly: 0,
		unreadable: 0,
		cross: [],
	};
	for (const d of clones) {
		const c = classify(d, regionIsImportOnly);
		if (c.unreadable) out.unreadable += 1;
		if (Array.isArray(out[c.kind])) out[c.kind].push(c.clone ?? d);
		else out[c.kind] += 1;
	}
	return out;
}

/** Union the regions joined by clones into copy families. */
function familiesOf(clones) {
	const regions = [];
	const parent = [];
	const find = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const regionOf = (s) => {
		let i = regions.findIndex(
			(r) => r.name === s.name && r.start <= s.end && s.start <= r.end,
		);
		if (i < 0) {
			regions.push({ name: s.name, start: s.start, end: s.end, tokens: 0 });
			parent.push(regions.length - 1);
			i = regions.length - 1;
		}
		return i;
	};
	for (const d of clones) {
		const a = regionOf(d.a);
		const b = regionOf(d.b);
		regions[a].tokens = Math.max(regions[a].tokens, d.tokens);
		regions[b].tokens = Math.max(regions[b].tokens, d.tokens);
		parent[find(b)] = find(a);
	}
	const groups = new Map();
	regions.forEach((r, i) => {
		const g = find(i);
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(r);
	});
	return [...groups.values()];
}

function rankFamilies(groups, areaOf) {
	const dirOf = (p) => p.split("/").slice(0, -1).join("/") || ".";
	return groups
		.map((rs) => ({
			regions: rs,
			areas: [...new Set(rs.map((r) => areaOf(r.name)))].sort(),
			folders: new Set(rs.map((r) => dirOf(r.name))).size,
			files: new Set(rs.map((r) => r.name)).size,
			maxTokens: Math.max(...rs.map((r) => r.tokens)),
		}))
		.sort(
			(x, y) =>
				y.areas.length - x.areas.length ||
				y.folders - x.folders ||
				y.files - x.files ||
				y.regions.length - x.regions.length ||
				y.maxTokens - x.maxTokens,
		);
}

function familyRow(f, i) {
	const shown = f.regions.slice(0, LOCS_SHOWN).map(loc).join(" | ");
	const more =
		f.regions.length > LOCS_SHOWN
			? ` | (+${f.regions.length - LOCS_SHOWN} more)`
			: "";
	return `F${i + 1}\tareas=${f.areas.length}\tfolders=${f.folders}\tfiles=${f.files}\tcopies=${f.regions.length}\tmax_tokens=${f.maxTokens}\t${shown}${more}`;
}

/** Parsed clone list, or a BROKEN cause — never a stand-in empty list. */
function readClones(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		return {
			broken:
				err.code === "ENOENT" ? "no such file" : `unreadable (${err.message})`,
		};
	}
	if (!Array.isArray(parsed?.duplicates))
		return { broken: "not a clone list (no duplicates array)" };
	return { duplicates: parsed.duplicates };
}

function main(argv) {
	const args = parseCliArgs(argv);
	if (typeof args.clones !== "string" || typeof args.root !== "string") {
		process.stderr.write(
			"usage: dup-families.mjs --clones=<merged.json> --root=<repo root>\n",
		);
		return 2;
	}
	const input = readClones(args.clones);
	if (input.broken) {
		process.stderr.write(
			`dup-families: BROKEN ${args.clones}: ${input.broken}\n`,
		);
		return 2;
	}
	const root = resolve(args.root);
	const side = (s) => ({
		name: toRel(root, s.name),
		start: s.start,
		end: s.end,
	});
	const clones = input.duplicates.map((d) => ({
		a: side(d.firstFile),
		b: side(d.secondFile),
		tokens: d.tokens ?? 0,
	}));

	const b = bucketClones(clones, makeRegionIsImportOnly(root));
	const ranked = rankFamilies(familiesOf(b.cross), makeAreaOf(root));
	const head = [
		`clones: ${clones.length}`,
		`test_test: ${b.testTest}`,
		`test_prod: ${b.testProd.length}`,
		`same_file: ${b.sameFile.length}`,
		`import_only: ${b.importOnly}`,
		`import_check_unreadable: ${b.unreadable}`,
		`cross_file: ${b.cross.length}`,
		`families: ${ranked.length}`,
	];
	const { block, body } = makeBoundedEmitter(
		OUT_LINE_CAP,
		OUT_BYTE_CAP,
		`${head.join("\n")}\n`,
	);
	block("dup-families", ranked.map(familyRow));
	block(
		"dup-areas",
		ranked.map((f, i) => `F${i + 1}\t${f.areas.join(", ")}`),
	);
	block("dup-test-prod", b.testProd.map(pairRow));
	block(
		"dup-same-file",
		[...b.sameFile].sort((x, y) => y.tokens - x.tokens).map(pairRow),
	);
	process.stdout.write(body());
	return 0;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = main(process.argv.slice(2));
}
