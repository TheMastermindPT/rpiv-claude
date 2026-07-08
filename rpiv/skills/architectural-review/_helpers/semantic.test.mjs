// semantic.test.mjs — golden-fixture test for semantic.mjs (the ts-morph backer).
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/semantic.test.mjs"
//
// Builds a throwaway repo with a real tsconfig.json, runs semantic.mjs against it, and
// asserts the three type-resolved signals that regex/token analysis cannot produce:
//   - write-sites: `.from(IMPORTED_TABLE)` resolves to the RESOLVED table name across files;
//   - feature-envy: a behavioral envier is emitted, a data-only "envier" is dropped;
//   - dead-exports: an unreferenced export is flagged, a used one is not.
// Plus the graceful-degradation path (no tsconfig -> `unavailable`, exit 0).
//
// SELF-SKIPS (prints SKIP, exits 0) if ts-morph is not resolvable, so it never red-fails a
// ts-morph-less environment. Prints "OK ..." on success; throws on the first failed assertion.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEMANTIC = join(dirname(fileURLToPath(import.meta.url)), "semantic.mjs");
const git = (repo, args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });

// Self-skip if ts-morph cannot be resolved from this helper's location.
try {
	createRequire(import.meta.url).resolve("ts-morph");
} catch {
	console.log("SKIP (semantic) — ts-morph not resolvable from the helper location; install it to run this test.");
	process.exit(0);
}

const extractBlock = (text, label) => {
	const lines = text.split("\n");
	const start = lines.indexOf(`---${label}---`);
	if (start < 0) return [];
	const rows = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		if (lines[i].startsWith("---")) break;
		if (lines[i].trim()) rows.push(lines[i]);
	}
	return rows;
};

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		strict: true,
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "Bundler",
		noEmit: true,
		skipLibCheck: true,
	},
	include: ["src"],
});

// --- Fixture content --------------------------------------------------------

// A module exporting BEHAVIOR (functions), DATA (const + type), and one UNUSED export.
const tables = [
	`export const ORDERS_TABLE = "orders";`,
	`export const TAX_RATE = 0.2;`,
	`export type OrderShape = { id: string };`,
	`export interface DeadIface { a: number }`, // referenced nowhere -> dead
	`export function computeTotal(x: number) { return x + 1; }`,
	`export function applyDiscount(x: number) { return x - 1; }`,
	`export function roundCents(x: number) { return Math.round(x); }`,
].join("\n");

// Two writers of the SAME table via the IMPORTED const -> table:orders writers=2.
// (metrics.mjs regex resolves only same-file consts, so it would miss this entirely.)
const orderWriter = [
	`import { ORDERS_TABLE } from "./tables";`,
	`const supabase: any = {};`,
	`export function addOrder(o: any) { return supabase.from(ORDERS_TABLE).insert(o); }`,
].join("\n");
const orderEditor = [
	`import { ORDERS_TABLE } from "./tables";`,
	`const supabase: any = {};`,
	`export function editOrder(o: any) { return supabase.from(ORDERS_TABLE).update(o).eq("id", o.id); }`,
].join("\n");

// Leans on the module's BEHAVIOR (6 function calls, 0 data) -> a genuine Fe candidate.
const behavioralEnvier = [
	`import { computeTotal, applyDiscount, roundCents } from "./tables";`,
	`export function run(x: number) {`,
	`\tconst a = computeTotal(x);`,
	`\tconst b = applyDiscount(a);`,
	`\tconst c = roundCents(b);`,
	`\tconst d = computeTotal(c);`,
	`\tconst e = applyDiscount(d);`,
	`\treturn roundCents(e);`,
	`}`,
].join("\n");

// Leans only on the module's DATA (const + type, 0 behavior) -> must be DROPPED:
// you cannot have feature-envy toward data. The per-symbol split is what regex can't do.
const dataEnvier = [
	`import { TAX_RATE, type OrderShape } from "./tables";`,
	`export function tax(o: OrderShape) {`,
	`\tconst a = TAX_RATE, b = TAX_RATE, c = TAX_RATE, d = TAX_RATE, e = TAX_RATE;`,
	`\treturn o.id.length + a + b + c + d + e;`,
	`}`,
].join("\n");

