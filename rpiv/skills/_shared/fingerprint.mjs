#!/usr/bin/env node

/**
 * fingerprint.mjs — stable content-hash fingerprint for drift-delta matching.
 *
 * Produces a deterministic, path-independent, line-number-independent
 * fingerprint from (lens, quoted evidence, symbol name).  Same code at a
 * different file or line → same fingerprint.  Different code → different
 * fingerprint.
 *
 * Usage (one-off):
 *   echo '{"lens":"D","quoted":"const x = 1","symbol":"validate"}' \
 *     | node fingerprint.mjs
 *
 * Usage (batch — one JSON object per line):
 *   node fingerprint.mjs < findings.ndjson > fingerprints.ndjson
 *
 * Output contract — EXACTLY ONE stdout line per non-blank input line:
 *   success → { "id": "<input id>", "fp": "<hex>", "lens": "D", "symbol": "validate" }
 *   failure → { "id": "<input id or null>", "fp": null, "error": "<why>" }
 * A malformed input is never silently dropped: it emits a fp:null line so the
 * caller's "one output line per input line" reconciliation stays exact, and the
 * bad finding is visible (filter on `fp === null` before matching). All human
 * diagnostics and the run summary go to stderr — stdout carries data only.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Normalisation — strip whitespace / formatting that does not change meaning
// ---------------------------------------------------------------------------

/**
 * Collapse a quoted code line into its "structural skeleton":
 *  - trim leading/trailing whitespace
 *  - collapse runs of whitespace to a single space
 *  - remove JS/TS line comments (// …) — they are noise that varies by file
 *
 * This is LOSSY enough to survive comment changes and re-indentation, but
 * PRESERVES identifier / operator / literal structure so a genuinely changed
 * line produces a different hash.
 */
function normalise(line) {
  let s = line.trim();
  // strip // line comments (but not URLs)
  s = s.replace(/(?<!:)\/\/.*$/, "");
  // collapse whitespace
  s = s.replace(/\s+/g, " ");
  // trim whitespace around structural tokens where it never changes meaning
  // ( ) [ ] { } , ; : = before/after — but NOT after . (member access)
  s = s.replace(/\s*([()[\]{};,:=])\s*/g, "$1");
  // restore space after , and ; and : for readability (doesn't affect hash)
  s = s.replace(/([,;:])/g, "$1 ");
  // collapse again after token trimming
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

/**
 * Build the raw pre-image that goes into the hash.
 * Order: lens_class, normalised quoted evidence, canonical symbol name.
 */
function preImage(lens, quotedLines, symbol) {
  // quotedLines may be a single string or an array (multi-line evidence)
  const lines = Array.isArray(quotedLines) ? quotedLines : [quotedLines];
  const normLines = lines.map(normalise).filter(Boolean);
  // Use a sentinel for nil symbols so two symbol-less findings don't collide
  const sym = symbol == null ? "<no-symbol>" : symbol;
  return [lens, ...normLines, sym].join("\x00");
}

/**
 * Validate a decoded finding object BEFORE hashing so bad input is reported
 * explicitly rather than crashing inside normalise(). Returns an error string,
 * or null when the finding is well-formed. `symbol` is intentionally optional
 * (co-change pairs and other symbol-less findings use the nil sentinel).
 */
function validate(lens, quoted) {
  if (typeof lens !== "string" || !lens.trim()) return "missing or empty 'lens'";
  if (quoted == null) return "missing 'quoted'/'quotedLines'";
  const lines = Array.isArray(quoted) ? quoted : [quoted];
  if (lines.length === 0) return "empty 'quoted' array";
  if (lines.some((l) => typeof l !== "string")) {
    return "'quoted' must be a string or an array of strings";
  }
  const hasEvidence = lines.map(normalise).some(Boolean);
  return hasEvidence ? null : "'quoted' evidence is empty after normalisation";
}

function fingerprint(lens, quotedLines, symbol) {
  const raw = preImage(lens, quotedLines, symbol);
  // 16 hex chars (64 bits) — collision risk is negligible for the expected
  // scale of per-project review history (~10³–10⁴ fingerprints).
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// CLI — accepts ndjson on stdin, emits ndjson on stdout
// ---------------------------------------------------------------------------

async function main() {
  const rl = createInterface({ input: process.stdin });
  let ok = 0;
  let bad = 0;

  // Invariant: exactly one stdout line per NON-BLANK input line. A failed line
  // still emits { fp: null, error } so a caller can reconcile output-count
  // against input-count exactly — a dropped finding can never hide in the count.
  for await (const line of rl) {
    if (!line.trim()) continue; // blank separators are not inputs

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      bad++;
      process.stderr.write(`fingerprint: bad JSON: ${e.message}\n`);
      process.stdout.write(
        JSON.stringify({ id: null, fp: null, error: `bad JSON: ${e.message}` }) + "\n"
      );
      continue;
    }

    const quoted = obj.quoted ?? obj.quotedLines;
    const err = validate(obj.lens, quoted);
    if (err) {
      bad++;
      process.stderr.write(`fingerprint: invalid finding ${obj.id ?? "<no-id>"}: ${err}\n`);
      process.stdout.write(
        JSON.stringify({ id: obj.id ?? null, fp: null, error: err }) + "\n"
      );
      continue;
    }

    ok++;
    process.stdout.write(
      JSON.stringify({
        id: obj.id ?? null,
        fp: fingerprint(obj.lens, quoted, obj.symbol),
        lens: obj.lens,
        symbol: obj.symbol ?? null,
      }) + "\n"
    );
  }

  // Run summary — stderr ONLY. stdout must stay 1 data line per input line.
  process.stderr.write(`fingerprint: ${ok} ok, ${bad} invalid\n`);
}

await main();
