---
date: 2026-07-08T16:05:00+01:00
author: Pedro Mesquita
commit: b460257
branch: main
repository: GymApp
topic: "Clamp summary formatting for the narrative layer"
tags: [plan, generation, narrative]
status: in-review
parent: ".rpiv/artifacts/designs/2026-07-08_15-40-00_clamp-summary-formatting.md"
last_updated: 2026-07-08T16:05:00+01:00
last_updated_by: Pedro Mesquita
---

# Clamp Summary Formatting Implementation Plan

## Overview

Add a small, pure formatting layer that turns clamp statistics (count and largest reduction) into one coach-facing summary sentence, plus an adapter that computes those statistics from raw prescribed/capped load pairs. Self-contained: two new leaf modules under `lib/generation/`.

## Desired End State

```ts
import { summarizeClampsForNarrative } from "@/lib/generation/clamp-summary-narrative";

const line = summarizeClampsForNarrative([
  { prescribedKg: 100, cappedKg: 92.5 },
  { prescribedKg: 60, cappedKg: 58 },
]);
// -> "2 load caps applied (largest reduction 7.5 kg)."
```

## What We're NOT Doing

- No wiring into `cycle-narrative.ts` — consuming the summary line from the narrative composer is an explicitly deferred follow-up.
- No changes to the load-cap formula or validation path (`lib/generation/load-cap.ts`, `lib/generation/adaptive-context/validation.ts` stay untouched).
- No persistence and no UI surface.

## Phase 1: Clamp summary formatter

### Overview
Foundation slice: the input shape and the pure formatter. Depends on nothing.

### Changes Required:

#### 1. lib/generation/clamp-summary.ts
**File**: `lib/generation/clamp-summary.ts`
**Changes**: NEW — summary input type and formatter.

```ts
/**
 * Clamp summary formatting.
 *
 * Pure presentation of clamp statistics for the narrative layer.
 * Leaf module: no imports.
 */

export interface ClampSummaryInput {
  count: number;
  largestReductionKg: number;
}

export function formatClampSummary(input: ClampSummaryInput): string {
  if (input.count === 0) {
    return "No load caps applied.";
  }
  const plural = input.count === 1 ? "" : "s";
  const reduction = Number.isInteger(input.largestReductionKg)
    ? String(input.largestReductionKg)
    : input.largestReductionKg.toFixed(1);
  return `${input.count} load cap${plural} applied (largest reduction ${reduction} kg).`;
}
```

### Test Contract:

- **Behavior**: formatClampSummary renders the empty, singular, plural, and integer-reduction cases.
  - Test: `formatClampSummary formats zero, one, and many caps` -> `tests/unit/generation/clamp-summary.test.ts`
  - Oracle: `{ count: 0, largestReductionKg: 0 }` -> `"No load caps applied."`; `{ count: 1, largestReductionKg: 7.5 }` -> `"1 load cap applied (largest reduction 7.5 kg)."`; `{ count: 2, largestReductionKg: 7.5 }` -> `"2 load caps applied (largest reduction 7.5 kg)."`; `{ count: 1, largestReductionKg: 2 }` -> `"1 load cap applied (largest reduction 2 kg)."` (integer-aware formatting, matching the existing coach-facing `formatNumber` convention).
  - Expected red: `lib/generation/clamp-summary.ts` does not exist at HEAD — the import fails.

### Success Criteria:

#### Automated Verification:
- [ ] Contract tests pass: `npx vitest run tests/unit/generation/clamp-summary.test.ts`

#### Manual Verification:
- [ ] Sentence casing and kg formatting match existing coach-facing copy.

---

## Phase 2: Narrative adapter

### Overview
Compute clamp statistics from raw prescribed/capped pairs and delegate to the Phase 1 formatter. Terminal phase; depends on Phase 1.

### Changes Required:

#### 1. lib/generation/clamp-summary-narrative.ts
**File**: `lib/generation/clamp-summary-narrative.ts`
**Changes**: NEW — statistics adapter over the formatter.

```ts
import {
  formatClampSummary,
  type ClampSummaryInput,
} from "@/lib/generation/clamp-summary";

export interface ClampObservation {
  prescribedKg: number;
  cappedKg: number;
}

export function summarizeClampsForNarrative(
  observations: ClampObservation[],
): string {
  const clamped = observations.filter((o) => o.cappedKg < o.prescribedKg);
  if (clamped.length === 0) {
    return formatClampSummary({ count: 0, largestReductionKg: 0 });
  }
  const input: ClampSummaryInput = {
    count: clamped.length,
    largestReductionKg: clamped.reduce(
      (max, o) => Math.max(max, o.prescribedKg - o.cappedKg),
      0,
    ),
  };
  return formatClampSummary(input);
}
```

### Test Contract:

- **Behavior**: summarizeClampsForNarrative counts only genuinely clamped pairs and reports the largest reduction.
  - Test: `summarizeClampsForNarrative aggregates observations` -> `tests/unit/generation/clamp-summary-narrative.test.ts`
  - Oracle: `[]` -> `"No load caps applied."`; `[{ prescribedKg: 100, cappedKg: 100 }]` -> `"No load caps applied."` (unclamped pair excluded); `[{ prescribedKg: 100, cappedKg: 92.5 }, { prescribedKg: 60, cappedKg: 58 }]` -> `"2 load caps applied (largest reduction 7.5 kg)."`.
  - Expected red: `lib/generation/clamp-summary-narrative.ts` does not exist at HEAD.

### Success Criteria:

#### Automated Verification:
- [ ] Contract tests pass: `npx vitest run tests/unit/generation/clamp-summary-narrative.test.ts`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Full test suite passes: `npm test`

#### Manual Verification:
- [ ] Summary line reads naturally when printed after a generation run.

---

## Testing Strategy

The load-bearing test spec is each phase's `### Test Contract:` and `### Success Criteria:`.

### Automated:
- Per-phase vitest contract tests; `npm run check` and `npm test` on the terminal phase.

### Manual Testing Steps:
1. Call `summarizeClampsForNarrative` with a two-observation fixture and read the line aloud.

## Performance Considerations

Pure functions over small arrays; no hot-path implications.

## Migration Notes

Not applicable — no schema or persisted-data changes.

## Developer Context

Q (`lib/generation/cycle-narrative.ts:1`): Wire the summary into the narrative composer now or later?
A: Later — keep this plan to the pure formatting layer; wiring is a follow-up.

## References

- Design: `.rpiv/artifacts/designs/2026-07-08_15-40-00_clamp-summary-formatting.md`
- Research: `.rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-surface.md`
