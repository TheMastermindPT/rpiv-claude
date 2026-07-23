// fingerprint.gymapp.test.mjs — golden test against REAL gymapp domain-type lines.
//
// Fixtures are verbatim lines lifted from the gymapp repo (source cited per row).
// They are inlined (not read from disk) so the test is self-contained and portable —
// it proves the same property the commit claims: a real type-definition line keeps its
// fingerprint when the file is renamed / lines drift / a formatter reflows it, but the
// fingerprint changes the moment the code genuinely changes.
//
//   baseline → verbatim line as it exists in gymapp today
//   moved    → same code after a file move + reindent + trailing comment + reflow
//              (only whitespace/comment changes that normalise() is meant to absorb)
//   changed  → a genuine semantic edit (renamed type, changed member type, extra case)
//
// No dependencies; prints "OK" on success.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FP = join(dirname(fileURLToPath(import.meta.url)), "fingerprint.mjs");

function fp1(entry) {
  const out = execFileSync("node", [FP], { input: JSON.stringify(entry), encoding: "utf-8" });
  const [row] = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(row.fp, `expected a fingerprint for ${entry.symbol}, got ${JSON.stringify(row)}`);
  return row.fp;
}

// Each fixture: a real gymapp line, a reformatted "moved" twin (must match), and a
// genuinely "changed" twin (must diverge).
const fixtures = [
  {
    source: "lib/domain/athlete-profile.ts:15",
    lens: "C",
    symbol: "AthleteProfile",
    baseline: "export interface AthleteProfile {",
    moved: "    export  interface  AthleteProfile  {   // moved to lib/domain/types/",
    changed: "export interface AthleteProfileDraft {",
  },
  {
    source: "lib/domain/athlete-profile.ts:18",
    lens: "C",
    symbol: "unit_system",
    baseline: '  unit_system: "metric" | "imperial";',
    moved: '        unit_system:  "metric" | "imperial" ;   // reindented',
    changed: '  unit_system: "metric" | "imperial" | "si";',
  },
  {
    source: "lib/domain/athlete-profile.ts:25",
    lens: "S",
    symbol: "equipment",
    baseline: "  equipment: string[];",
    moved: "          equipment : string [] ;   // drifted 40 lines down",
    changed: "  equipment: number[];",
  },
  {
    source: "lib/domain/plan-draft.ts:32",
    lens: "C",
    symbol: "PlannedSet",
    baseline: "export type PlannedSet = {",
    moved: "  export type PlannedSet={   // collapsed by formatter",
    changed: "export type PlannedRep = {",
  },
  {
    source: "lib/domain/weekly-check-in-contracts.ts:17",
    lens: "G",
    symbol: "FATIGUE_LEVELS",
    baseline: 'const FATIGUE_LEVELS = ["Low", "Moderate", "High"] as const;',
    moved: '   const FATIGUE_LEVELS=[ "Low","Moderate" , "High" ] as const;   // reflowed',
    changed: 'const FATIGUE_LEVELS = ["Low", "Moderate", "High", "Extreme"] as const;',
  },
];

let survived = 0;
for (const f of fixtures) {
  const base = fp1({ lens: f.lens, quotedLines: [f.baseline], symbol: f.symbol });
  const moved = fp1({ lens: f.lens, quotedLines: [f.moved], symbol: f.symbol });
  const changed = fp1({ lens: f.lens, quotedLines: [f.changed], symbol: f.symbol });

  assert.equal(moved, base, `${f.source} (${f.symbol}): rename+reindent+reflow must NOT change the fingerprint`);
  assert.notEqual(changed, base, `${f.source} (${f.symbol}): a genuine code change MUST change the fingerprint`);
  survived++;
}
assert.equal(survived, fixtures.length, "all gymapp fixtures survived rename and detected genuine change");

// Symbol-move realism: the SAME line attributed to a renamed symbol is a different finding.
const asProfile = fp1({ lens: "C", quotedLines: ["export interface AthleteProfile {"], symbol: "AthleteProfile" });
const asDraft = fp1({ lens: "C", quotedLines: ["export interface AthleteProfile {"], symbol: "AthleteProfileDraft" });
assert.notEqual(asProfile, asDraft, "same line under a different symbol → different fingerprint");

// Documented limitation (encoded so callers know the boundary): normalise() trims
// whitespace only around structural tokens ( ) [ ] { } ; , : = — NOT around operators
// like the union `|`. So changing union spacing DOES change the fingerprint.
const spacedUnion = fp1({ lens: "C", quotedLines: ['type U = "a" | "b";'], symbol: "U" });
const tightUnion = fp1({ lens: "C", quotedLines: ['type U = "a"|"b";'], symbol: "U" });
assert.notEqual(spacedUnion, tightUnion, "KNOWN LIMITATION: operator (|) spacing is not normalised");

console.log(`OK (fingerprint gymapp) — ${survived}/${fixtures.length} real domain-type lines survive rename/reindent/reflow and detect genuine change; symbol-move and operator-spacing boundaries pinned.`);
