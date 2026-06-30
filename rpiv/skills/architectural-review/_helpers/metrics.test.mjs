// metrics.test.mjs — golden-fixture self-test for the god-file responsibility gate.
//
// Builds a throwaway git repo with crafted files, runs metrics.mjs against it,
// and asserts the gate's flag / rescue / exclude decisions. No dependencies.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/metrics.test.mjs"
//
// Prints "OK ..." and exits 0 on success; throws (non-zero) on the first failed
// assertion. Proves both the false-negative fix (small-but-mixed flagged) and the
// false-positive fix (large-but-cohesive rescued), plus generated-file exclusion.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS = join(dirname(fileURLToPath(import.meta.url)), "metrics.mjs");
const git = (repo, args) =>
	execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] });

// Extract the rows of a `---<label>---` block from metrics.mjs output.
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

// --- Fixture content --------------------------------------------------------

// Small file (well under the LOC outlier threshold) importing across 5 distinct
// concern categories -> must be flagged via `mixing`, independent of LOC.
const mixedSmall = [
	`import React from "react";`, // ui
	`import { z } from "zod";`, // validation
	`import axios from "axios";`, // network
	`import bcrypt from "bcrypt";`, // auth
	`import { createClient } from "@supabase/supabase-js";`, // persistence
	``,
	...Array.from({ length: 40 }, (_, i) => `export function island${i}() { return ${i}; }`),
].join("\n");

// Large file (above the LOC outlier threshold) with ONE import category and
// fully interconnected functions (high cohesion) -> must be RESCUED (absent).
const cohesiveLargeLines = [
	`import { readFileSync } from "node:fs";`,
	``,
	`function base(x) { return x + 1; }`,
];
for (let i = 0; i < 80; i += 1) {
	cohesiveLargeLines.push(
		`function step${i}(x) {`,
		`\tconst a = base(x);`,
		`\treturn base(a) + ${i};`,
		`}`,
	);
}
const cohesiveLarge = cohesiveLargeLines.join("\n");

// Large GENERATED file (path pattern) -> must be excluded entirely.
const generatedLarge = [
	`export type Big = {`,
	...Array.from({ length: 300 }, (_, i) => `\tfield${i}: string;`),
	`};`,
].join("\n");

// Ordinary peer files to set the LOC median low.
const normal = (n) =>
	[`export function f${n}(x) { return x; }`, ...Array.from({ length: 30 }, (_, i) => `// line ${i}`)].join("\n");

// Normal-size file whose top-level symbols form disjoint islands (never
// reference each other) -> low-cohesion (Lc) candidate, but NOT a god-file
// (not a size outlier, single import category).
const fragmented = [
	`import { readFileSync } from "node:fs";`,
	``,
	...Array.from({ length: 8 }, (_, i) => `export function island${i}(x) { return x + ${i}; }`),
].join("\n");

// File whose function leans on ONE internal module far more than its own
// symbols -> feature-envy (Fe) candidate naming that module.
const envious = [
	`import { parse, format, validate } from "@/lib/contract";`,
	``,
	`export function run(input) {`,
	`\tconst a = parse(input);`,
	`\tconst b = parse(a);`,
	`\tconst c = format(b);`,
	`\tconst d = format(c);`,
	`\tvalidate(d);`,
	`\tvalidate(a);`,
	`\treturn format(d);`,
	`}`,
].join("\n");

// Balanced file: references its own symbols about as much as the import -> below
// the envy threshold, must NOT be flagged.
const balanced = [
	`import { helper } from "@/lib/util";`,
	`export function a(x) { return b(helper(x)); }`,
	`export function b(x) { return c(x); }`,
	`export function c(x) { return x + 1; }`,
].join("\n");

// Heavy use of a THIRD-PARTY import -> must NOT be flagged (internal-only rule).
const vendorHeavy = [
	`import _ from "lodash";`,
	`export function pick(o) {`,
	`\treturn _.merge(_.clone(o), _.defaults(_.omit(o), _.keys(o)));`,
	`}`,
].join("\n");

