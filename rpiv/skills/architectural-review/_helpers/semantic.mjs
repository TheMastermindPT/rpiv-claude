// semantic.mjs — OPTIONAL ts-morph-backed semantic signals for the architectural-review skill.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/semantic.mjs" "<target>"
//
// Emits TYPE-RESOLVED supersets of three regex signals from metrics.mjs, for the lenses
// where the TypeScript type system sees what regex cannot:
//   ---write-sites-semantic---   (S)  table/RPC writers, resolving IMPORTED/aliased table
//                                     names via the type checker (metrics.mjs only does
//                                     same-file `const TABLE = "x"`).
//   ---feature-envy-semantic---  (Fe) per-symbol behavioral-vs-data split of the most-
//                                     envied internal module (behavioralRefs=0 => data-
//                                     only => NOT envy — the per-symbol call regex can't make).
//   ---dead-exports-semantic---  (A)  exports with zero EXTERNAL `findReferences` (type-
//                                     resolved dead, stronger than the export-usage stem).
//
// Read-only (navigates the AST; never mutates). Always exits 0. ts-morph is the ONLY
// dependency and it is OPTIONAL: if ts-morph is unresolvable or there is no tsconfig, this
// emits `---semantic-status--- unavailable: <reason>` and the review falls back to the
// regex signals in metrics.mjs. metrics.mjs stays dependency-free — this helper is additive.
//
// The full tsconfig program is loaded (cross-file findReferences needs it) but OUTPUT is
// restricted to declarations/files under <target>. Bounded by SEMANTIC_MAX_FILES (skip a
// too-large program) and SEMANTIC_REF_EXAMINE_CAP (cap the findReferences hot path).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SEMANTIC_MAX_FILES = 4000; // skip programs larger than this (degrade to regex)
const SEMANTIC_REF_EXAMINE_CAP = 1200; // cap exports examined for dead-code (findReferences is the hot path)
const ENVY_MIN_BEH = 3; // Fe: require at least this many BEHAVIORAL refs to the envied module
const ENVY_MIN_REFS = 5; // Fe: total refs to the module (mirrors metrics.mjs envyOf)
const ENVY_MIN_RATIO = 0.6; // Fe: ext / (ext + own) gate (mirrors metrics.mjs envyOf)
const TYPE_MIN_PROPS = 3; // C: ignore trivial shapes (< 3 props, e.g. {id:string}) — FP guard
const TYPE_EXAMINE_CAP = 2000; // C: bound the type-shape scan (AST-only, cheap)

const toPosix = (p) => p.replaceAll("\\", "/");
const safeGit = (args, fb = "") => {
	try {
		return execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return fb;
	}
};

const root = toPosix(safeGit(["rev-parse", "--show-toplevel"])) || toPosix(process.cwd());
const targetArg = process.argv[2] || ".";
const targetAbs = toPosix(isAbsolute(targetArg) ? targetArg : resolve(process.cwd(), targetArg));

const status = (msg) => {
	process.stdout.write(`---semantic-status---\n${msg}\n`);
	process.exit(0);
};

// --- Optional dependency: ts-morph (resolved relative to THIS helper) --------
const require = createRequire(import.meta.url);
let tsmorph;
try {
	tsmorph = require("ts-morph");
} catch {
	status("unavailable: ts-morph not resolvable from the helper location (suggest: npm i -D ts-morph)");
}
const { Project, SyntaxKind } = tsmorph;

