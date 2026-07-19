---
date: 2026-07-08T16:05:00+01:00
author: Pedro Mesquita
commit: b460257
branch: main
repository: GymApp
topic: "Load-cap clamp audit trail"
tags: [design, load-cap, generation, audit]
status: in-progress
parent: ".rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-surface.md"
last_updated: 2026-07-08T16:05:00+01:00
last_updated_by: Pedro Mesquita
---

# Design: Load-Cap Clamp Audit Trail

## Summary

Record an audit entry each time adaptive validation caps an **increase-load** recommendation, so a coach can later see which exercises were clamped on that path and by how much. This first cut audits the increase-load validator only; the other cap sites are explicitly out of scope. The audit lives in a small leaf module under `lib/generation/load-cap-audit/`; the validation layer records into it, and a pure formatter turns the buffer into one coach-facing summary sentence. No change to the load-cap formula itself.

## Requirements

- One audit entry per increase-load clamp observed in `getIncreaseLoadValidationError` (exercise, proposed vs capped load, cap percentage). The other recommendation validators are out of scope for this feature.
- A coach-facing summary string derived from the per-generation buffer.
- The audit must not alter validation's existing accept/reject behavior.

## Current State Analysis

### Key Discoveries

- `lib/generation/load-cap.ts` is the single owner of the cap arithmetic and the kg tolerance: it exposes a max-allowed-load helper plus a set of kg comparison predicates, and keeps the tolerance constant unexported (`lib/generation/load-cap.ts:11-13`) so it cannot be re-derived at call sites. Read the file for the exact exported names and their parameter order before wiring against it.
- `lib/generation/adaptive-context/validation.ts` is where recommended loads are compared against the cap (e.g. the increase-load validator around `lib/generation/adaptive-context/validation.ts:305-318`). This is the point where a clamp is observed.
- The generation run is orchestrated outside this module; per-run lifecycle (setup/teardown of transient buffers) is owned by the plan-generation caller, not by the leaf modules.

## Scope

### Building
- A leaf audit module (`load-cap-audit/`) with an entry type, a builder, and an in-memory recorder.
- Wiring at the increase-load validator's clamp site (`getIncreaseLoadValidationError`).
- A pure coach-facing summary formatter.

### Not Building
- No database or persisted storage of audit entries — see the No Persistence decision.
- No UI in this design; the coach dashboard surface is a later slice.
- No change to the load-cap formula or the epsilon tolerance.
- No auditing of the other cap sites (trial-load and the remaining recommendation validators) — this feature covers the increase-load path only; extending it is a follow-up.

## Decisions

### TDD Standard (standing)
Every behavior-changing slice MUST carry a `#### Test Contract:` with at least one **Behavior** whose **Oracle** pins exact input -> expected-output values (the strongest checkable oracle; any weakening justified inline) and an **Expected red** reason. Non-behavioral slices/items carry explicit `TDD-exempt` markers with reasons. Recorded as a commitment so slice-verifier's commitments audit flags violations per slice.

### No Persistence (in-memory only)
Audit entries live only in an in-memory, per-generation buffer. Nothing is written to the database — there is no `load_cap_audit` table and no insert. The buffer exists for the duration of one generation run and the coach summary is produced from it in-process. Persisting the audit trail is explicitly out of scope; a coach who wants history re-runs the report.

### Cap stays single-owner
The audit reads the cap through the exported `load-cap` helpers; it never re-derives the `prescribed * (1 + pct/100)` arithmetic or the tolerance at the call site. This preserves the single-owner invariant that keeps the apply and validate sides from diverging.

## Architecture

### lib/generation/load-cap-audit/types.ts — NEW
Audit entry shape and its builder. Leaf: no imports.

### lib/generation/load-cap-audit/recorder.ts — NEW
In-memory recorder over a per-generation module buffer; record + drain.

### lib/generation/adaptive-context/validation.ts — MODIFY
Record a clamp event at the existing over-cap comparison, without changing the accept/reject result.

### lib/generation/load-cap-audit/format.ts — NEW
Pure formatter: drained entries -> one coach-facing summary sentence.

## Slices

### Slice 1: Audit entry types and in-memory recorder — LOCKED

**Files**: `lib/generation/load-cap-audit/types.ts`, `lib/generation/load-cap-audit/recorder.ts`

#### 1. lib/generation/load-cap-audit/types.ts

```ts
/**
 * Load-cap clamp audit contract. One entry per clamp observed during
 * adaptive validation. Leaf module: no imports.
 */
export interface LoadCapAuditEntry {
  exerciseId: string;
  proposedLoadKg: number;
  cappedLoadKg: number;
  maxLoadIncreasePct: number;
  observedAt: string;
}

export function buildClampAuditEntry(
  exerciseId: string,
  proposedLoadKg: number,
  cappedLoadKg: number,
  maxLoadIncreasePct: number,
): LoadCapAuditEntry {
  return {
    exerciseId,
    proposedLoadKg,
    cappedLoadKg,
    maxLoadIncreasePct,
    observedAt: new Date().toISOString(),
  };
}
```