// C-lens fixtures: same shape under different names (>=3 props) -> same-shape;
// same name with a drifted shape -> drift; a trivial 2-prop shape -> must NOT flag.
const shapesA = [
	`export type Widget = { width: number; height: number; depth: number };`,
	`export type Pt = { x: number; y: number };`, // 2 props -> below guard, must not flag
].join("\n");
const shapesB = [
	`export type Box = { width: number; height: number; depth: number };`, // same shape as Widget, different name
	`export type Pt2 = { x: number; y: number };`, // trivial twin of Pt -> must not flag
].join("\n");
const driftA = `export interface Account { id: string; name: string; balance: number }`;
const driftB = `export interface Account { id: string; name: string; balance: number; currency: string }`; // same name, drifted

// M/D-lens fixtures: two object-literal PROJECTIONS sharing 9/10 keys (Jaccard 9/11 =
// 0.82) -> must pair; a same-keyed literal built with a spread -> partial key set, must
// NOT participate. Mirrors the gymapp M3 class (exact vs family snapshot, 21/22 fields).
const projKeys = (extra) =>
	`{ a1: 1, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, ${extra} }`;
const projA = `export function exactSnapshot() {\n\treturn ${projKeys("exactOnly: 10")};\n}`;
const projB = `export function familySnapshot() {\n\treturn ${projKeys("familyOnly: 10")};\n}`;
const projSpread = [
	`const base = { a1: 1 };`,
	`export function spreadSnapshot() {`,
	`\treturn { ...base, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, spreadOnly: 10 };`,
	`}`,
].join("\n");

// --- Build repo, run, assert ------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), "argate-sem-"));
try {
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "tsconfig.json"), TSCONFIG);
	const write = (rel, body) => writeFileSync(join(repo, rel), body);
	write("src/tables.ts", tables);
	write("src/order-writer.ts", orderWriter);
	write("src/order-editor.ts", orderEditor);
	write("src/behavioral-envier.ts", behavioralEnvier);
	write("src/data-envier.ts", dataEnvier);
	write("src/shapes-a.ts", shapesA);
	write("src/shapes-b.ts", shapesB);
	write("src/drift-a.ts", driftA);
	write("src/drift-b.ts", driftB);
	write("src/proj-a.ts", projA);
	write("src/proj-b.ts", projB);
	write("src/proj-spread.ts", projSpread);
	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);

	const out = execFileSync("node", [SEMANTIC, "."], { cwd: repo, encoding: "utf-8" });
	assert.ok(
		!out.includes("---semantic-status---"),
		`semantic.mjs reported unavailable on a valid tsconfig project:\n${out}`,
	);

	// 1. write-sites: imported-const table name resolved to "orders", written from 2 modules.
	const writes = extractBlock(out, "write-sites-semantic");
	const ordersRow = writes.find((r) => r.includes("table:orders"));
	assert.ok(ordersRow, `table:orders must appear in write-sites-semantic (resolved from the imported const)\n${out}`);
	assert.ok(/writers=2/.test(ordersRow), `orders written from 2 modules must be writers=2, got: ${ordersRow}`);
	assert.ok(
		ordersRow.includes("order-writer.ts") && ordersRow.includes("order-editor.ts"),
		`both writers must be listed, got: ${ordersRow}`,
	);
	assert.ok(!writes.some((r) => r.includes("ORDERS_TABLE")), `the const identifier must be resolved, not keyed raw\n${out}`);

	// 2. feature-envy: behavioral envier emitted (behavioralRefs>0); data-only envier dropped.
	const envy = extractBlock(out, "feature-envy-semantic");
	const behRow = envy.find((r) => r.includes("behavioral-envier.ts"));
	assert.ok(behRow, `behavioral-envier.ts must be a feature-envy candidate\n${out}`);
	assert.ok(/dataRefs=0/.test(behRow), `behavioral-envier must be all-behavioral (dataRefs=0), got: ${behRow}`);
	const behN = Number(behRow.match(/behavioralRefs=(\d+)/)?.[1]);
	assert.ok(behN >= 3, `behavioral-envier must have behavioralRefs>=3, got: ${behRow}`);
	assert.ok(
		!envy.some((r) => r.includes("data-envier.ts")),
		`data-envier.ts (references only consts/types, behavioralRefs=0) must be DROPPED by the per-symbol split\n${out}`,
	);

	// 3. dead-exports: the unreferenced interface is flagged; a used function is not.
	const dead = extractBlock(out, "dead-exports-semantic");
	assert.ok(
		dead.some((r) => r.includes("tables.ts:DeadIface") && /extRefs=0/.test(r)),
		`DeadIface (referenced nowhere) must be a dead-export\n${out}`,
	);
	assert.ok(
		!dead.some((r) => r.includes(":computeTotal")),
		`computeTotal (used by behavioral-envier) must NOT be flagged dead\n${out}`,
	);

	// 4. type fragmentation: same-shape-different-name flagged; same-name-drift flagged;
	//    a trivial 2-prop shape is NOT flagged (FP guard).
	const frag = extractBlock(out, "type-fragmentation-semantic");
	assert.ok(
		frag.some((r) => /kind=same-shape/.test(r) && r.includes("Widget") && r.includes("Box")),
		`Widget/Box (identical 3-prop shape, different names) must be a same-shape candidate\n${out}`,
	);
	assert.ok(
		frag.some((r) => /kind=drift/.test(r) && r.includes("name=Account")),
		`Account (same name, drifted shape across files) must be a drift candidate\n${out}`,
	);
	assert.ok(
		!frag.some((r) => r.includes("Pt") || r.includes("Pt2")),
		`trivial 2-prop shapes (Pt/Pt2) must NOT flag (below the >=3-prop guard)\n${out}`,
	);

	// 5. projection-shapes: near-identical object literals pair across files; the
	// spread-built twin (partial key set) must not participate.
	const proj = extractBlock(out, "projection-shapes-semantic");
	const pairRow = proj.find((r) => r.includes("proj-a.ts") && r.includes("proj-b.ts"));
	assert.ok(pairRow, `proj-a/proj-b (9/10 shared keys) must pair in projection-shapes-semantic\n${out}`);
	assert.ok(/shared=9\/11/.test(pairRow), `pair must report shared=9/11, got: ${pairRow}`);
	assert.ok(!proj.some((r) => r.includes("proj-spread.ts")), `spread-built literal (partial key set) must NOT participate\n${out}`);

	console.log(
		`OK (semantic) — imported-const write resolved (writers=2), behavioral envy kept + data-only dropped, dead export flagged, type drift + same-shape flagged, projection pair seeded (${writes.length} write-sites, ${envy.length} envy, ${dead.length} dead, ${frag.length} type-frag, ${proj.length} proj-pairs).`,
	);
} finally {
	rmSync(repo, { recursive: true, force: true });
}

