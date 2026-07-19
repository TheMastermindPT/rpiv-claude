#!/usr/bin/env node

/**
 * warrant.mjs — deterministic Wave-2 warrant for the architectural-review steering checkpoint.
 *
 * Reads metrics.mjs (and optionally semantic.mjs) block output, applies each lens's
 * DEFECT PREDICATE — not raw row counts — and emits a per-lens live/dead vector plus a
 * three-band recommendation: skip | selective | full. This lets the checkpoint decide on
 * the FULL cross-cutting seed surface instead of only the Wave-1 structural findings, so a
 * structurally-clean-but-cross-cutting-dirty target can no longer read as "healthy".
 *
 * Calibrated against gymapp (2026-07). Two findings the raw numbers forced:
 *  - Raw block counts are dominated by UNFILTERED blocks: on gymapp/lib, `export-usage`
 *    had 60 rows but 0 with inbound=0, and `write-sites` had 31 rows but 1 with writers>=2.
 *    So the warrant reads the inner field (inbound, writers), never the row count.
 *  - A (dead code) is knip-primary: knip found 4 dead exported types in lib/db that
 *    `export-usage inbound=0` missed entirely (db/types.ts is a scan-capped `inbound=?` hub).
 *
 * Documented regression case (the counterexample the band change exists for):
 *   gymapp `lib/generation/adaptive-context` (17 files) — G=0 Lc=0 D=0 (structurally SILENT,
 *   the old gate skipped it) yet a genuine feature-envy finding exists
 *   (applied-rules-trace -> rule-events, behavioralRefs=9). Its deterministic
 *   `feature-envy-candidates` seed (ratio=0.75, own=3) fires with NO semantic pass, so the
 *   warrant returns band=selective, liveLenses=[Fe] — the Fe lens runs and catches it.
 *
 * Usage:
 *   cat metrics.txt | node warrant.mjs --files=17 --knip-dead=0
 *   cat metrics.txt | node warrant.mjs --semantic=semantic.txt --knip-dead=4 --pre10
 *
 * Flags:
 *   --files=N          file count of the target (else read from metrics `file_count:` header)
 *   --knip-dead=N      knip's dead export+type count for the target (A is knip-primary when given)
 *   --semantic=PATH    semantic.mjs output file (supersedes regex seeds for C/S/Fe where present)
 *   --owner-none=N     count of System-Model entities with `owner: NONE` (the S lens's second seed)
 *   --coverage-gaps=N  count of coverage-gap regions (T signal), optional
 *   --pre10            treat as a pre-1.0 review (forces the full band)
 *
 * Output (one JSON line): { fileCount, lenses, liveLenses, liveCount, unmeasured,
 *                           band, prompt, selectiveWave2, reason }
 */

import { readFileSync } from "node:fs";

// The ten lenses the warrant can measure from metrics + semantic + knip. M (missing
// abstraction) and L (leaky boundary) are NOT here: they have no cheap deterministic seed
// and always run whenever Wave 2 runs at all.
const CROSS_CUTTING = ["C", "A", "S", "Fe", "T", "Fp"]; // seed-driven Wave-2 lenses
const ALWAYS_ON = ["M", "L"]; // run whenever Wave 2 runs (skipped only on band=skip)

// --- flags ---------------------------------------------------------------
const flags = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const pre10 = flags.pre10 === true || flags.pre10 === "true";
const knipDead = flags["knip-dead"] != null ? Number(flags["knip-dead"]) : null;

// --- block parser --------------------------------------------------------
// metrics.mjs and semantic.mjs both emit `key: value` headers, then `---label---`
// blocks of tab-separated rows. Headers are only read before the first block of a
// source (block rows like `table:foo\twriters=1` also contain colons, so header
// detection must stop once blocks begin).
function parseInto(text, blocks, headers) {
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const b = line.match(/^---(.+)---\s*$/);
    if (b) {
      cur = b[1];
      blocks[cur] ??= [];
      continue;
    }
    if (cur === null) {
      const h = line.match(/^([\w-]+)\s*:\s*(.+?)\s*$/);
      if (h) headers[h[1]] = h[2];
      continue;
    }
    if (line.trim()) blocks[cur].push(line);
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const blocks = {};
const headers = {};
parseInto(readStdin(), blocks, headers);
if (flags.semantic) parseInto(readFileSync(flags.semantic, "utf8"), blocks, headers);

const rows = (label) => blocks[label] ?? [];
const present = (label) => label in blocks; // header seen (even if the block is empty)
const toNum = (s, def = 0) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
};
const field = (row, re) => {
  const m = row.match(re);
  return m ? m[1] : null;
};

const fileCount = flags.files != null ? Number(flags.files) : toNum(headers.file_count, 0);
// semantic.mjs always emits the four `-semantic` block headers, so their presence marks a run.
const semanticRan = present("type-fragmentation-semantic");