// Fe pre-filter fixtures. The raw envy metric flags any file that leans on one
// internal module; the pre-filter then DROPS candidates whose envied module has no
// BEHAVIORAL export (a constants / types / data module — you cannot envy data).
// knobs.ts = pure data (no function/class); fe-data-envy leans on it via member
// access (ext=5, own=0) so the metric flags it, but the pre-filter must DROP it.
const knobsData = [`export const KNOBS = { a: 1, b: 2, c: 3, d: 4 };`, `export const LIMIT = 10;`].join("\n");
const feDataEnvy = [
	`import { KNOBS } from "./knobs";`,
	`export function tune(x) {`,
	`\tconst a = KNOBS.a;`,
	`\tconst b = KNOBS.b;`,
	`\tconst c = KNOBS.c;`,
	`\tconst d = KNOBS.d;`,
	`\tconst e = KNOBS.a;`,
	`\treturn a + b + c + d + e + x;`,
	`}`,
].join("\n");
// calc.ts = behavioral (exported functions): a legit envy target. fe-behavior-envy
// leans on its methods (ext=5, own=0) -> flagged AND kept (the methods belong there).
const calcBehavior = [
	`export function add(a, b) { return a + b; }`,
	`export function mul(a, b) { return a * b; }`,
	`export function sub(a, b) { return a - b; }`,
].join("\n");
const feBehaviorEnvy = [
	`import { add, mul, sub } from "./calc";`,
	`export function run(x) {`,
	`\tconst a = add(x, 1);`,
	`\tconst b = mul(a, 2);`,
	`\tconst c = sub(b, 3);`,
	`\tconst d = add(c, b);`,
	`\tconst e = mul(d, a);`,
	`\treturn e;`,
	`}`,
].join("\n");

// S write-site const-resolution: a same-file `const TABLE = "inventory"` used as
// `.from(INVENTORY_TABLE).insert(...)` must be keyed on the RESOLVED table name
// (`table:inventory`), not the bare identifier.
const inventoryConstWrite = [
	`const INVENTORY_TABLE = "inventory";`,
	`export function addItem(i) {`,
	`\treturn supabase.from(INVENTORY_TABLE).insert(i);`,
	`}`,
].join("\n");

// Two files sharing a large identical body -> a content-based duplication PAIR.
const dupBody = [
	`function processRecord(record) {`,
	`\tconst normalized = record.value.trim().toLowerCase();`,
	`\tconst weighted = normalized.length * 3 + record.score;`,
	`\tconst bucket = weighted > 100 ? "high" : "low";`,
	`\tconst tags = record.tags.filter((t) => t.length > 2);`,
	`\tconst summary = { id: record.id, bucket, tags, weighted };`,
	`\tif (summary.weighted < 0) throw new Error("invalid weight");`,
	`\tconst audit = { at: Date.now(), id: record.id, bucket };`,
	`\tconst payload = JSON.stringify({ summary, audit });`,
	`\treturn { summary, audit, payload };`,
	`}`,
].join("\n");
const dupA = `export function alphaEntry(r) { return processRecord(r); }\n${dupBody}`;
const dupB = `export function betaEntry(r) { return processRecord(r); }\n${dupBody}`;

// Two files sharing a NAME token ("widget") but no identical content -> the old
// token heuristic would cluster them; the content signal must NOT flag them.
const widgetLoader = [
	`export function loadWidget(id) {`,
	`\tconst cfg = readConfig(id);`,
	`\tconst el = document.createElement("div");`,
	`\tel.dataset.widget = id;`,
	`\tconst state = { id, mounted: false, retries: 0 };`,
	`\tregisterLoader(id, state);`,
	`\tconst handle = scheduleMount(el, state);`,
	`\treturn { el, state, handle };`,
	`}`,
].join("\n");
const widgetRenderer = [
	`export function renderWidget(model) {`,
	`\tconst frame = allocateFrame(model.size);`,
	`\tconst cache = lookupCache(model.id);`,
	`\tconst pixels = rasterize(model.shapes, frame);`,
	`\tapplyPalette(pixels, model.palette, cache);`,
	`\tconst stats = measure(pixels);`,
	`\tflushFrame(frame, pixels);`,
	`\treturn { frame, stats };`,
	`}`,
].join("\n");

// Two STRUCTURALLY identical files (same token shape) with renamed identifiers
// and different literals -> low line overlap, high tokenSim -> via=structural.
const structuralClone = (s, base) => {
	const lines = [`export function compute${s}(input) {`];
	for (let i = 0; i < 30; i += 1) {
		lines.push(`\tconst value${s}${i} = input.field${s}[${base + i}] * ${base + i};`);
		lines.push(`\tif (value${s}${i} > ${base + i}) { collect${s}(value${s}${i}, "label${s}${i}"); }`);
	}
	lines.push(`\treturn value${s}0 + value${s}1;`);
	lines.push(`}`);
	return lines.join("\n");
};
const cloneA = structuralClone("Alpha", 10);
const cloneB = structuralClone("Beta", 700);