// --- Graceful degradation: no tsconfig -> unavailable, exit 0 ---------------
const repoNoTs = mkdtempSync(join(tmpdir(), "argate-sem-nots-"));
try {
	mkdirSync(join(repoNoTs, "src"), { recursive: true });
	writeFileSync(join(repoNoTs, "src/x.ts"), `export const a = 1;\n`);
	git(repoNoTs, ["init", "-q"]);
	git(repoNoTs, ["add", "-A"]);
	const out = execFileSync("node", [SEMANTIC, "."], { cwd: repoNoTs, encoding: "utf-8" });
	assert.ok(out.includes("---semantic-status---"), `no-tsconfig repo must emit a status block\n${out}`);
	assert.ok(/unavailable: no tsconfig/.test(out), `no-tsconfig repo must report unavailable, got:\n${out}`);
	console.log("OK (semantic degradation) — no tsconfig -> unavailable, exit 0 (review falls back to regex signals).");
} finally {
	rmSync(repoNoTs, { recursive: true, force: true });
}

// --- Dead-exports is knip's fallback: present -> skip the (slow, redundant) A pass ---
const repoKnip = mkdtempSync(join(tmpdir(), "argate-sem-knip-"));
try {
	mkdirSync(join(repoKnip, "src"), { recursive: true });
	writeFileSync(join(repoKnip, "tsconfig.json"), TSCONFIG);
	writeFileSync(join(repoKnip, "package.json"), JSON.stringify({ name: "x", devDependencies: { knip: "^5" } }));
	// an unreferenced export that WOULD be flagged dead if the A pass ran
	writeFileSync(join(repoKnip, "src/x.ts"), `export interface NeverUsed { a: number }\nexport const used = 1;\nconsole.log(used);\n`);
	git(repoKnip, ["init", "-q"]);
	git(repoKnip, ["add", "-A"]);
	const out = execFileSync("node", [SEMANTIC, "."], { cwd: repoKnip, encoding: "utf-8" });
	assert.ok(/dead_export_scan: skipped \(knip present/.test(out), `knip present -> dead-export scan must be skipped, got:\n${out}`);
	assert.ok(
		extractBlock(out, "dead-exports-semantic").length === 0,
		`knip present -> dead-exports block must be empty (A delegated to knip)\n${out}`,
	);
	console.log("OK (semantic knip-fallback) — knip present -> dead-exports skipped (A delegated to knip, findReferences pass avoided).");
} finally {
	rmSync(repoKnip, { recursive: true, force: true });
}