// --- Locate the tsconfig that governs the target ----------------------------
const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const findTsconfig = () => {
	let dir = isDir(targetAbs) ? targetAbs : dirname(targetAbs);
	for (let guard = 0; guard < 100; guard += 1) {
		const candidate = join(dir, "tsconfig.json");
		if (existsSync(candidate)) return toPosix(candidate);
		if (toPosix(dir) === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const atRoot = join(root, "tsconfig.json");
	return existsSync(atRoot) ? toPosix(atRoot) : "";
};
const tsConfigFilePath = findTsconfig();
if (!tsConfigFilePath) status("unavailable: no tsconfig.json found at or above the target");

// --- Load the program (bounded) ---------------------------------------------
let project;
try {
	project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
} catch (e) {
	status(`unavailable: ts-morph failed to load the project (${e.message})`);
}
const allFiles = project.getSourceFiles().filter((sf) => !sf.isInNodeModules() && !sf.isDeclarationFile());
if (allFiles.length > SEMANTIC_MAX_FILES) {
	status(`unavailable: project too large (${allFiles.length} files > SEMANTIC_MAX_FILES=${SEMANTIC_MAX_FILES})`);
}

const rel = (sf) => toPosix(relative(root, sf.getFilePath()));
const underTarget = (sf) => {
	const p = toPosix(sf.getFilePath());
	return p === targetAbs || p.startsWith(`${targetAbs}/`);
};
const targetFiles = allFiles.filter(underTarget);

// --- Block 1: write-sites-semantic (S) --------------------------------------
// `.from(<arg>).insert|update|upsert|delete` and `.rpc("fn")`, counting distinct
// writing modules per RESOLVED table/RPC name. getType().getLiteralValue() resolves
// an imported/aliased `const TABLE = "x"` the same as a string literal.
const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
const writeSites = new Map(); // "table:x" | "rpc:y" -> Set<relfile>
let writeResolved = 0;
let writeUnresolved = 0;
const addWrite = (key, f) => {
	if (!writeSites.has(key)) writeSites.set(key, new Set());
	writeSites.get(key).add(f);
};
const literalString = (node) => {
	if (!node) return null;
	const lit = node.getType().getLiteralValue?.();
	return typeof lit === "string" ? lit : null;
};
const findFromArg = (receiver) => {
	let cur = receiver;
	for (let guard = 0; cur && guard < 50; guard += 1) {
		const kind = cur.getKind();
		if (kind === SyntaxKind.CallExpression) {
			const ce = cur.getExpression();
			if (ce.getKind() === SyntaxKind.PropertyAccessExpression && ce.getName() === "from") {
				return cur.getArguments()[0] ?? null;
			}
			cur = ce.getKind() === SyntaxKind.PropertyAccessExpression ? ce.getExpression() : null;
		} else if (kind === SyntaxKind.PropertyAccessExpression) {
			cur = cur.getExpression();
		} else {
			return null;
		}
	}
	return null;
};
for (const sf of targetFiles) {
	const f = rel(sf);
	for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
		const expr = call.getExpression();
		if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
		const method = expr.getName();
		if (method === "rpc") {
			const name = literalString(call.getArguments()[0]);
			if (name) {
				addWrite(`rpc:${name}`, f);
				writeResolved += 1;
			} else writeUnresolved += 1;
			continue;
		}
		if (!WRITE_METHODS.has(method)) continue;
		const fromArg = findFromArg(expr.getExpression());
		if (!fromArg) continue; // not a `.from(...)` chain -> not a db write (e.g. crypto.update)
		const table = literalString(fromArg);
		if (table) {
			addWrite(`table:${table}`, f);
			writeResolved += 1;
		} else writeUnresolved += 1;
	}
}
const writeRows = [...writeSites.entries()]
	.map(([key, set]) => ({ key, writers: set.size, files: [...set].sort() }))
	.sort((a, b) => b.writers - a.writers || a.key.localeCompare(b.key));

// --- Block 2: feature-envy-semantic (Fe) ------------------------------------
// For each target file, find the internal module it leans on most BEHAVIORALLY
// (excluding import-line identifiers), splitting references into behavioral (function/
// method/class / arrow-or-function const) vs data (const-value/type/interface/enum).
// Only files with a real behavioral lean are emitted — a file that references a module
// only for its TYPES (behavioralRefs=0) is not feature-envy and is filtered out here,
// which the coarse call/member-count regex in metrics.mjs cannot do.
const isBehavioralDecl = (decl) => {
	const k = decl.getKindName();
	if (k === "FunctionDeclaration" || k === "MethodDeclaration" || k === "ClassDeclaration") return true;
	if (k === "VariableDeclaration") {
		const init = decl.getInitializer?.();
		const ik = init?.getKind();
		return ik === SyntaxKind.ArrowFunction || ik === SyntaxKind.FunctionExpression;
	}
	return false; // type alias / interface / enum / const value
};
// A same-file declaration is "own" only when it is a top-level symbol (mirrors the
// metrics.mjs envyOf `own` count) — not a local/param — so the ratio gate matches.
const isTopLevel = (decl) => {
	if (decl.getKind() === SyntaxKind.VariableDeclaration) {
		const stmt = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
		return Boolean(stmt) && stmt.getParent()?.getKind() === SyntaxKind.SourceFile;
	}
	return decl.getParent()?.getKind() === SyntaxKind.SourceFile;
};
const envyRows = [];
for (const sf of targetFiles) {
	const byModule = new Map(); // targetRelFile -> { beh, data }
	let own = 0; // references to this file's OWN top-level symbols
	for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
		if (id.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue; // skip the binding itself
		const sym = id.getSymbol();
		if (!sym) continue;
		const aliased = sym.getAliasedSymbol?.();
		const decls = (aliased ?? sym).getDeclarations?.() ?? [];
		if (!decls.length) continue;
		const decl = decls[0];
		const declSf = decl.getSourceFile();
		if (declSf === sf) {
			if (isTopLevel(decl)) own += 1;
			continue;
		}
		if (declSf.isInNodeModules() || declSf.isDeclarationFile()) continue;
		const modKey = rel(declSf);
		if (!byModule.has(modKey)) byModule.set(modKey, { beh: 0, data: 0 });
		const bucket = byModule.get(modKey);
		if (isBehavioralDecl(decl)) bucket.beh += 1;
		else bucket.data += 1;
	}
	let best = null;
	for (const [mod, { beh, data }] of byModule) {
		// rank by BEHAVIORAL lean (envy is about misplaced behavior, not shared types)
		if (!best || beh > best.beh || (beh === best.beh && beh + data > best.ext)) {
			best = { mod, beh, data, ext: beh + data };
		}
	}
	// Same gates as metrics.mjs envyOf (ext >= MIN_REFS, ratio >= MIN_RATIO) PLUS a real
	// behavioral lean (beh >= MIN_BEH) — type-only leans (beh=0) never reach here.
	if (best && best.beh >= ENVY_MIN_BEH && best.ext >= ENVY_MIN_REFS) {
		const ratio = best.ext / (best.ext + own || 1);
		if (ratio >= ENVY_MIN_RATIO) {
			envyRows.push({ f: rel(sf), module: best.mod, ext: best.ext, own, ratio, beh: best.beh, data: best.data });
		}
	}
}
envyRows.sort((a, b) => b.beh - a.beh || b.ext - a.ext || a.f.localeCompare(b.f));

// --- Block 3: dead-exports-semantic (A) — FALLBACK ONLY ---------------------
// A (dead exports) is knip's job: knip is dead-export aware AND understands entry
// points / dynamic patterns (Next.js routes, string-keyed registries) that whole-
// program findReferences CANNOT see — so it has fewer false positives. Compute this
// only when knip is UNAVAILABLE; when knip is present, skip it (no redundant, weaker
// signal — and skip the expensive findReferences pass). Functions/classes rank first.
const knipAvailable = (() => {
	for (const c of ["knip.json", "knip.jsonc", "knip.ts", "knip.config.ts", "knip.config.js"]) {
		if (existsSync(join(root, c))) return true;
	}
	if (existsSync(join(root, "node_modules/.bin/knip")) || existsSync(join(root, "node_modules/.bin/knip.cmd"))) return true;
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
		if (pkg.knip) return true;
		const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
		if (deps.knip) return true;
		const scripts = pkg.scripts ?? {};
		if (Object.keys(scripts).some((k) => /knip/.test(k) || /knip/.test(String(scripts[k])))) return true;
	} catch {
		/* no package.json */
	}
	return false;
})();
const deadRows = [];
let examined = 0;
let capped = false;
if (!knipAvailable) {
	const kindRank = (k) => (k === "FunctionDeclaration" || k === "ClassDeclaration" ? 0 : 1);
	outer: for (const sf of targetFiles) {
		for (const [name, decls] of sf.getExportedDeclarations()) {
			for (const decl of decls) {
				if (decl.getSourceFile() !== sf) continue; // re-export: owned elsewhere, skip
				if (examined >= SEMANTIC_REF_EXAMINE_CAP) {
					capped = true;
					break outer;
				}
				examined += 1;
				const nameNode = decl.getNameNode?.() ?? decl;
				let extRefs = 0;
				try {
					for (const refNode of nameNode.findReferencesAsNodes()) {
						if (refNode.getSourceFile() !== sf) extRefs += 1;
					}
				} catch {
					continue; // overloads / unsupported nodes -> skip rather than crash
				}
				if (extRefs === 0) deadRows.push({ f: rel(sf), name, kind: decl.getKindName() });
			}
		}
	}
	deadRows.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.f.localeCompare(b.f) || a.name.localeCompare(b.name));
}