// --- per-lens defect predicates (calibrated) -----------------------------
function feLive() {
  if (present("feature-envy-semantic")) {
    // confirmed genuine envy: a symbol doing behavioural work on the envied module
    return rows("feature-envy-semantic").some((r) => toNum(field(r, /behavioralRefs=(\d+)/)) >= 3);
  }
  // deterministic pre-signal: leans hard on one module (ratio>=0.7) AND has real own
  // surface (own>=2) — drops constants files (own=0) and thin forwarders.
  return rows("feature-envy-candidates").some((r) => {
    return toNum(field(r, /ratio=([\d.]+)/)) >= 0.7 && toNum(field(r, /own=(\d+)/)) >= 2;
  });
}

function sLive() {
  // second seed: a System-Model entity with no owner is an ownership defect even at writers=1
  if (toNum(flags["owner-none"]) >= 1) return true;
  const src = present("write-sites-semantic") ? "write-sites-semantic" : "write-sites";
  return rows(src).some((r) => toNum(field(r, /writers=(\d+)/)) >= 2); // writers=1 is clean by design
}

function aLive() {
  if (knipDead != null) return knipDead >= 1; // knip is authoritative for A when supplied
  if (present("dead-exports-semantic")) return rows("dead-exports-semantic").length >= 1;
  return rows("export-usage").some((r) => /\binbound=0\b/.test(r)); // exclude inbound=? (capped hubs)
}

function cLive() {
  if (!semanticRan) return null; // unmeasured without the semantic pass (deterministic C pre-signal is a follow-up)
  return rows("type-fragmentation-semantic").length >= 1;
}

function dLive() {
  // literal copy-paste (via=lines/both) OR >=3 structural (Type-2) pairs — a lone
  // structural clone is too often coincidental to warrant the lens.
  const r = rows("dup-candidates");
  return r.some((x) => /via=(lines|both)/.test(x)) || r.length >= 3;
}

function tcLive() {
  // a co-change ripple group spanning >=3 files (>=2 commas in the files= list)
  return rows("co-change-groups").some((r) => (r.match(/,/g) ?? []).length >= 2);
}

function tLive() {
  return rows("test-density").length >= 1 || toNum(flags["coverage-gaps"]) >= 1;
}

function fpLive() {
  // failure propagation: >=2 files swallow failures, or one file does it habitually
  // (>=3 swallows). A lone empty catch is too often a justified best-effort
  // suppression to warrant a lens dispatch.
  const r = rows("catch-swallows");
  return r.length >= 2 || r.some((x) => toNum(field(x, /swallows=(\d+)/)) >= 3);
}

const lenses = {
  G: rows("godfile-candidates").length >= 1,
  Lc: rows("low-cohesion").length >= 1,
  D: dLive(),
  C: cLive(),
  A: aLive(),
  S: sLive(),
  Fe: feLive(),
  T: tLive(),
  Tc: tcLive(),
  Fp: fpLive(),
};

const liveLenses = Object.entries(lenses)
  .filter(([, v]) => v === true)
  .map(([k]) => k);
const unmeasured = Object.entries(lenses)
  .filter(([, v]) => v === null)
  .map(([k]) => k);
const liveCount = liveLenses.length;

// --- three-band decision -------------------------------------------------
let band;
let reason;
if (fileCount >= 100 || pre10 || liveCount >= 4) {
  band = "full";
  reason = pre10
    ? "pre-1.0 review — full sweep"
    : fileCount >= 100
      ? `${fileCount} files ≥ 100 — full sweep`
      : `${liveCount} lenses warranted (≥4) — full sweep`;
} else if (liveCount >= 1) {
  band = "selective";
  reason = `${liveLenses.join(", ")} warranted on a ${fileCount}-file target — run them, skip the rest`;
} else {
  band = "skip";
  reason = `no cross-cutting seed on a ${fileCount}-file target — 10-dim health check only`;
}

// Wave-2 lens set to actually dispatch. Wave 1 (G/Lc/D) has already run by this point.
// selective = the live cross-cutting lenses + the always-on M/L. full = all eight.
const selectiveWave2 =
  band === "skip"
    ? []
    : band === "full"
      ? ["C", "A", "T", "L", "M", "S", "Fe", "Fp"]
      : [...liveLenses.filter((l) => CROSS_CUTTING.includes(l)), ...ALWAYS_ON];

process.stdout.write(
  JSON.stringify({
    fileCount,
    lenses,
    liveLenses,
    liveCount,
    unmeasured,
    band,
    prompt: band === "full", // auto-run skip/selective; ask only before the expensive full sweep
    selectiveWave2,
    reason,
  }) + "\n",
);
