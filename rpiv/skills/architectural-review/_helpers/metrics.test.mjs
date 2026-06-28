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
	write("src/models.generated.ts", generatedLarge);

	git(repo, ["init", "-q"]);
	git(repo, ["add", "-A"]);

	const out = execFileSync("node", [METRICS, "."], { cwd: repo, encoding: "utf-8" });

	const blockOf = (label) => {
		const lines = out.split("\n");
		const start = lines.indexOf(`---${label}---`);
		if (start < 0) return [];
		const rows = [];
		for (let i = start + 1; i < lines.length; i += 1) {
			if (lines[i].startsWith("---")) break;
			if (lines[i].trim()) rows.push(lines[i]);
		}
		return rows;
	};
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

	console.log(`OK — ${candidates.length} god-file, ${lowCohesion.length} low-cohesion, ${envy.length} feature-envy, ${dup.length} dup-pair; content-dup flagged, name-coincidence ignored.`);
} finally {
	rmSync(repo, { recursive: true, force: true });
}