// --- Block 4: type-fragmentation-semantic (C) -------------------------------
// Structural fragmentation the NAME-based C agent cannot see: the SAME shape under
// DIFFERENT names (a missing shared type), and the SAME name DECLARED with DIFFERENT
// shapes (drift). Signature = sorted `name[?]:typeText` of own AST members
// (deterministic, no type-checker expansion). FP guards: object-like types only,
// >= TYPE_MIN_PROPS members, bounded by TYPE_EXAMINE_CAP. No external tool covers C.
const typeDecls = [];
let typesExamined = 0;
outerType: for (const sf of targetFiles) {
	const f = rel(sf);
	const collect = (name, line, members) => {
		const props = members.map((m) => `${m.getName()}${m.hasQuestionToken?.() ? "?" : ""}:${m.getTypeNode?.()?.getText() ?? "any"}`);
		if (props.length < TYPE_MIN_PROPS) return;
		typeDecls.push({ name, f, line, sig: props.sort().join(";") });
	};
	for (const iface of sf.getInterfaces()) {
		if (typesExamined >= TYPE_EXAMINE_CAP) break outerType;
		typesExamined += 1;
		collect(iface.getName(), iface.getStartLineNumber(), iface.getProperties());
	}
	for (const ta of sf.getTypeAliases()) {
		if (typesExamined >= TYPE_EXAMINE_CAP) break outerType;
		typesExamined += 1;
		const node = ta.getTypeNode();
		if (node && node.getKind() === SyntaxKind.TypeLiteral) collect(ta.getName(), ta.getStartLineNumber(), node.getProperties());
	}
}
const pushTo = (map, key, val) => {
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(val);
};
const byName = new Map();
const bySig = new Map();
for (const d of typeDecls) {
	pushTo(byName, d.name, d);
	pushTo(bySig, d.sig, d);
}
const locOf = (d) => `${d.f}:${d.line}`;
const typeRows = [];
for (const [name, ds] of byName) {
	// drift: one name, >=2 declarations, >=2 distinct shapes (they DISAGREE).
	if (ds.length >= 2 && new Set(ds.map((d) => d.sig)).size > 1) {
		typeRows.push({ kind: "drift", label: `name=${name}`, defs: ds.length, files: ds.map(locOf) });
	}
}
for (const ds of bySig.values()) {
	// same-shape: one shape, >=2 distinct names (a missing shared type).
	const names = [...new Set(ds.map((d) => d.name))];
	if (ds.length >= 2 && names.length > 1) {
		typeRows.push({ kind: "same-shape", label: `names=${names.join(",")}`, defs: ds.length, files: ds.map(locOf) });
	}
}
typeRows.sort((a, b) => b.defs - a.defs || a.label.localeCompare(b.label));

