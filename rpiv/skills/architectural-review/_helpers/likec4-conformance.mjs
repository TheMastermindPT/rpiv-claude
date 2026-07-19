// likec4-conformance.mjs — declared-model vs code-graph conformance for architectural-review.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/likec4-conformance.mjs" \
//     --model <likec4-export.json> --graph <depcruise-or-madge.json> [--map <map.json>] [--target <prefix>]
//
// Deterministic set arithmetic between the repo's DECLARED LikeC4 model (likec4 export json)
// and the ACTUAL import graph (the Step-2 depcruise/madge capture). The one judgment task —
// naming which path prefixes each declared element owns — comes from element metadata
// (`metadata { dir '...' }` / `metadata { sources 'a; b' }`) or an orchestrator-written
// --map JSON ({ "<element-fqn>": ["path/prefix", ...] }); --map entries override metadata.
//
// Emits (tab-delimited rows, same idiom as metrics.mjs):
//   ---c4-mapping---        element -> prefixes (or UNMAPPED); mapping coverage line
//   ---c4-undocumented---   code edges between two mapped elements with NO covering declared
//                           relationship (covering = any declared rel between the elements or
//                           their ancestors — C4 semantics: a container-level rel covers its
//                           components' edges)
//   ---c4-aspirational---   declared rels whose BOTH endpoints are code-backed yet carry zero
//                           code edges (documented-but-dead architecture)
//   ---c4-summary---        undocumented=N aspirational=M unmapped_files=K unmapped_elements=J
//
// Read-only; always exit 0 — a conformance pass must never break the review. Elements with
// no mapped files (actors, external systems) are excluded from aspirational analysis by
// construction: only code-backed endpoints count.

import { readFileSync } from "node:fs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
const die = (msg) => {
	process.stdout.write(`c4-conformance: ${msg}\n---c4-summary---\nundocumented=0 aspirational=0 unmapped_files=0 unmapped_elements=0 status=degraded\n`);
	process.exit(0);
};
if (!args.model || !args.graph) die("usage: --model <likec4-export.json> --graph <depcruise|madge.json> [--map <map.json>] [--target <prefix>]");

const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch (e) {
		return null;
	}
};
const toPosix = (p) => String(p).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");

// ---- parse the LikeC4 export (schema-tolerant: object-map or array, nested or flat) ----
const dump = readJson(args.model);
if (!dump) die(`cannot parse model JSON: ${args.model}`);
// A multi-project dump nests per project; a single-project dump is flat.
const roots = [dump, dump.model, ...(Array.isArray(dump.projects) ? dump.projects : Object.values(dump.projects ?? {}))].filter(Boolean);
let elemsRaw = null;
let relsRaw = null;
for (const r of roots) {
	elemsRaw ??= r.elements ?? r.model?.elements ?? null;
	relsRaw ??= r.relations ?? r.relationships ?? r.model?.relations ?? null;
}
if (!elemsRaw) die("no elements found in model JSON (unexpected schema)");
const asEntries = (x, idKey = "id") =>
	Array.isArray(x) ? x.map((v) => [v[idKey] ?? v.fqn ?? v.name, v]) : Object.entries(x ?? {});
const elements = new Map(); // fqn -> { kind, title, prefixes: [] }
for (const [fqn, el] of asEntries(elemsRaw)) {
	if (!fqn) continue;
	const md = el.metadata ?? {};
	const prefixes = [];
	for (const key of ["dir", "path"]) if (md[key]) prefixes.push(toPosix(md[key]));
	if (md.sources) for (const s of String(md.sources).split(";")) if (s.trim()) prefixes.push(toPosix(s.trim()));
	elements.set(String(fqn), { kind: el.kind ?? "", title: el.title ?? String(fqn), prefixes });
}
const relEnd = (x) => (typeof x === "string" ? x : (x?.model ?? x?.id ?? x?.fqn ?? ""));
const declaredRels = []; // { source, target, title }
for (const [, rel] of asEntries(relsRaw ?? {})) {
	const s = relEnd(rel.source);
	const t = relEnd(rel.target);
	if (s && t) declaredRels.push({ source: String(s), target: String(t), title: rel.title ?? "" });
}

// ---- apply --map overrides (orchestrator judgment) ----
if (args.map) {
	const map = readJson(args.map);
	if (!map) die(`cannot parse map JSON: ${args.map}`);
	for (const [fqn, prefixes] of Object.entries(map)) {
		const el = elements.get(fqn);
		if (el) el.prefixes = (Array.isArray(prefixes) ? prefixes : [prefixes]).map(toPosix);
	}
}