#### 2. lib/generation/load-cap-audit/recorder.ts

```ts
import { buildClampAuditEntry, type LoadCapAuditEntry } from "./types";

// Per-generation buffer. Filled by recordClampEvent during validation and
// emptied by drainClampEvents; the generation lifecycle owns when drain runs.
const entries: LoadCapAuditEntry[] = [];

export function recordClampEvent(
  exerciseId: string,
  proposedLoadKg: number,
  cappedLoadKg: number,
  maxLoadIncreasePct: number,
): LoadCapAuditEntry {
  const entry = buildClampAuditEntry(
    exerciseId,
    proposedLoadKg,
    cappedLoadKg,
    maxLoadIncreasePct,
  );
  entries.push(entry);
  return entry;
}

export function drainClampEvents(): LoadCapAuditEntry[] {
  return entries.splice(0, entries.length);
}
```

#### Test Contract:
- **Behavior**: buildClampAuditEntry populates every field from the clamp input.
  - Test: `buildClampAuditEntry populates all fields` -> `lib/generation/load-cap-audit/types.test.ts`
  - Oracle: input `("bench-press", 110, 105, 5)` -> `{ exerciseId: "bench-press", proposedLoadKg: 110, cappedLoadKg: 105, maxLoadIncreasePct: 5, observedAt: <parseable ISO-8601 string> }`.
  - Expected red: `lib/generation/load-cap-audit/types.ts` does not exist at HEAD.
- **Behavior**: recordClampEvent buffers the entry and drainClampEvents returns and empties the buffer.
  - Test: `record then drain round-trips one entry` -> `lib/generation/load-cap-audit/recorder.test.ts`
  - Oracle: after `recordClampEvent("squat", 140, 130, 7.5)`, `drainClampEvents()` -> `[{ exerciseId: "squat", proposedLoadKg: 140, cappedLoadKg: 130, maxLoadIncreasePct: 7.5, observedAt: <ISO> }]`, and a second `drainClampEvents()` -> `[]`.
  - Expected red: `lib/generation/load-cap-audit/recorder.ts` does not exist at HEAD.

#### Success Criteria:
##### Automated Verification:
- [ ] New modules typecheck: `npx tsc --noEmit`
- [ ] Contract tests pass: `npx vitest run lib/generation/load-cap-audit/types.test.ts lib/generation/load-cap-audit/recorder.test.ts`
##### Manual Verification:
- [ ] Entry field names read in coach vocabulary (prescribed / capped, kg).

### Slice 2: Wire recorder into validation and format the coach summary — CURRENT

**Files**: `lib/generation/adaptive-context/validation.ts`, `lib/generation/load-cap-audit/format.ts`

_(Code, Test Contract, and Success Criteria generated at Step 6.1; written here at Step 6.4 after the micro-checkpoint.)_

#### Test Contract:

_(To be written at Step 6.4.)_

#### Success Criteria:

_(To be written at Step 6.4.)_

### Slice 3: Coach dashboard surface — pending

**Files**: `components/coach/ClampSummaryCard.tsx`, `app/coach/plans/[planId]/page.tsx`

Terminal slice. Introduces the `ClampSummaryCard` component that renders the summary string on the coach plan page. Depends on Slice 2's `formatClampSummary`. Not yet generated.

## Desired End State

```ts
// during validation, at the clamp site:
recordClampEvent("bench-press", 110, 105, 5);

// after generation completes, in the plan-generation caller:
const summary = formatClampSummary(drainClampEvents());
// -> "1 load cap applied (largest reduction 5.0 kg)."
```

## File Map

```
lib/generation/load-cap-audit/types.ts        # NEW — entry shape + builder
lib/generation/load-cap-audit/recorder.ts     # NEW — in-memory recorder
lib/generation/adaptive-context/validation.ts # MODIFY — record at clamp site
lib/generation/load-cap-audit/format.ts       # NEW — coach summary formatter
components/coach/ClampSummaryCard.tsx          # NEW (Slice 3) — dashboard surface
```

## Ordering Constraints

- Slice 1 before Slice 2 (recorder + types are Slice 2's dependency).
- Slice 3 after Slice 2 (needs `formatClampSummary`).

## Verification Notes

- The recorder must not change validation's accept/reject result — the clamp record is a side effect at the existing comparison, not a new rejection path.
- Read the cap through the exported load-cap helpers; do not re-derive the arithmetic or tolerance (Cap stays single-owner).

## Performance Considerations

Per-generation buffer bounded by exercise count; one entry allocation per clamp.

## References

- Research: `.rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-surface.md`

## Design History

- Slice 1: Audit entry types and in-memory recorder — approved as generated
- Slice 2: Wire recorder into validation and format the coach summary — pending
- Slice 3: Coach dashboard surface — pending
