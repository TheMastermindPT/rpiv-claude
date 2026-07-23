// fingerprint.test.mjs — unit test for fingerprint.mjs (content-hash drift-delta matching).
// Feeds known ndjson lines and asserts fingerprints are stable across cosmetic changes but
// diverge on genuine ones, and that the output contract (one line per input, malformed
// surfaced not dropped) holds. No dependencies; prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FP = join(dirname(fileURLToPath(import.meta.url)), "fingerprint.mjs");

// Feed raw ndjson lines (caller controls exact bytes — used for bad-JSON cases).
function fingerprintRaw(lines) {
  const out = execFileSync("node", [FP], { input: lines.join("\n"), encoding: "utf-8" });
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Feed structured entries (each JSON.stringify'd).
function fingerprint(entries) {
  return fingerprintRaw(entries.map((e) => JSON.stringify(e)));
}

// 1. Same code → same fingerprint
const [a1] = fingerprint([{ id: "1", lens: "G", quotedLines: ["const x = 1;"], symbol: "GodFile" }]);
const [a2] = fingerprint([{ id: "2", lens: "G", quotedLines: ["const x = 1;"], symbol: "GodFile" }]);
assert.equal(a1.fp, a2.fp, "same code → same fingerprint");

// 2. Comment-only change → same fingerprint (comment line stripped, same code remains)
const [b1] = fingerprint([{ id: "3", lens: "G", quotedLines: ["// todo: fix this", "const x = 1;"], symbol: "GodFile" }]);
assert.equal(a1.fp, b1.fp, "comment-only change → same fingerprint");

// 3. Whitespace/indentation change → same fingerprint (normalise collapses whitespace)
const [c1] = fingerprint([{ id: "4", lens: "G", quotedLines: ["  const   x =  1;  "], symbol: "GodFile" }]);
assert.equal(a1.fp, c1.fp, "whitespace change → same fingerprint");

// 4. Genuinely different code → different fingerprint
const [d1] = fingerprint([{ id: "5", lens: "G", quotedLines: ["const y = 2;"], symbol: "GodFile" }]);
assert.notEqual(a1.fp, d1.fp, "different code → different fingerprint");

// 5. Different lens → different fingerprint
const [e1] = fingerprint([{ id: "6", lens: "Lc", quotedLines: ["const x = 1;"], symbol: "GodFile" }]);
assert.notEqual(a1.fp, e1.fp, "different lens → different fingerprint");

// 6. Different symbol → different fingerprint
const [f1] = fingerprint([{ id: "7", lens: "G", quotedLines: ["const x = 1;"], symbol: "OtherFile" }]);
assert.notEqual(a1.fp, f1.fp, "different symbol → different fingerprint");

// 7. Nil symbol uses sentinel (does not crash, does not collide with empty-string symbol)
const [g1] = fingerprint([{ id: "8", lens: "G", quotedLines: ["const x = 1;"] }]);
const [g2] = fingerprint([{ id: "9", lens: "G", quotedLines: ["const x = 1;"] }]);
assert.equal(g1.fp, g2.fp, "two nil-symbol findings → same fingerprint (both sentinel)");
// Nil symbol should NOT collide with an intentional empty-string symbol
const [g3] = fingerprint([{ id: "10", lens: "G", quotedLines: ["const x = 1;"], symbol: "" }]);
assert.notEqual(g1.fp, g3.fp, "nil-symbol sentinel ≠ empty-string symbol");

// 8. Multi-line evidence works and is order-sensitive
const [h1] = fingerprint([{ id: "11", lens: "G", quotedLines: ["const x = 1;", "const y = 2;"], symbol: "GodFile" }]);
const [h2] = fingerprint([{ id: "12", lens: "G", quotedLines: ["const y = 2;", "const x = 1;"], symbol: "GodFile" }]);
assert.notEqual(h1.fp, h2.fp, "different line order → different fingerprint");

// 9. Output contract: EXACTLY one line per input; malformed is surfaced (fp:null + error),
//    never silently dropped — so a caller can reconcile output-count against input-count.
const contract = fingerprint([
  { id: "13", lens: "G", quotedLines: ["const x = 1;"], symbol: "Good" },
  { id: "14", lens: "G", symbol: "MissingQuoted" },            // no quoted/quotedLines
  { id: "15", lens: "G", quotedLines: [""], symbol: "Empty" }, // empty after normalise
  { id: "16", lens: "", quotedLines: ["const x = 1;"] },       // empty lens
]);
assert.equal(contract.length, 4, "one output line per input line (incl. malformed)");
assert.ok(contract.find((r) => r.id === "13").fp, "well-formed finding has a fingerprint");
for (const id of ["14", "15", "16"]) {
  const r = contract.find((x) => x.id === id);
  assert.equal(r.fp, null, `malformed finding ${id} → fp null`);
  assert.ok(r.error, `malformed finding ${id} carries an error string`);
}

// 10. Bad JSON is surfaced, not dropped: one fp:null line, count preserved.
const rawResults = fingerprintRaw([
  '{"id":"17","lens":"G","quotedLines":["const x = 1;"],"symbol":"Good"}',
  "this is not json",
]);
assert.equal(rawResults.length, 2, "bad-JSON line still emits one output line");
assert.equal(rawResults[1].fp, null, "bad-JSON line → fp null");
assert.match(rawResults[1].error, /bad JSON/, "bad-JSON line carries a JSON error");

// 11. Batch invariant: N well-formed inputs → N fingerprint lines (no summary line pollution).
const batch = fingerprint(
  Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, lens: "G", quotedLines: [`const v${i} = ${i};`], symbol: `S${i}` }))
);
assert.equal(batch.length, 10, "N inputs → N output lines");
assert.ok(batch.every((r) => r.fp && !("error" in r)), "all batch lines carry a fingerprint, none carry error");

console.log("OK (fingerprint) — content stable across comments/whitespace; diverges on code/lens/symbol; nil sentinel; 1-line-per-input contract; malformed & bad-JSON surfaced not dropped.");