// Contiguous-run fixtures. bigclone-* share a copy-paste BLOCK that is a SMALL
// fraction of each file (low overlap ratio, below the old 0.4 line gate), so the
// contiguous-run signal is what catches it — the regression guard for a literal
// block the overlap ratio would miss. (The realistic block-in-otherwise-different-
// files case, where tokenSim is also low, is exercised by the live run, e.g.
// db/provider-exercise-catalog/types <-> db/types: overlap 0.10, tokenSim 0.31,
// run 16.) scatter-* share the SAME lines but never adjacent (max run 1) and are
// kept tiny (no structural sketch), so they must NOT flag on either signal.
const DUP_OPS = ["+", "-", "*", "/", "%", "&&", "||", "??", "===", "!==", "<=", ">=", "<", ">", "&", "|"];
const opLine = (prefix, i, base) => {
	const a = DUP_OPS[(base + i) % DUP_OPS.length];
	const b = DUP_OPS[(base + i * 3 + 1) % DUP_OPS.length];
	const c = DUP_OPS[(base + i * 5 + 2) % DUP_OPS.length];
	return `const ${prefix}${i} = p ${a} q ${b} r ${c} s;`;
};
const opFill = (prefix, n, base) =>
	Array.from({ length: n }, (_, i) => opLine(prefix, i, base)).join("\n");
const sharedBlock = [
	`const normalized = src.value.trim().toLowerCase();`,
	`const weight = normalized.length * 7 + src.score;`,
	`const tier = weight > 50 ? "high" : "low";`,
	`const flags = src.tags.filter((t) => t.length > 3);`,
	`const summary = { id: src.id, tier, flags, weight };`,
	`if (summary.weight < 0) throw new RangeError("bad");`,
	`const stamp = { at: 99, id: src.id, tier };`,
	`return { summary, stamp };`,
];
// contiguous: 30 unique varied lines, THEN the 8-line block (~21% of the file).
const bigCloneA = `export function bigA(src) {\n${opFill("a", 30, 0)}\n${sharedBlock.join("\n")}\n}\n`;
const bigCloneB = `export function bigB(src) {\n${opFill("b", 30, 8)}\n${sharedBlock.join("\n")}\n}\n`;
// scattered: each block line separated by 2 unique lines -> max run 1.
const scatShared = (i) => `const s${i} = base + ${i};`;
const scatterA = `${Array.from({ length: 6 }, (_, i) => `${scatShared(i)}\nlet qa${i} = ${i};`).join("\n")}\n`;
const scatterB = `${Array.from({ length: 6 }, (_, i) => `${scatShared(i)}\nlet qb${i} = ${i};`).join("\n")}\n`;

// Facade noise: two files sharing a contiguous block of RE-EXPORT MEMBER lines
// (bare identifiers). Those lines are excluded from the line signal, so the member
// block forms NO run -> must NOT flag (duplicated TYPES are the C lens' job). Kept
// tiny (< DUP_MIN_TOKENS) so there is no structural sketch either, isolating the
// exclusion: WITHOUT it the 8 shared member lines would be a run=8 copy-paste.
const facadeMembers = Array.from({ length: 8 }, (_, i) => `ProviderCatalogResultRow${i},`).join("\n");
const facadeA = `export type {\n${facadeMembers}\n} from "./alpha-src";\n${Array.from({ length: 8 }, (_, i) => `const ua${i} = alpha(${i});`).join("\n")}\n`;
const facadeB = `export type {\n${facadeMembers}\n} from "./beta-src";\n${Array.from({ length: 8 }, (_, i) => `const ub${i} = gamma(${i});`).join("\n")}\n`;

