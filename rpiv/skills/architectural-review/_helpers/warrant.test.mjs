// warrant.test.mjs — predicate + band tests for warrant.mjs, anchored to REAL gymapp
// calibration numbers (2026-07). Proves the counterexample: a structurally-silent target
// with a genuine cross-cutting finding warrants a selective wave, not a skip.
// No dependencies; prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = join(dirname(fileURLToPath(import.meta.url)), "warrant.mjs");
const tmp = mkdtempSync(join(tmpdir(), "warrant-"));

// Run warrant.mjs with `metrics` on stdin; opts.semantic written to a temp file.
function warrant(metrics, opts = {}) {
  const args = [];
  if (opts.files != null) args.push(`--files=${opts.files}`);
  if (opts.knipDead != null) args.push(`--knip-dead=${opts.knipDead}`);
  if (opts.ownerNone != null) args.push(`--owner-none=${opts.ownerNone}`);
  if (opts.pre10) args.push("--pre10");
  if (opts.coverageGaps != null) args.push(`--coverage-gaps=${opts.coverageGaps}`);
  if (opts.semantic != null) {
    const p = join(tmp, `sem-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(p, opts.semantic);
    args.push(`--semantic=${p}`);
  }
  const out = execFileSync("node", [W, ...args], { input: metrics, encoding: "utf-8" });
  return JSON.parse(out.trim());
}

// Tiny block builders.
const block = (label, rows = []) => `---${label}---\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
const empties = (...labels) => labels.map((l) => block(l)).join("");

// ── Case 1: adaptive-context (17f) — THE counterexample ────────────────────
// G=0 Lc=0 D=0 (structurally SILENT) but a real Fe seed. Old gate: SKIP. Warrant: selective[Fe].
{
  const metrics =
    "file_count: 17\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "export-usage", "write-sites", "co-change-groups", "test-density") +
    block("feature-envy-candidates", [
      "lib/generation/adaptive-context/applied-rules-trace.ts\tenvies=@/lib/generation/rationale-snapshot\text=9\town=3\tratio=0.75",
      "lib/generation/adaptive-context/service.ts\tenvies=@/lib/generation/adaptive-context/history\text=9\town=4\tratio=0.69",
    ]);
  const r = warrant(metrics, { knipDead: 0 });
  assert.equal(r.band, "selective", "adaptive-context → selective (not skip)");
  assert.deepEqual(r.liveLenses, ["Fe"], "only Fe warranted (ratio=0.75,own=3; service ratio=0.69 excluded)");
  assert.deepEqual(r.selectiveWave2, ["Fe", "M", "L"], "selective runs Fe + always-on M/L");
  assert.equal(r.prompt, false, "selective auto-runs, no prompt");
  assert.deepEqual(r.unmeasured, ["C"], "C unmeasured without a semantic pass");
}

// ── Case 2: adaptive-application (9f) — Fe live, lone structural dup does NOT warrant D ──
{
  const metrics =
    "file_count: 9\n" +
    empties("godfile-candidates", "low-cohesion", "export-usage", "write-sites", "co-change-groups", "test-density") +
    block("dup-candidates", ["a.ts | b.ts\trun=0\tshared=6\toverlap=0.10\ttokenSim=0.82\tvia=structural"]) +
    block("feature-envy-candidates", ["lib/generation/adaptive-application/exact-transforms.ts\tenvies=./prescription-mutators\text=14\town=3\tratio=0.82"]);
  const r = warrant(metrics, { knipDead: 0 });
  assert.equal(r.band, "selective", "adaptive-application → selective");
  assert.equal(r.lenses.D, false, "a single via=structural pair does not warrant D");
  assert.ok(r.liveLenses.includes("Fe"), "Fe warranted");
}

// ── Case 3: lib/domain (22f) — genuinely clean cross-cutting (semantic confirms C=0) ──
{
  const metrics =
    "file_count: 22\n" +
    empties("godfile-candidates", "feature-envy-candidates", "export-usage", "write-sites", "co-change-groups", "test-density") +
    block("low-cohesion", ["lib/domain/string-normalization.ts\tcoh=0.33\tsyms=7\tislands=5"]) +
    block("dup-candidates", ["a.ts | b.ts\trun=8\tshared=8\toverlap=0.3\ttokenSim=0.4\tvia=lines"]);
  const semantic =
    "files_in_target: 22\n" +
    block("write-sites-semantic") + block("feature-envy-semantic") + block("dead-exports-semantic") + block("type-fragmentation-semantic");
  const r = warrant(metrics, { files: 22, knipDead: 0, semantic });
  assert.equal(r.band, "selective", "lib/domain → selective (Lc+D), not full");
  assert.deepEqual(r.liveLenses.sort(), ["D", "Lc"], "only Lc + literal-D warranted");
  assert.deepEqual(r.unmeasured, [], "C measured (semantic ran) and clean → not unmeasured");
  assert.equal(r.lenses.C, false, "0 type-fragmentation over the examined types");
}

// ── Case 4: lib (258f) — big + multi-axis dirty → full, prompt ─────────────
{
  const feRows = Array.from({ length: 5 }, (_, i) => `f${i}.ts\tenvies=@/m\text=10\town=3\tratio=0.85`);
  const dupRows = Array.from({ length: 13 }, (_, i) => `a${i}.ts | b${i}.ts\trun=0\tshared=5\toverlap=0.1\ttokenSim=0.9\tvia=structural`);
  const metrics =
    "file_count: 258\n" +
    empties("export-usage", "co-change-groups", "test-density") +
    block("godfile-candidates", ["lib/db/weekly-plans.ts\t589\t6.1x\tcats=1\tcoh=0.38\tsize+low-cohesion"]) +
    block("low-cohesion", ["a.ts\tcoh=0.2\tsyms=10\tislands=8", "b.ts\tcoh=0.3\tsyms=9\tislands=6", "c.ts\tcoh=0.3\tsyms=7\tislands=5", "d.ts\tcoh=0.33\tsyms=7\tislands=5"]) +
    block("dup-candidates", dupRows) +
    block("feature-envy-candidates", feRows) +
    block("write-sites", ["table:x\twriters=2\tfiles=a.ts, b.ts"]);
  const r = warrant(metrics, { knipDead: 0 });
  assert.equal(r.band, "full", "lib → full (258 files ≥ 100)");
  assert.equal(r.prompt, true, "full sweep prompts the developer");
  assert.deepEqual(r.selectiveWave2, ["C", "A", "T", "L", "M", "S", "Fe"], "full runs all seven Wave-2 lenses");
  assert.ok(r.liveCount >= 4, "multiple lenses live");
}

// ── Case 5: lib/db (36f) — structurally moderate + real C drift + knip A → full ──
// Also proves: semantic write-sites (all writers=1) SUPERSEDES the metric's writers=2 false positive.
{
  const metrics =
    "file_count: 36\n" +
    empties("godfile-candidates", "feature-envy-candidates", "export-usage", "co-change-groups", "test-density") +
    block("low-cohesion", ["a.ts\tcoh=0.3\tsyms=7\tislands=5", "b.ts\tcoh=0.35\tsyms=6\tislands=4"]) +
    block("dup-candidates", ["a.ts | b.ts\tvia=lines", "c.ts | d.ts\tvia=lines", "e.ts | f.ts\tvia=structural"]) +
    block("write-sites", ["table:weekly_plans\twriters=2\tfiles=a.ts, b.ts"]); // metric says 2...
  const semantic =
    "files_in_target: 36\n" +
    block("write-sites-semantic", ["table:weekly_plans\twriters=1\tfiles=lib/db/weekly-plans.ts"]) + // ...semantic corrects to 1
    block("feature-envy-semantic", ["lib/db/athlete-profile-mappers.ts\tenvies=lib/domain/intake-contract.ts\text=29\town=4\tratio=0.88\tbehavioralRefs=6\tdataRefs=23"]) +
    block("dead-exports-semantic") +
    block("type-fragmentation-semantic", ["kind=drift\tname=ExerciseSourceBindingRow\tdefs=2\tfiles=lib/db/exercises/presentation.ts:21, lib/db/provider-exercise-catalog/types.ts:51"]);
  const r = warrant(metrics, { files: 36, knipDead: 4, semantic });
  assert.equal(r.lenses.S, false, "semantic write-sites (writers=1) supersedes metric writers=2 → S clean");
  assert.equal(r.lenses.C, true, "type-fragmentation drift → C live");
  assert.equal(r.lenses.A, true, "knip found 4 dead → A live (export-usage was blind to them)");
  assert.equal(r.band, "full", "lib/db → full (≥4 lenses: Lc,D,C,A,Fe)");
}

// ── Predicate units ────────────────────────────────────────────────────────
// A: export-usage inbound=0 counts, inbound=? (capped hub) does NOT.
{
  const m = "file_count: 10\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "feature-envy-candidates", "write-sites", "co-change-groups", "test-density") +
    block("export-usage", ["hub.ts\texports=68\tinbound=?", "dead.ts\texports=4\tinbound=0"]);
  const r = warrant(m); // no --knip-dead → fall through to export-usage
  assert.equal(r.lenses.A, true, "inbound=0 makes A live");
}
{
  const m = "file_count: 10\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "feature-envy-candidates", "write-sites", "co-change-groups", "test-density") +
    block("export-usage", ["hub.ts\texports=68\tinbound=?"]);
  const r = warrant(m);
  assert.equal(r.lenses.A, false, "inbound=? (capped) is NOT dead → A stays clean");
  assert.equal(r.band, "skip", "no live seed at all → skip");
}

// Fe: constants file (own=0, ratio=1.0) is rejected.
{
  const m = "file_count: 10\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "export-usage", "write-sites", "co-change-groups", "test-density") +
    block("feature-envy-candidates", ["constants.ts\tenvies=@/m\text=5\town=0\tratio=1.00"]);
  const r = warrant(m, { knipDead: 0 });
  assert.equal(r.lenses.Fe, false, "own=0 constants file is not feature envy");
  assert.equal(r.band, "skip");
}

// S: second seed — a System-Model owner:NONE entity warrants S even with writers<2.
{
  const m = "file_count: 15\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "feature-envy-candidates", "export-usage", "co-change-groups", "test-density") +
    block("write-sites", ["table:x\twriters=1\tfiles=a.ts"]);
  assert.equal(warrant(m, { knipDead: 0 }).lenses.S, false, "writers=1 alone → S clean");
  const r = warrant(m, { knipDead: 0, ownerNone: 2 });
  assert.equal(r.lenses.S, true, "owner:NONE entity → S warranted even at writers=1");
  assert.equal(r.band, "selective");
  assert.ok(r.selectiveWave2.includes("S"), "S dispatched in selective when its owner seed fires");
}

// Band boundaries.
{
  // liveCount == 4 forces full even below 100 files.
  const m = "file_count: 20\n" +
    empties("export-usage", "write-sites", "co-change-groups", "test-density") +
    block("godfile-candidates", ["g.ts\t500\t5x\tcats=3\tcoh=0.3\tmixing"]) +
    block("low-cohesion", ["l.ts\tcoh=0.2\tsyms=8\tislands=6"]) +
    block("dup-candidates", ["a|b\tvia=lines"]) +
    block("feature-envy-candidates", ["e.ts\tenvies=@/m\text=10\town=3\tratio=0.8"]);
  const r = warrant(m, { knipDead: 0 });
  assert.equal(r.liveCount, 4, "G,Lc,D,Fe live");
  assert.equal(r.band, "full", "≥4 warranted lenses → full even on a small target");
}
{
  // pre-1.0 forces full even when nothing is live.
  const m = "file_count: 12\n" +
    empties("godfile-candidates", "low-cohesion", "dup-candidates", "feature-envy-candidates", "export-usage", "write-sites", "co-change-groups", "test-density");
  const r = warrant(m, { knipDead: 0, pre10: true });
  assert.equal(r.band, "full", "pre-1.0 → full sweep regardless of seed");
}

console.log("OK (warrant) — gymapp counterexample (adaptive-context → selective[Fe]) + A/S/Fe predicates + knip-primary A + semantic supersede + band boundaries.");
