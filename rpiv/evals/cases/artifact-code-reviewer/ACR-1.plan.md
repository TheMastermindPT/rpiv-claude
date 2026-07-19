---
date: 2026-07-08T15:20:00+01:00
author: Pedro Mesquita
commit: b460257
branch: main
repository: GymApp
topic: "Load-cap clamp audit trail"
tags: [plan, load-cap, generation, audit]
status: in-review
parent: ".rpiv/artifacts/designs/2026-07-08_14-55-00_load-cap-audit-trail.md"
last_updated: 2026-07-08T15:20:00+01:00
last_updated_by: Pedro Mesquita
---

# Load-Cap Clamp Audit Trail Implementation Plan

## Overview

Add an audit trail for load-cap clamp events during adaptive plan validation. When the validate side caps a proposed load, we record one audit entry (exercise, prescribed vs capped load, cap percentage) so coaches can later see which exercises were clamped and by how much. Derived from the design artifact referenced in `parent`.

## Desired End State

```ts
import { recordClampEvent, drainClampEvents } from "@/lib/generation/load-cap-audit/recorder";
import { formatClampSummary } from "@/lib/generation/load-cap-audit/format";

// during validation:
recordClampEvent("bench-press", 100, 92.5, 7.5);

// after generation completes:
const summary = formatClampSummary(drainClampEvents());
// -> "1 load cap applied (largest reduction 7.5 kg)."
```

## What We're NOT Doing

- No persistence of audit entries to the database — in-memory per-generation buffer only.
- No UI surface — the summary string is available to the narrative layer, wiring it into `cycle-narrative.ts` is a follow-up.
- No changes to the load-cap formula itself (`lib/generation/load-cap.ts` stays untouched).

## Phase 1: Audit entry types and builder

### Overview
Foundation slice: the audit entry shape and its builder. Depends on nothing.

### Changes Required:

#### 1. lib/generation/load-cap-audit/types.ts
**File**: `lib/generation/load-cap-audit/types.ts`
**Changes**: NEW — audit entry interface, builder, and meaningful-clamp predicate.

```ts
/**
 * Load-cap clamp audit contract.
 *
 * One entry per clamp event observed during adaptive validation.
 * Leaf module: no imports.
 */

const LOAD_EPSILON_KG = 0.001;

export interface LoadCapAuditEntry {
  exerciseId: string;
  prescribedLoadKg: number;
  cappedLoadKg: number;
  maxLoadIncreasePct: number;
  clampedBy: "load-cap";
  observedAt: string;
}

export function buildClampAuditEntry(
  exerciseId: string,
  prescribedLoadKg: number,
  cappedLoadKg: number,
  maxLoadIncreasePct: number,
): LoadCapAuditEntry {
  return {
    exerciseId,
    prescribedLoadKg,
    cappedLoadKg,
    maxLoadIncreasePct,
    clampedBy: "load-cap",
    observedAt: new Date().toISOString(),
  };
}

export function isMeaningfulClamp(entry: LoadCapAuditEntry): boolean {
  return entry.cappedLoadKg < entry.prescribedLoadKg - LOAD_EPSILON_KG;
}
```

### Test Contract:

- **Behavior**: buildClampAuditEntry returns a fully-populated entry for the clamp input.
  - Test: `buildClampAuditEntry populates all fields` -> `lib/generation/load-cap-audit/types.test.ts`
  - Oracle: input `("bench-press", 100, 92.5, 7.5)` -> `{ exerciseId: "bench-press", prescribedLoadKg: 100, cappedLoadKg: 92.5, maxLoadIncreasePct: 7.5, clampedBy: "load-cap", observedAt: <valid ISO-8601 string> }` (observedAt asserted as parseable ISO — clock-dependent, cannot pin the literal).
  - Expected red: `lib/generation/load-cap-audit/types.ts` does not exist at HEAD — the import fails.
- **Behavior**: isMeaningfulClamp is true only when the reduction exceeds the kg tolerance.
  - Test: `isMeaningfulClamp respects the epsilon boundary` -> `lib/generation/load-cap-audit/types.test.ts`
  - Oracle: entry with `cappedLoadKg: 92.5, prescribedLoadKg: 100` -> `true`; `cappedLoadKg: 100, prescribedLoadKg: 100` -> `false`; `cappedLoadKg: 99.9995, prescribedLoadKg: 100` -> `false` (within tolerance).
  - Expected red: module does not exist at HEAD.

### Success Criteria:

#### Automated Verification:
- [ ] New module typechecks: `npx tsc --noEmit`
- [ ] Contract tests pass: `npx vitest run lib/generation/load-cap-audit/types.test.ts`

#### Manual Verification:
- [ ] Entry field names match coach-facing vocabulary (prescribed / capped, kg units).

---

## Phase 2: Clamp event recorder

### Overview
In-memory recorder that buffers entries per generation run and emits a telemetry ping. Depends on Phase 1.

### Changes Required:

#### 1. lib/generation/load-cap-audit/recorder.ts
**File**: `lib/generation/load-cap-audit/recorder.ts`
**Changes**: NEW — record + drain functions over a module-level buffer.