// --- Build repo, run, assert ------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), "argate-"));
try {
	mkdirSync(join(repo, "src"), { recursive: true });
	const write = (rel, body) => writeFileSync(join(repo, rel), body);
	for (let i = 0; i < 6; i += 1) write(`src/normal${i}.ts`, normal(i));
	write("src/mixed-small.ts", mixedSmall);
	write("src/cohesive-large.ts", cohesiveLarge);
	write("src/fragmented.ts", fragmented);
	write("src/envious.ts", envious);
	write("src/balanced.ts", balanced);
	write("src/vendor-heavy.ts", vendorHeavy);
	write("src/dup-a.ts", dupA);
	write("src/dup-b.ts", dupB);
	write("src/widget-loader.ts", widgetLoader);
	write("src/widget-renderer.ts", widgetRenderer);
	write("src/clone-alpha.ts", cloneA);
	write("src/clone-beta.ts", cloneB);
	write("src/models.generated.ts", generatedLarge);
	write("src/bigclone-a.ts", bigCloneA);
	write("src/bigclone-b.ts", bigCloneB);
	write("src/scatter-a.ts", scatterA);
	write("src/scatter-b.ts", scatterB);
	write("src/facade-a.ts", facadeA);
	write("src/facade-b.ts", facadeB);
	// write-site ownership: `orders` written from TWO modules (scattered) -> writers=2;
	// `users` written from one module -> writers=1 (single owner, must NOT read as scattered).
	write("src/orders-write-a.ts", `export function addOrder(o) {\n\treturn supabase.from("orders").insert(o);\n}\n`);
	write("src/orders-write-b.ts", `export function editOrder(o) {\n\treturn supabase.from("orders").update(o).eq("id", o.id);\n}\n`);
	write("src/users-write.ts", `export function saveUser(u) {\n\treturn supabase.from("users").upsert(u);\n}\n`);
	// Fe pre-filter: data target (dropped) vs behavioral target (kept).
	write("src/knobs.ts", knobsData);
	write("src/fe-data-envy.ts", feDataEnvy);
	write("src/calc.ts", calcBehavior);
	write("src/fe-behavior-envy.ts", feBehaviorEnvy);
	// S write-site const-table resolution.
	write("src/inventory-write.ts", inventoryConstWrite);

	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);

	const out = execFileSync("node", [METRICS, "."], { cwd: repo, encoding: "utf-8" });

	const blockOf = (label) => extractBlock(out, label);
	const candidates = blockOf("godfile-candidates");
	const sizeOutliers = blockOf("size-outliers");
	const has = (rows, name) => rows.some((r) => r.includes(name));

	// 1. Small-but-mixed file is flagged via mixing, despite low LOC.
	const mixedRow = candidates.find((r) => r.includes("mixed-small.ts"));
	assert.ok(mixedRow, `mixed-small.ts must be a god-file candidate\n--- output ---\n${out}`);
	assert.ok(mixedRow.includes("mixing"), `mixed-small.ts must be flagged 'mixing', got: ${mixedRow}`);

	// 2. Large-but-cohesive file is rescued (absent from candidates) ...
	assert.ok(!has(candidates, "cohesive-large.ts"), "cohesive-large.ts must be rescued (not a candidate)");
	// ... even though it IS a pure LOC outlier.
	assert.ok(has(sizeOutliers, "cohesive-large.ts"), "cohesive-large.ts should still appear as a raw size-outlier");

	// 3. Generated file is excluded from both blocks entirely.
	assert.ok(!has(candidates, "models.generated.ts"), "generated file must not be a candidate");
	assert.ok(!has(sizeOutliers, "models.generated.ts"), "generated file must not be a size-outlier");

	// 4. Lc lens: a normal-size disjoint-island file is a low-cohesion candidate
	//    but NOT a god-file; a cohesive file is absent from low-cohesion.
	const lowCohesion = blockOf("low-cohesion");
	assert.ok(has(lowCohesion, "fragmented.ts"), `fragmented.ts must be a low-cohesion candidate\n--- output ---\n${out}`);
	assert.ok(!has(candidates, "fragmented.ts"), "fragmented.ts must NOT be a god-file candidate (not a size outlier)");
	assert.ok(!has(lowCohesion, "cohesive-large.ts"), "cohesive-large.ts (high cohesion) must NOT be a low-cohesion candidate");

	// 5. Fe lens: a file leaning on one internal module is flagged (naming it);
	//    balanced and third-party-heavy files are not.
	const envy = blockOf("feature-envy-candidates");
	const enviousRow = envy.find((r) => r.includes("envious.ts"));
	assert.ok(enviousRow, `envious.ts must be a feature-envy candidate\n--- output ---\n${out}`);
	assert.ok(enviousRow.includes("@/lib/contract"), `envious.ts must name the envied module, got: ${enviousRow}`);
	assert.ok(!has(envy, "balanced.ts"), "balanced.ts must NOT be a feature-envy candidate (below threshold)");
	assert.ok(!has(envy, "vendor-heavy.ts"), "vendor-heavy.ts must NOT be flagged (3rd-party import, internal-only rule)");

	// 5b. Fe pre-filter: a file that envies a BEHAVIORAL module is KEPT; a file that
	//     envies a CONSTANTS/data module (no behavioral export) is DROPPED even though
	//     the raw envy metric (ext>=5, ratio 1.0) flags it — you cannot envy data.
	assert.ok(
		has(envy, "fe-behavior-envy.ts"),
		`fe-behavior-envy.ts (envies a behavioral module) must be a feature-envy candidate\n--- output ---\n${out}`,
	);
	assert.ok(
		!has(envy, "fe-data-envy.ts"),
		`fe-data-envy.ts (envies a constants module, no behavioral export) must be dropped by the Fe pre-filter\n--- output ---\n${out}`,
	);

	// 6. D lens: a content-shared pair is flagged with high overlap; a name-only
	//    coincidence (shared "widget" token, different content) is NOT.
	const dup = blockOf("dup-candidates");
	const dupRow = dup.find((r) => r.includes("dup-a.ts") && r.includes("dup-b.ts"));
	assert.ok(dupRow, `dup-a.ts | dup-b.ts must be a duplication pair\n--- output ---\n${out}`);
	const ov = Number(dupRow.match(/overlap=([\d.]+)/)?.[1]);
	assert.ok(ov >= 0.4, `dup pair overlap must clear 0.4, got: ${dupRow}`);
	assert.ok(
		!dup.some((r) => r.includes("widget-loader.ts") && r.includes("widget-renderer.ts")),
		"widget-* pair shares only a name token, must NOT be a duplication candidate",
	);

	// 7. MinHash: a structural (Type-2) clone — same shape, renamed identifiers,
	//    different literals -> flagged via=structural (high tokenSim, low overlap).
	const cloneRow = dup.find((r) => r.includes("clone-alpha.ts") && r.includes("clone-beta.ts"));
	assert.ok(cloneRow, `clone-alpha | clone-beta must be a structural duplication pair\n--- output ---\n${out}`);
	assert.ok(/via=structural/.test(cloneRow), `clone pair must be via=structural, got: ${cloneRow}`);
	const ts = Number(cloneRow.match(/tokenSim=([\d.]+)/)?.[1]);
	assert.ok(ts >= 0.4, `clone pair tokenSim must clear 0.4, got: ${cloneRow}`);

	// 8. Contiguous-run: a genuine copy-paste BLOCK in two otherwise-different files
	//    flags via its run even though overlap is below the old 0.4 gate; the SAME
	//    lines scattered (never adjacent) do NOT flag.
	const bigRow = dup.find((r) => r.includes("bigclone-a.ts") && r.includes("bigclone-b.ts"));
	assert.ok(bigRow, `bigclone pair (contiguous block, low overlap) must be a dup candidate\n--- output ---\n${out}`);
	assert.ok(
		Number(bigRow.match(/run=(\d+)/)?.[1]) >= 6,
		`bigclone pair must have a contiguous run >= 6, got: ${bigRow}`,
	);
	assert.ok(
		Number(bigRow.match(/overlap=([\d.]+)/)?.[1]) < 0.4,
		`bigclone overlap should be below the old 0.4 gate (proving the run caught it), got: ${bigRow}`,
	);
	assert.ok(
		!dup.some((r) => r.includes("scatter-a.ts") && r.includes("scatter-b.ts")),
		`scattered shared lines (max run 1) must NOT be a dup candidate\n--- output ---\n${out}`,
	);
	// 9. Facade exclusion: a shared contiguous block of re-export MEMBER identifiers
	//    is dropped from the line signal (bare-identifier lines carry no logic), so
	//    it must NOT flag — duplicated types belong to the C lens.
	assert.ok(
		!dup.some((r) => r.includes("facade-a.ts") && r.includes("facade-b.ts")),
		`re-export member block (bare identifiers) must NOT be a dup candidate\n--- output ---\n${out}`,
	);

	// 9. Write-site ownership: a table written from 2 modules => writers=2 (scattered);
	//    a table written from 1 module => writers=1 (single owner).
	const writeSites = blockOf("write-sites");
	const ordersRow = writeSites.find((r) => r.includes("table:orders"));
	assert.ok(ordersRow, `orders table must appear in write-sites\n--- output ---\n${out}`);
	assert.ok(/writers=2/.test(ordersRow), `orders (written from 2 modules) must be writers=2, got: ${ordersRow}`);
	assert.ok(
		writeSites.some((r) => r.includes("table:users") && /writers=1/.test(r)),
		`users (written from 1 module) must be writers=1\n--- output ---\n${out}`,
	);
	// 9b. Const-table resolution: `.from(INVENTORY_TABLE).insert` keys on the RESOLVED
	//     table name (`table:inventory`), never the bare identifier.
	assert.ok(
		writeSites.some((r) => r.includes("table:inventory") && /writers=1/.test(r)),
		`inventory (written via const-named table) must resolve to table:inventory\n--- output ---\n${out}`,
	);
	assert.ok(
		!writeSites.some((r) => r.includes("INVENTORY_TABLE")),
		`const table identifier must be resolved, not keyed as table:INVENTORY_TABLE\n--- output ---\n${out}`,
	);

	console.log(`OK — ${candidates.length} god-file, ${lowCohesion.length} low-cohesion, ${envy.length} feature-envy, ${dup.length} dup-pair; structural + contiguous-run dup flagged, scattered/name-coincidence ignored.`);
} finally {
	rmSync(repo, { recursive: true, force: true });
}