// ---- parse the code graph (depcruise `modules` or madge object-map) ----
const graph = readJson(args.graph);
if (!graph) die(`cannot parse graph JSON: ${args.graph}`);
const fileEdges = []; // [from, to]
if (Array.isArray(graph.modules)) {
	for (const m of graph.modules) {
		const from = toPosix(m.source);
		for (const d of m.dependencies ?? []) {
			const to = toPosix(d.resolved ?? d.module ?? "");
			if (to && !to.startsWith("node_modules") && !d.coreModule) fileEdges.push([from, to]);
		}
	}
} else if (graph && typeof graph === "object") {
	for (const [from, deps] of Object.entries(graph)) {
		for (const to of Array.isArray(deps) ? deps : []) fileEdges.push([toPosix(from), toPosix(to)]);
	}
}
if (fileEdges.length === 0) die("graph JSON holds no edges (unexpected schema or empty capture)");

// ---- file -> element (longest-prefix match on path boundaries) ----
const prefixIndex = []; // { prefix, fqn }
for (const [fqn, el] of elements) for (const p of el.prefixes) if (p) prefixIndex.push({ prefix: p, fqn });
prefixIndex.sort((a, b) => b.prefix.length - a.prefix.length);
const fileToElem = (file) => {
	for (const { prefix, fqn } of prefixIndex) {
		if (file === prefix || file.startsWith(prefix + "/")) return fqn;
		// a prefix may name a single file (metadata.sources cite): match modulo :line
		if (prefix.includes(".") && file === prefix.replace(/:\d+.*$/, "")) return fqn;
	}
	return null;
};

// ---- ancestor chains + declared-rel cover set ----
const chain = (fqn) => {
	const parts = fqn.split(".");
	const out = [];
	for (let i = parts.length; i >= 1; i--) out.push(parts.slice(0, i).join("."));
	return out; // self first, root last
};
const declaredPairSet = new Set(declaredRels.map((r) => `${r.source}\t${r.target}`));
const covered = (a, b) => {
	for (const s of chain(a)) for (const t of chain(b)) if (declaredPairSet.has(`${s}\t${t}`)) return `${s}\t${t}`;
	return null;
};

// ---- walk code edges ----
const target = args.target ? toPosix(args.target) : "";
const underTarget = (f) => !target || f === target || f.startsWith(target + "/");
const undoc = new Map(); // "a\tb" -> { n, sample }
const coveredRelHits = new Set(); // declared pairs with >= 1 code edge
let unmappedFiles = new Set();
for (const [from, to] of fileEdges) {
	if (target && !underTarget(from) && !underTarget(to)) continue;
	const ea = fileToElem(from);
	const eb = fileToElem(to);
	if (!ea) unmappedFiles.add(from);
	if (!eb) unmappedFiles.add(to);
	if (!ea || !eb || ea === eb) continue;
	const cov = covered(ea, eb);
	if (cov) {
		coveredRelHits.add(cov);
	} else {
		const key = `${ea}\t${eb}`;
		const cur = undoc.get(key) ?? { n: 0, sample: `${from} -> ${to}` };
		cur.n++;
		undoc.set(key, cur);
	}
}

// ---- aspirational: declared rels between code-backed endpoints with zero covered hits ----
const codeBacked = new Set();
for (const { fqn } of prefixIndex) for (const c of chain(fqn)) codeBacked.add(c);
const inTargetScope = (fqn) => {
	if (!target) return true;
	for (const [f, el] of elements) if (chain(f).includes(fqn) || chain(fqn).includes(f)) for (const p of el.prefixes) if (p && (underTarget(p) || p.startsWith(target + "/") || target.startsWith(p + "/") || p === target)) return true;
	return false;
};
const aspirational = declaredRels.filter(
	(r) => codeBacked.has(r.source) && codeBacked.has(r.target) && !coveredRelHits.has(`${r.source}\t${r.target}`) && (inTargetScope(r.source) || inTargetScope(r.target)),
);

// ---- output ----
const lines = [];
lines.push("---c4-mapping---");
let mapped = 0;
for (const [fqn, el] of elements) {
	if (el.prefixes.length > 0) {
		mapped++;
		lines.push(`${fqn}\t${el.prefixes.join("; ")}`);
	}
}
const unmappedElems = [...elements.entries()].filter(([, el]) => el.prefixes.length === 0);
lines.push(`mapped: ${mapped}/${elements.size} elements (unmapped incl. actors/external: ${unmappedElems.map(([f]) => f).join(", ") || "none"})`);
lines.push("---c4-undocumented---");
for (const [key, { n, sample }] of [...undoc].sort((a, b) => b[1].n - a[1].n)) {
	const [a, b] = key.split("\t");
	lines.push(`${a} -> ${b}\tfiles=${n}\te.g. ${sample}`);
}
if (undoc.size === 0) lines.push("(none — every cross-element code edge is covered by a declared relationship)");
lines.push("---c4-aspirational---");
for (const r of aspirational) lines.push(`${r.source} -> ${r.target}\t'${r.title}'\treason=no code edge maps to this relationship`);
if (aspirational.length === 0) lines.push("(none — every code-backed declared relationship has at least one code edge)");
lines.push("---c4-summary---");
lines.push(`undocumented=${undoc.size} aspirational=${aspirational.length} unmapped_files=${unmappedFiles.size} unmapped_elements=${unmappedElems.length} status=ok`);
process.stdout.write(lines.join("\n") + "\n");
process.exit(0);
