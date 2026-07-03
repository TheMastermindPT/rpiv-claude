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
 * Output (one JSON line per input):
 *   { "id": "<input id>", "fp": "<hex>", "lens": "D", "symbol": "validate" }
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
 *  - lowercase (lens + symbol are already canonical)
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
  s = s.replace(/\s*([()\[\]{};,:=])\s*/g, "$1");
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
  return [lens, ...normLines, symbol].join("\x00");
}

function fingerprint(lens, quotedLines, symbol) {
  const raw = preImage(lens, quotedLines, symbol);
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// CLI — accepts ndjson on stdin, emits ndjson on stdout
// ---------------------------------------------------------------------------

async function main() {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const fp = fingerprint(
        obj.lens,
        obj.quoted ?? obj.quotedLines,
        obj.symbol
      );
      process.stdout.write(
        JSON.stringify({
          id: obj.id ?? null,
          fp,
          lens: obj.lens,
          symbol: obj.symbol,
        }) + "\n"
      );
    } catch (e) {
      process.stderr.write(`fingerprint: skip malformed line: ${e.message}\n`);
    }
  }
}

main();