// === Co-change fixtures (repo2, multi-commit history) ========================
// Co-change needs real commit history, so this second repo makes dedicated
// commits changing file PAIRS together, then asserts: the genuine hidden pair
// fires; a real-import-edge hub is excluded; a re-export barrel is excluded (even
// with NO edge to its co-change partner); the pair forms a ripple-group; the
// DIRECTION arrow points from the driver; and a pair co-changing only in bulk
// (> CO_CHANGE_COMMIT_CAP-file) commits is excluded by the cap.
const repo2 = mkdtempSync(join(tmpdir(), "argate-cc-"));
try {
	for (const d of ["src/alpha", "src/beta", "src/shared", "src/db", "src/bulk"]) {
		mkdirSync(join(repo2, d), { recursive: true });
	}
	const w2 = (rel, body) => writeFileSync(join(repo2, rel), body);
	const gitc = (args) =>
		git(repo2, ["-c", "user.email=a@b.c", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);

	// writer imports the hub types.ts (a REAL edge); behavioral -> not a barrel.
	const writerBody = (n) =>
		[
			`import type { Kind } from "../shared/types";`,
			`export function writeOrder(k: Kind, v: number) {`,
			`\tconst total = v * ${n} + 1;`,
			`\treturn { k, total };`,
			`}`,
		].join("\n");
	// viewer imports NOTHING -> no edge to writer (the genuine hidden pair).
	const viewerBody = (n) =>
		[
			`export function viewOrder(total: number) {`,
			`\tconst label = "order:" + (total + ${n});`,
			`\treturn label;`,
			`}`,
		].join("\n");
	const typesBody = (n) => `export type Kind = "a" | "b";\nexport const KIND_COUNT = ${n};\n`;
	// pure re-export barrel (no behavioral symbol of its own).
	const barrelBody = (n) => `export * from "./writer";\n// rev ${n}\n`;
	// driver changes ONLY with follower; follower also changes alone -> conf(driver->follower)
	// = 1.0 but conf(follower->driver) < 1, so the arrow must point driver -> follower.
	const driverBody = (n) => `export function runDriver(x: number) {\n\treturn x + ${n};\n}\n`;
	const followerBody = (n) => `export function runFollower(x: number) {\n\treturn x * ${n};\n}\n`;

	w2("src/alpha/writer.ts", writerBody(0));
	w2("src/beta/viewer.ts", viewerBody(0));
	w2("src/shared/types.ts", typesBody(0));
	w2("src/alpha/index.ts", barrelBody(0));
	w2("src/alpha/driver.ts", driverBody(0));
	w2("src/beta/follower.ts", followerBody(0));

	// (Duplication precision, including the contiguous-run vs scattered-idiom guards,
	// is covered by the first repo above; repo2 focuses on co-change history.)
	gitc(["init", "-q"]);
	gitc(["add", "-A"]);
	gitc(["commit", "-q", "-m", "init"]);

	const coCommit = (label, rev, bodies) => {
		for (const [rel, body] of bodies) w2(rel, body);
		gitc(["add", "-A"]);
		gitc(["commit", "-q", "-m", `${label}-${rev}`]);
	};
	// A: writer + viewer (genuine hidden pair, no import edge between them).
	for (let i = 1; i <= 4; i += 1) {
		coCommit("wv", i, [
			["src/alpha/writer.ts", writerBody(i)],
			["src/beta/viewer.ts", viewerBody(i)],
		]);
	}
	// B: writer + hub types (writer imports types -> real edge -> excluded).
	for (let i = 1; i <= 4; i += 1) {
		coCommit("wt", i, [
			["src/alpha/writer.ts", writerBody(i + 10)],
			["src/shared/types.ts", typesBody(i)],
		]);
	}
	// C: barrel index + viewer (index does NOT import viewer -> only barrel
	//    exclusion can drop this pair; proves barrel exclusion in isolation).
	for (let i = 1; i <= 4; i += 1) {
		coCommit("bv", i, [
			["src/alpha/index.ts", barrelBody(i)],
			["src/beta/viewer.ts", viewerBody(i + 100)],
		]);
	}
	// D: driver + follower together; follower also changes ALONE -> tests DIRECTION.
	for (let i = 1; i <= 3; i += 1) {
		coCommit("df", i, [
			["src/alpha/driver.ts", driverBody(i)],
			["src/beta/follower.ts", followerBody(i)],
		]);
	}
	for (let i = 1; i <= 3; i += 1) {
		coCommit("f-alone", i, [["src/beta/follower.ts", followerBody(i + 100)]]);
	}
	// F: boundary — a pair co-changing only TWICE (support 2 < CO_CHANGE_MIN_SUPPORT)
	//    must NOT surface. Created after init so init doesn't lift its support to 3.
	for (let i = 1; i <= 2; i += 1) {
		coCommit("s2", i, [
			["src/alpha/s2a.ts", `export function s2a() {\n\treturn ${i};\n}\n`],
			["src/beta/s2b.ts", `export function s2b() {\n\treturn ${i};\n}\n`],
		]);
	}
	// G: boundary — a pair with support >= MIN_SUPPORT but conf < CO_CHANGE_MIN_CONF
	//    must be dropped. cfA & cfB co-change 3x, but each ALSO changes alone 4x ->
	//    conf = 3 / min(7,7) = 0.43 < 0.5.
	for (let i = 1; i <= 3; i += 1) {
		coCommit("cf", i, [
			["src/alpha/cfA.ts", `export function cfA() {\n\treturn ${i};\n}\n`],
			["src/beta/cfB.ts", `export function cfB() {\n\treturn ${i};\n}\n`],
		]);
	}
	for (let i = 1; i <= 4; i += 1) coCommit("cfA-solo", i, [["src/alpha/cfA.ts", `export function cfA() {\n\treturn ${i + 50};\n}\n`]]);
	for (let i = 1; i <= 4; i += 1) coCommit("cfB-solo", i, [["src/beta/cfB.ts", `export function cfB() {\n\treturn ${i + 50};\n}\n`]]);
	// E: bulkA + bulkB co-change ONLY in commits larger than the adaptive cap's CEILING
	//    (50) -> those commits are skipped as refactor noise. Without the cap these 4
	//    co-changes (support 4) would surface the pair; with it, it must not.
	for (let rev = 1; rev <= 4; rev += 1) {
		const bulk = Array.from({ length: 49 }, (_, i) => [`src/bulk/f${i}.ts`, `export const f${i} = ${rev};\n`]);
		bulk.push(["src/bulk/bulkA.ts", `export function bulkA() {\n\treturn ${rev};\n}\n`]);
		bulk.push(["src/bulk/bulkB.ts", `export function bulkB() {\n\treturn ${rev};\n}\n`]);
		coCommit("bulk", rev, bulk); // 51 files > ceiling (50) -> the whole commit is skipped
	}

	const out2 = execFileSync("node", [METRICS, "."], { cwd: repo2, encoding: "utf-8" });
	const co = extractBlock(out2, "co-change-candidates");
	const groups = extractBlock(out2, "co-change-groups");

	// Co-change fires on the genuine hidden pair (writer <-> viewer).
	assert.ok(
		co.some((r) => r.includes("src/alpha/writer.ts") && r.includes("src/beta/viewer.ts")),
		`genuine hidden pair (writer<->viewer) must appear in co-change\n--- out ---\n${out2}`,
	);
	// Hub excluded: writer imports shared/types.ts (real edge) -> not "hidden".
	assert.ok(
		!co.some((r) => r.includes("src/shared/types.ts")),
		`hub types.ts has a real import edge from writer and must NOT appear in co-change\n--- out ---\n${out2}`,
	);
	// Barrel excluded: alpha/index.ts is a pure re-export, co-changed with viewer
	// (no edge between them) -> only barrel exclusion can drop it.
	assert.ok(
		!co.some((r) => r.includes("src/alpha/index.ts")),
		`re-export barrel index.ts must NOT appear in co-change\n--- out ---\n${out2}`,
	);
	// Ripple-group clusters the genuine pair (support >= group threshold).
	assert.ok(
		groups.some((r) => r.includes("src/alpha/writer.ts") && r.includes("src/beta/viewer.ts")),
		`ripple-group must contain the writer<->viewer pair\n--- out ---\n${out2}`,
	);
	// Direction: driver changes only WITH follower (conf 1.0) while follower also
	// changes alone (conf back < 1) -> the arrow must point driver -> follower.
	const dirRow = co.find((r) => r.includes("src/alpha/driver.ts") && r.includes("src/beta/follower.ts"));
	assert.ok(dirRow, `directional pair (driver/follower) must appear in co-change\n--- out ---\n${out2}`);
	assert.ok(
		/src\/alpha\/driver\.ts -> .*src\/beta\/follower\.ts/.test(dirRow),
		`co-change arrow must point from the driver (driver -> follower), got: ${dirRow}`,
	);
	// Bulk-commit cap: bulkA <-> bulkB co-change only in commits above the adaptive
	// cap's ceiling -> excluded as refactor noise (without the cap, support 4 would surface).
	assert.ok(
		!co.some((r) => r.includes("bulkA.ts") && r.includes("bulkB.ts")),
		`pair co-changing only in bulk (>ceiling-file) commits must be excluded by the cap\n--- out ---\n${out2}`,
	);
	// Boundary: support below MIN_SUPPORT (co-changed only twice) -> not a candidate.
	assert.ok(
		!co.some((r) => r.includes("src/alpha/s2a.ts") && r.includes("src/beta/s2b.ts")),
		`pair with support 2 (< CO_CHANGE_MIN_SUPPORT) must NOT appear in co-change\n--- out ---\n${out2}`,
	);
	// Boundary: support >= MIN_SUPPORT but conf 3/7 < MIN_CONF -> dropped.
	assert.ok(
		!co.some((r) => r.includes("src/alpha/cfA.ts") && r.includes("src/beta/cfB.ts")),
		`pair with conf 0.43 (< CO_CHANGE_MIN_CONF) must NOT appear in co-change\n--- out ---\n${out2}`,
	);
	console.log(
		`OK (co-change) — hidden pair fires, directional; hub + barrel + bulk + low-support + low-conf excluded (${co.length} candidates, ${groups.length} groups).`,
	);
} finally {
	rmSync(repo2, { recursive: true, force: true });
}

// === Adaptive bulk-commit cap (repo3) =======================================
// The cap is the p95 of the repo's OWN commit sizes (clamped), not a fixed 25.
// Here EVERY commit touches 26 source files -> the cap adapts UP to 26, so a pair
// co-changing in those commits SURFACES; under the old fixed cap of 25 it would
// have been dropped. Unique fillers per commit keep p1<->p2 the only high-support pair.
const repo3 = mkdtempSync(join(tmpdir(), "argate-cap-"));
try {
	mkdirSync(join(repo3, "src/big"), { recursive: true });
	const w3 = (rel, body) => writeFileSync(join(repo3, rel), body);
	const gitc3 = (args) =>
		git(repo3, ["-c", "user.email=a@b.c", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
	gitc3(["init", "-q"]);
	for (let rev = 1; rev <= 3; rev += 1) {
		w3("src/big/p1.ts", `export function p1() {\n\treturn ${rev};\n}\n`);
		w3("src/big/p2.ts", `export function p2() {\n\treturn ${rev};\n}\n`);
		for (let i = 0; i < 24; i += 1) w3(`src/big/r${rev}f${i}.ts`, `export const r${rev}f${i} = ${i};\n`);
		gitc3(["add", "-A"]);
		gitc3(["commit", "-q", "-m", `big-${rev}`]); // 26 source files: p1, p2 + 24 unique fillers
	}
	const out3 = execFileSync("node", [METRICS, "."], { cwd: repo3, encoding: "utf-8" });
	const co3 = extractBlock(out3, "co-change-candidates");
	assert.ok(
		co3.some((r) => r.includes("src/big/p1.ts") && r.includes("src/big/p2.ts")),
		`adaptive cap must lift to the repo's 26-file commit norm so p1<->p2 surfaces (a fixed cap of 25 would drop it)\n--- out ---\n${out3}`,
	);
	console.log("OK (adaptive cap) — p95 lifted the cap to admit 26-file commits; p1<->p2 surfaced.");
} finally {
	rmSync(repo3, { recursive: true, force: true });
}