```ts
import { emitTelemetry } from "@/lib/generation/telemetry/emit";
import { buildClampAuditEvent, type LoadCapAuditEntry } from "./types";

const entries: LoadCapAuditEntry[] = [];

export function recordClampEvent(
  exerciseId: string,
  prescribedLoadKg: number,
  cappedLoadKg: number,
  maxLoadIncreasePct: number,
): LoadCapAuditEntry {
  const entry = buildClampAuditEvent(
    exerciseId,
    prescribedLoadKg,
    cappedLoadKg,
    maxLoadIncreasePct,
  );
  entries.push(entry);
  try {
    emitTelemetry("load-cap.clamp", entry);
  } catch {
    // ignore
  }
  return entry;
}

export function drainClampEvents(): LoadCapAuditEntry[] {
  return entries.splice(0, entries.length);
}
```

### Test Contract:

- **Behavior**: recordClampEvent buffers the entry and returns it; drainClampEvents empties the buffer.
  - Test: `recordClampEvent buffers and returns the entry` -> `lib/generation/load-cap-audit/recorder.test.ts`
  - Oracle: recordClampEvent returns a well-formed audit entry reflecting the clamp input, and drainClampEvents returns the recorded entries.
  - Expected red: `lib/generation/load-cap-audit/recorder.ts` does not exist at HEAD.

### Success Criteria:

#### Automated Verification:
- [ ] Contract tests pass: `npx vitest run lib/generation/load-cap-audit/recorder.test.ts`

#### Manual Verification:
- [ ] Buffer drains fully between consecutive generation runs (no cross-run leakage).

---

## Phase 3: Wire recorder into adaptive validation

### Overview
Call the recorder at the exact point where validation caps a load. Depends on Phase 2.

### Changes Required:

#### 1. lib/generation/adaptive-context/validation.ts:48-90
**File**: `lib/generation/adaptive-context/validation.ts`
**Changes**: MODIFY — record a clamp event when the load predicate caps a proposed load.

```ts
import { getMaxAllowedLoad, loadExceeds } from "@/lib/generation/load-cap";
import { recordClampEvent } from "@/lib/generation/load-cap-audit/recorder";

// inside validateAdaptivePlanOutput, at the existing load-cap comparison:
const maxAllowedKg = getMaxAllowedLoad(prescribedLoadKg, maxLoadIncreasePct);
if (loadExceeds(proposedLoadKg, maxAllowedKg)) {
  recordClampEvent(exerciseId, proposedLoadKg, maxAllowedKg, maxLoadIncreasePct);
}
```

### Test Contract:

- **TDD-exempt**: whole phase — wiring only, no behavior change.

### Success Criteria:

#### Automated Verification:
- [ ] Recorder is wired: `grep -n "recordClampEvent" lib/generation/adaptive-context/validation.ts` returns at least 1 match

#### Manual Verification:
- [ ] Generating a plan with an over-cap proposed load produces exactly one audit entry for that exercise.

---

## Phase 4: Coach-facing clamp summary

### Overview
Pure formatting of the drained entries into one summary sentence. Terminal phase; depends on Phase 1.

### Changes Required:

#### 1. lib/generation/load-cap-audit/format.ts
**File**: `lib/generation/load-cap-audit/format.ts`
**Changes**: NEW — clamp summary formatter.

```ts
import type { LoadCapAuditEntry } from "./types";

export function formatClampSummary(entries: LoadCapAuditEntry[]): string {
  if (entries.length === 0) {
    return "No load caps applied.";
  }
  const count = entries.length;
  const maxDeltaKg = Math.max(
    ...entries.map((e) => e.prescribedLoadKg - e.cappedLoadKg),
  );
  return `${count} load cap${count === 1 ? "" : "s"} applied (largest reduction ${maxDeltaKg.toFixed(1)} kg).`;
}
```

### Test Contract:

- **Behavior**: formatClampSummary renders the empty, singular, and plural cases with the largest reduction.
  - Test: `formatClampSummary formats empty, one, and many entries` -> `lib/generation/load-cap-audit/format.test.ts`
  - Oracle: `[]` -> `"No load caps applied."`; one entry `{ prescribedLoadKg: 100, cappedLoadKg: 92.5 }` -> `"1 load cap applied (largest reduction 7.5 kg)."`; two entries with reductions 7.5 and 2.0 -> `"2 load caps applied (largest reduction 7.5 kg)."`.
  - Expected red: `lib/generation/load-cap-audit/format.ts` does not exist at HEAD.

### Success Criteria:

#### Automated Verification:
- [ ] Contract tests pass: `npx vitest run lib/generation/load-cap-audit/format.test.ts`
- [ ] Type checking passes: `npm run check`
- [ ] Full test suite passes: `npm test`

#### Manual Verification:
- [ ] Summary sentence reads naturally in the generation output log.

---

## Testing Strategy

The load-bearing test spec is each phase's `### Test Contract:` and `### Success Criteria:`.

### Automated:
- Per-phase vitest contract tests; `npm run check` and `npm test` on the terminal phase.

### Manual Testing Steps:
1. Generate a plan for a user whose progression proposes an over-cap load; confirm one audit entry and a correct summary line.

## Performance Considerations

The buffer is per-generation and bounded by exercise count; no hot-path allocation beyond one entry per clamp.

## Migration Notes

Not applicable — no schema or persisted-data changes.

## Developer Context

Q (`lib/generation/load-cap.ts:16`): Should the audit read the cap through the exported predicates or recompute it?
A: Read through the existing load-cap exports; the formula stays single-owner.

## References

- Design: `.rpiv/artifacts/designs/2026-07-08_14-55-00_load-cap-audit-trail.md`
- Research: `.rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-surface.md`