// --- Emit -------------------------------------------------------------------
const out = [];
out.push(`target:           ${toPosix(relative(root, targetAbs)) || "."}`);
out.push(`tsconfig:         ${toPosix(relative(root, tsConfigFilePath))}`);
out.push(`files_in_program: ${allFiles.length}`);
out.push(`files_in_target:  ${targetFiles.length}`);
out.push(`write_resolution: resolved=${writeResolved} unresolved=${writeUnresolved}`);
out.push(`dead_export_scan: ${knipAvailable ? "skipped (knip present — A delegated to knip)" : `examined=${examined} capped=${capped}`}`);
out.push(`type_scan:        examined=${typesExamined}`);

const block = (label, rows) => {
	out.push(`---${label}---`);
	for (const r of rows) out.push(r);
};
block("write-sites-semantic", writeRows.map((r) => `${r.key}\twriters=${r.writers}\tfiles=${r.files.join(", ")}`));
block("feature-envy-semantic", envyRows.map((r) => `${r.f}\tenvies=${r.module}\text=${r.ext}\town=${r.own}\tratio=${r.ratio.toFixed(2)}\tbehavioralRefs=${r.beh}\tdataRefs=${r.data}`));
block("dead-exports-semantic", deadRows.map((r) => `${r.f}:${r.name}\tkind=${r.kind}\textRefs=0`));
block("type-fragmentation-semantic", typeRows.map((r) => `kind=${r.kind}\t${r.label}\tdefs=${r.defs}\tfiles=${r.files.join(", ")}`));

process.stdout.write(`${out.join("\n")}\n`);
process.exit(0);
