---
date: 2026-07-08T20:45:12+0100
author: Pedro Mesquita
commit: b460257
branch: no-branch
repository: wt-head
topic: "Load-cap clamp audit trail"
tags: [design, generation, load-cap, clamp-audit, adaptive-context]
status: ready
parent: .rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-audit.md
last_updated: 2026-07-08T20:45:12+0100
last_updated_by: Pedro Mesquita
content_hash: 8055837de3c99cd4d944658d797697ec515741931dbd5033301bf6146e6329ea
---

# Design: Load-cap clamp audit trail

## Summary

Add an in-memory, per-generation-run audit trail that records each time the adaptive validation pipeline detects a proposed load above the allowed cap (a "clamp event"), plus a deterministic coach-facing summary string. A new co-located leaf module (`adaptive-context/clamp-audit.ts`) owns the event type, a per-call recorder buffer, and the summary formatter; `adaptive-context/validation.ts` creates a recorder per call, records at the two existing sites that compare a proposed load against `getMaxAllowedLoadKg(...)`, and returns `clampEvents` + `clampSummary` alongside its existing `{ valid, errors }` result. No DB persistence and no cycle-narrative wiring (deferred follow-ups).

## Requirements

- Record, per generation run, each exercise whose proposed load exceeded the load cap: exercise id, proposed load (kg), capped load / ceiling (kg), and cap percentage.
- Produce a deterministic, coach-facing summary string from those events.
- Observe at the validation side, at the existing cap comparison (research Developer Context, `validation.ts:475`).
- Reuse `load-cap.ts` exports; never re-derive the cap formula or the kg epsilon inline (arch-review IX-1).
- Keep the generation path deterministic — no wall-clock or other nondeterministic reads.
- In scope: in-memory buffer + summary string. Out of scope: DB persistence, wiring the summary into `cycle-narrative.ts`.

## Current State Analysis

The max-allowed-load formula and its kg tolerance live in one leaf, `lib/generation/load-cap.ts`; the epsilon (`LOAD_EPSILON_KG = 0.001`) is unexported so consumers must speak through `getMaxAllowedLoadKg` + the `loadExceeds` / `loadAtOrBelow` / `loadReducedBelow` predicates. The validation side (`adaptive-context/validation.ts`) computes the cap at two sites and compares a proposed load against it; those are the only cap-comparison points. The apply side clamps loads to the ceiling separately. `lib/generation` is documented-deterministic and policed by a `determinism-guard` unit test.

### Key Discoveries

- `lib/generation/load-cap.ts:15` — `getMaxAllowedLoadKg(prescribedLoadKg, maxLoadIncreasePct)`, the single-owner cap formula. `:13` — unexported `LOAD_EPSILON_KG`. `:22-32` — the three sanctioned predicates. Leaf module, no imports.
- `lib/generation/adaptive-context/validation.ts:309` and `:468` — the two places the cap value is computed via `getMaxAllowedLoadKg`.
- `lib/generation/adaptive-context/validation.ts:305-318` (`getIncreaseLoadValidationError`) — over-cap detected via `loadAtOrBelow(load, maxAllowedLoad)` being false (final return). **Clamp site #1.**
- `lib/generation/adaptive-context/validation.ts:472-477` (`getTrialLoadSetValidationError`) — over-cap detected via `loadExceeds(topSetLoad, maxAllowedLoad)`. **Clamp site #2.**
- Other `loadExceeds(load, summary.prescribedLoadKg)` sites (`:351`, `:378`, `:407`, `:482`) compare against the **prior load**, not the cap — they are NOT clamp events and must not record.
- `lib/generation/adaptive-context/history.ts:461-463` — `formatNumber(value)` = `Number.isInteger(value) ? String(value) : value.toFixed(1)`, already used for kg values in validation error strings.
- `lib/generation/plan-generation/build-validate.ts:64-68` — the sole production caller; reads only `adaptiveValidation.errors`. Extending the return object is backward-compatible.
- `tests/unit/generation/adaptive-context/validation.test.ts:19-113` — factory helpers (`createOutput`, `createRecommendation`, `createSummary`, `createOutputExercise`, `prescriptionSet`) to reuse for Slice 3 tests.
- `tests/unit/generation/determinism-guard.test.ts` — static source guard; the recorder must not introduce nondeterministic reads.

## Scope

### Building

- `lib/generation/adaptive-context/clamp-audit.ts` — `LoadClampEvent` type, `ClampAuditRecorder` interface, `createClampAuditRecorder()` factory (per-call buffer), `summarizeClampEvents()` deterministic coach-facing summary.
- `lib/generation/adaptive-context/validation.ts` — create a recorder per `validateAdaptivePlanOutput` call, thread it to the two cap sites, record over-cap events, return `clampEvents` + `clampSummary`.

### Not Building

- **DB persistence** of clamp events (deferred).
- **Wiring the summary into `cycle-narrative.ts`** or any consumer — the summary is produced and returned but not yet read (deferred).
- **Apply-side clamp observation** — recording where `getLoadIncreaseTarget` (`prescription-math.ts:146-181`) silently floors a load to the ceiling. The validation seam records only over-cap *detections* (currently validation errors), not routine apply-side clampings. Distinct observation point; deferred.
- **Enriched event fields** (progression `action`, prior load, precomputed overage). Overage is derived in the summary; extra fields are out of the research-stated scope.
- **Hoisting `clamp-audit.ts` to top-level `lib/generation/`** — stays co-located with its only consumer until a cross-stage consumer (e.g. cycle-narrative) needs it.
- **Timestamps on events** — would require a clock; excluded to preserve determinism.

## Decisions

### TDD Standard (standing)
Every behavior-changing slice MUST carry a `#### Test Contract:` with at least one **Behavior** whose **Oracle** pins exact input -> expected-output values (the strongest checkable oracle; any weakening justified inline) and an **Expected red** reason. Non-behavioral slices/items carry explicit `TDD-exempt` markers with reasons. Recorded as a commitment so slice-verifier's commitments audit flags violations per slice.

### Observation seam: validation side, cap-comparison sites only
- **Inherited** (research Developer Context, `validation.ts:475`): observe on the validation side at the existing cap comparison.
- **Decision**: record only at the two sites that compare a proposed load against `getMaxAllowedLoadKg(...)` — `getIncreaseLoadValidationError` (`:305-318`) and `getTrialLoadSetValidationError` (`:472-477`). The prior-load `loadExceeds(load, prescribedLoadKg)` comparisons (`:351`, `:378`, `:407`, `:482`) are a different ceiling and do not record.

### What a "clamp event" means here (honesty note)
- These two sites fire only when the proposed load **exceeds** the cap, which in the current pipeline is a validation **error** that fails the plan. So the recorder audits **over-cap detections** — useful for coaches understanding why a plan was rejected/regenerated on load grounds. It does NOT capture routine apply-side clampings (silent floor-to-ceiling). That apply-side observation is a separate, deferred follow-up (see Not Building). The design is faithful to the developer's chosen seam; the term "clamp event" denotes an over-cap detection.

### Reuse the cap value already computed at the site (single-owner)
- **Decision**: record the `maxAllowedLoad` already computed by `getMaxAllowedLoadKg` at each site as `cappedLoadKg`; reuse the existing predicate branch. Never re-derive `cappedKg < prescribedKg` or touch the epsilon (arch-review IX-1). Ambiguity resolved toward reuse, not re-computation.

### Recorder lifecycle: per-call, created inside validation (resolves research Open Question)
- **Ambiguity** (research Open Question): module-level buffer vs threaded per-run recorder.
- **Option A** — module-level singleton buffer. Con: cross-run contamination under concurrent generations; hidden mutable global; not per-run isolable.
- **Option B** — recorder created inside `validateAdaptivePlanOutput` and threaded through the internal call chain. Pro: per-call isolation (each generation run gets its own buffer), no module state, deterministic. Con: adds a threaded param to ~6 module-private validation functions.
- **Decision**: Option B. Per-run isolation is the safe first cut and directly answers the Open Question.

### API shape: extend the return object, keep the signature
- **Decision**: keep `validateAdaptivePlanOutput(output, adaptiveContext)`; add `clampEvents: readonly LoadClampEvent[]` and `clampSummary: string` to the returned object. The sole caller (`build-validate.ts:64-68`) reads only `.errors`, so this is backward-compatible. The recorder is not exposed as a caller-supplied parameter.

### Summary computed inside validation
- **Decision**: `validateAdaptivePlanOutput` calls `summarizeClampEvents(recorder.entries())` and returns the string. This gives `summarizeClampEvents` a real production caller (not a test-only export → clean for knip) and makes the in-scope "coach-facing summary string" deliverable actually produced.

### Number formatting: reuse `formatNumber`
- **Decision**: `summarizeClampEvents` uses `formatNumber` (`history.ts:461`) for kg and cap-pct values, matching the existing validation error-string formatting. Ambiguity (reuse vs inline) resolved toward reuse for output consistency.

### Module placement: co-located leaf
- **Decision**: `lib/generation/adaptive-context/clamp-audit.ts`, beside its only consumer (`validation.ts`) and the `formatNumber` source (`history.ts`). Not top-level (unlike `load-cap.ts`) because it has a single stage-local consumer today.

## Architecture

### lib/generation/adaptive-context/clamp-audit.ts — NEW

Event type, per-call recorder buffer, and deterministic coach-facing summary for load-cap clamp events.

```ts
import { formatNumber } from "@/lib/generation/adaptive-context/history";

/**
 * Load-cap clamp audit trail.
 *
 * A clamp event records an exercise whose proposed load was detected above the
 * allowed cap. `createClampAuditRecorder()` returns a fresh in-memory buffer on
 * every call and reads no wall clock, so a caller that creates one recorder per
 * generation run keeps runs isolated and the generation determinism invariant
 * intact.
 */

export interface LoadClampEvent {
  exerciseId: string;
  // The load the plan proposed (kg) -- the value that overshot the cap.
  proposedLoadKg: number;
  // The allowed ceiling (kg) -- getMaxAllowedLoadKg(...) at the detection site.
  cappedLoadKg: number;
  // The cap percentage the ceiling was derived from (max_load_increase_pct).
  capPct: number;
}

export interface ClampAuditRecorder {
  record(event: LoadClampEvent): void;
  entries(): readonly LoadClampEvent[];
}

export function createClampAuditRecorder(): ClampAuditRecorder {
  const events: LoadClampEvent[] = [];

  return {
    record(event) {
      events.push(event);
    },
    entries() {
      return events;
    },
  };
}

// Deterministic coach-facing summary of a run's clamp events. Reuses formatNumber
// so kg / pct render exactly like the validation error strings. Order follows the
// buffer's insertion order (session/exercise iteration order -- deterministic).
export function summarizeClampEvents(events: readonly LoadClampEvent[]): string {
  if (events.length === 0) {
    return "No loads were capped.";
  }

  const noun = events.length === 1 ? "load" : "loads";
  const details = events
    .map(
      (event) =>
        `${event.exerciseId} proposed ${formatNumber(event.proposedLoadKg)} kg, capped to ${formatNumber(event.cappedLoadKg)} kg (max +${formatNumber(event.capPct)}%)`,
    )
    .join("; ");

  return `${events.length} ${noun} capped: ${details}.`;
}
```

### lib/generation/adaptive-context/validation.ts — MODIFY

Create a per-call recorder, thread it to the two cap-comparison sites, record over-cap events, and return `clampEvents` + `clampSummary`. Only the changed/added sections are shown; the rest of the file (including the untouched prior-load comparison functions) stays as-is on disk. Biome (`npm run check`) orders the new import among the `@/lib/generation/adaptive-context/*` group.

```ts
// Added import (alongside the existing @/lib/generation/adaptive-context/* imports).
import {
  type ClampAuditRecorder,
  createClampAuditRecorder,
  summarizeClampEvents,
} from "@/lib/generation/adaptive-context/clamp-audit";

// --- changed: create a per-call recorder, thread it, return clampEvents + clampSummary ---
export function validateAdaptivePlanOutput(
  output: AdaptiveValidationOutput,
  adaptiveContext: AdaptivePlanContext,
) {
  const exerciseById = new Map(
    adaptiveContext.filteredAllowedExercises.map((exercise) => [
      exercise.id,
      exercise,
    ]),
  );
  const guidanceResolver = createAdaptiveGuidanceResolver(adaptiveContext);
  const recorder = createClampAuditRecorder();
  const errors = output.sessions.flatMap((session) =>
    session.exercises.flatMap((exercise) =>
      isPreparationPrescription(exercise)
        ? []
        : getAdaptiveValidationErrorsForExercise({
            adaptiveContext,
            dayOfWeek: session.day_of_week,
            exercise,
            exerciseById,
            guidanceResolver,
            recorder,
          }),
    ),
  );

  const clampEvents = recorder.entries();
  return {
    valid: errors.length === 0,
    errors,
    clampEvents,
    clampSummary: summarizeClampEvents(clampEvents),
  };
}

// --- changed: accept + forward `recorder` to both downstream branches ---
function getAdaptiveValidationErrorsForExercise({
  adaptiveContext,
  dayOfWeek,
  exercise,
  exerciseById,
  guidanceResolver,
  recorder,
}: {
  adaptiveContext: AdaptivePlanContext;
  dayOfWeek: string;
  exercise: AdaptiveValidationExercise;
  exerciseById: Map<string, ExerciseSpec>;
  guidanceResolver: ReturnType<typeof createAdaptiveGuidanceResolver>;
  recorder: ClampAuditRecorder;
}) {
  const blockedError = getBlockedExerciseValidationError(
    adaptiveContext,
    dayOfWeek,
    exercise.exercise_id,
  );
  if (blockedError) {
    return [blockedError];
  }

  const plannedExercise = exerciseById.get(exercise.exercise_id);
  const guidance = plannedExercise
    ? guidanceResolver.resolveForExercise(plannedExercise)
    : null;

  if (!guidance) {
    return [];
  }

  return guidance.source === "exact"
    ? getSummaryBackedValidationErrors(
        exercise,
        guidance.recommendation,
        guidance.summary,
        recorder,
      )
    : getFamilyGuidanceValidationErrors(exercise, guidance, recorder);
}

// --- changed: forward `recorder` to the summary-backed path ---
function getFamilyGuidanceValidationErrors(
  exercise: AdaptiveValidationExercise,
  guidance: FamilyGuidance,
  recorder: ClampAuditRecorder,
) {
  const behavior = getAdaptiveActionBehavior(
    "family",
    guidance.recommendation.action,
  );

  if (behavior.transform === "none") {
    return getFamilyFallbackValidationErrors(exercise, guidance.recommendation);
  }

  if (guidance.summary) {
    return getSummaryBackedValidationErrors(
      exercise,
      guidance.recommendation,
      guidance.summary,
      recorder,
    );
  }

  return getFamilyFallbackValidationErrors(exercise, guidance.recommendation);
}

// --- changed: forward `recorder` only to the load path (volume path has no cap site) ---
function getSummaryBackedValidationErrors(
  exercise: AdaptiveValidationExercise,
  recommendation: ProgressionRecommendation,
  summary: AdaptiveValidationSummary,
  recorder: ClampAuditRecorder,
) {
  return [
    ...getLoadValidationErrors(exercise, recommendation, summary, recorder),
    ...getVolumeValidationErrors(exercise, recommendation, summary),
  ];
}

// --- changed: forward `recorder` to the two cap-comparison cases only ---
function getLoadValidationErrors(
  exercise: AdaptiveValidationExercise,
  recommendation: ProgressionRecommendation,
  summary: AdaptiveValidationSummary,
  recorder: ClampAuditRecorder,
) {
  const action = getRecommendationLoadAction(recommendation);
  const behavior = getLoadAdaptiveActionBehavior(action);

  switch (behavior.validation) {
    case "densityIncrease":
      return collectValidationErrors(
        getIncreaseDensityValidationError(exercise, summary),
      );
    case "loadIncreaseCap":
      return collectValidationErrors(
        getIncreaseLoadValidationError(
          exercise,
          recommendation,
          summary,
          recorder,
        ),
      );
    case "nonIncreasingLoad":
      return collectValidationErrors(
        getNonIncreasingLoadValidationError(exercise, action, summary),
      );
    case "reduceLoad":
      return collectValidationErrors(
        getReduceLoadValidationError(exercise, summary),
      );
    case "repCapIncrease":
      return collectValidationErrors(
        getIncreaseRepsValidationError(exercise, summary),
      );
    case "repRangeChange":
      return collectValidationErrors(
        getRepRangeChangeValidationError(exercise, summary),
      );
    case "substitutionRequired":
      return collectValidationErrors(
        getSwapValidationError(exercise.exercise_id),
      );
    case "trialLoadSet":
      return collectValidationErrors(
        getTrialLoadSetValidationError(
          exercise,
          recommendation,
          summary,
          recorder,
        ),
      );
    case "none":
      return [];
    default:
      return [];
  }
}

// --- changed: record the over-cap event (reusing the maxAllowedLoad already computed) ---
function getIncreaseLoadValidationError(
  exercise: AdaptiveValidationExercise,
  recommendation: ProgressionRecommendation,
  summary: AdaptiveValidationSummary,
  recorder: ClampAuditRecorder,
) {
  if (exercise.load_target_kg === null) {
    return null;
  }

  if (
    recommendation.max_load_increase_pct === null ||
    summary.prescribedLoadKg === null
  ) {
    return `${exercise.exercise_id}: increase-load recommendation requires a prior load and cap`;
  }

  if (loadAtOrBelow(exercise.load_target_kg, summary.prescribedLoadKg)) {
    return `${exercise.exercise_id}: increase-load recommendation requires load above ${formatNumber(summary.prescribedLoadKg)} kg`;
  }

  const maxAllowedLoad = getMaxAllowedLoadKg(
    summary.prescribedLoadKg,
    recommendation.max_load_increase_pct,
  );

  if (loadAtOrBelow(exercise.load_target_kg, maxAllowedLoad)) {
    return null;
  }

  recorder.record({
    exerciseId: exercise.exercise_id,
    proposedLoadKg: exercise.load_target_kg,
    cappedLoadKg: maxAllowedLoad,
    capPct: recommendation.max_load_increase_pct,
  });
  return `${exercise.exercise_id}: load ${exercise.load_target_kg} kg exceeds the allowed cap of ${formatNumber(maxAllowedLoad)} kg`;
}

// --- changed: record the over-cap top-set event (reusing the maxAllowedLoad already computed) ---
function getTrialLoadSetValidationError(
  exercise: AdaptiveValidationExercise,
  recommendation: ProgressionRecommendation,
  summary: AdaptiveValidationSummary,
  recorder: ClampAuditRecorder,
) {
  const sets = exercise.prescription_sets ?? [];
  if (sets.length === 0) {
    return `${exercise.exercise_id}: trial-load recommendation requires structured prescription sets`;
  }
  if (
    recommendation.max_load_increase_pct === null ||
    summary.prescribedLoadKg === null
  ) {
    return `${exercise.exercise_id}: trial-load recommendation requires a prior load and cap`;
  }

  const topSetLoad = sets[0]?.load_kg;
  if (topSetLoad === null || topSetLoad === undefined) {
    return null;
  }

  const priorLoadKg = summary.prescribedLoadKg;
  const maxAllowedLoad = getMaxAllowedLoadKg(
    priorLoadKg,
    recommendation.max_load_increase_pct,
  );
  if (loadAtOrBelow(topSetLoad, priorLoadKg)) {
    return `${exercise.exercise_id}: trial-load top set must be above ${formatNumber(priorLoadKg)} kg`;
  }
  if (loadExceeds(topSetLoad, maxAllowedLoad)) {
    recorder.record({
      exerciseId: exercise.exercise_id,
      proposedLoadKg: topSetLoad,
      cappedLoadKg: maxAllowedLoad,
      capPct: recommendation.max_load_increase_pct,
    });
    return `${exercise.exercise_id}: trial-load top set exceeds the allowed cap of ${formatNumber(maxAllowedLoad)} kg`;
  }
  if (
    sets
      .slice(1)
      .some(
        (set) => set.load_kg !== null && loadExceeds(set.load_kg, priorLoadKg),
      )
  ) {
    return `${exercise.exercise_id}: trial-load back-off sets must not exceed the prior prescribed load`;
  }

  return null;
}
```

## Slices

### Slice 1: clamp event type + recorder buffer

**Files**: `lib/generation/adaptive-context/clamp-audit.ts`

#### Test Contract:
- **Behavior**: the recorder appends events and returns them in insertion order.
  - Test: `createClampAuditRecorder records events in insertion order` -> `tests/unit/generation/adaptive-context/clamp-audit.test.ts`
  - Oracle: create recorder; `record({ exerciseId: "ex-1", proposedLoadKg: 110, cappedLoadKg: 105, capPct: 5 })` then `record({ exerciseId: "ex-2", proposedLoadKg: 60, cappedLoadKg: 55, capPct: 10 })`; `entries()` deep-equals `[{ exerciseId: "ex-1", proposedLoadKg: 110, cappedLoadKg: 105, capPct: 5 }, { exerciseId: "ex-2", proposedLoadKg: 60, cappedLoadKg: 55, capPct: 10 }]` and `entries().length === 2`.
  - Expected red: module `clamp-audit.ts` / `createClampAuditRecorder` does not exist yet — the import fails to resolve.
- **Behavior**: two recorder instances are isolated (no shared buffer).
  - Test: `createClampAuditRecorder isolates buffers between instances` -> `tests/unit/generation/adaptive-context/clamp-audit.test.ts`
  - Oracle: `const r1 = createClampAuditRecorder(); const r2 = createClampAuditRecorder();` record one event into `r1` only; `r1.entries().length === 1` and `r2.entries()` deep-equals `[]`.
  - Expected red: factory does not exist yet.

#### Automated Verification:
- [ ] `lib/generation/adaptive-context/clamp-audit.ts` exists and exports `LoadClampEvent`, `ClampAuditRecorder`, `createClampAuditRecorder`.
- [ ] Slice tests pass: `npm test -- clamp-audit`
- [ ] No nondeterministic read: `grep -nE "Date|Math.random|performance.now" lib/generation/adaptive-context/clamp-audit.ts` returns 0 hits.
- [ ] No epsilon re-derivation: `grep -nE "EPSILON|0\.001" lib/generation/adaptive-context/clamp-audit.ts` returns 0 hits.

#### Manual Verification:
- [ ] Event fields match the research scope (exercise id, proposed vs capped load, cap pct) — no extra fields.
- [ ] The recorder test types its expected-events fixture as `LoadClampEvent[]` (imports `type LoadClampEvent`), keeping the export consumed by name so `npm run knip` (run in Slice 3) does not flag it.

### Slice 2: coach-facing summary

**Files**: `lib/generation/adaptive-context/clamp-audit.ts`

#### Test Contract:
- **Behavior**: an empty event list yields a clear no-clamp sentence.
  - Test: `summarizeClampEvents returns a no-clamp sentence for an empty list` -> `tests/unit/generation/adaptive-context/clamp-audit.test.ts`
  - Oracle: `summarizeClampEvents([])` === `"No loads were capped."`
  - Expected red: `summarizeClampEvents` is not exported yet.
- **Behavior**: a single event uses the singular noun and formatted kg / pct values.
  - Test: `summarizeClampEvents formats a single clamp with the singular noun` -> `tests/unit/generation/adaptive-context/clamp-audit.test.ts`
  - Oracle: `summarizeClampEvents([{ exerciseId: "back-squat", proposedLoadKg: 105, cappedLoadKg: 102.5, capPct: 5 }])` === `"1 load capped: back-squat proposed 105 kg, capped to 102.5 kg (max +5%)."`
  - Expected red: function absent — import does not resolve.
- **Behavior**: multiple events use the plural noun and preserve insertion order joined by "; ".
  - Test: `summarizeClampEvents joins multiple clamps in order with the plural noun` -> `tests/unit/generation/adaptive-context/clamp-audit.test.ts`
  - Oracle: `summarizeClampEvents([{ exerciseId: "back-squat", proposedLoadKg: 105, cappedLoadKg: 102.5, capPct: 5 }, { exerciseId: "bench-press", proposedLoadKg: 60, cappedLoadKg: 55, capPct: 10 }])` === `"2 loads capped: back-squat proposed 105 kg, capped to 102.5 kg (max +5%); bench-press proposed 60 kg, capped to 55 kg (max +10%)."`
  - Expected red: function absent.

#### Automated Verification:
- [ ] `summarizeClampEvents` is exported from `lib/generation/adaptive-context/clamp-audit.ts`.
- [ ] Slice tests pass: `npm test -- clamp-audit`
- [ ] Formatting reuses `formatNumber`: `grep -n "import { formatNumber }" lib/generation/adaptive-context/clamp-audit.ts` → 1 hit; `grep -n "toFixed" lib/generation/adaptive-context/clamp-audit.ts` → 0 hits.

#### Manual Verification:
- [ ] The summary reads naturally to a coach for 0, 1, and 2 capped loads.

### Slice 3: record clamp events at validation cap sites

**Files**: `lib/generation/adaptive-context/validation.ts`

#### Test Contract:
- **Behavior**: an increase-load proposal above the cap records a clamp event and still returns the over-cap error.
  - Test: `validateAdaptivePlanOutput records a clamp event when an increase-load proposal exceeds the cap` -> `tests/unit/generation/adaptive-context/validation.test.ts`
  - Oracle: summary `prescribedLoadKg: 100`; recommendation `action: "increase_load", max_load_increase_pct: 5` (=> `maxAllowedLoad` 105); output exercise `load_target_kg: 110`. `result.clampEvents` deep-equals `[{ exerciseId: "ex-1", proposedLoadKg: 110, cappedLoadKg: 105, capPct: 5 }]`; `result.clampSummary` === `"1 load capped: ex-1 proposed 110 kg, capped to 105 kg (max +5%)."`; `result.errors` contains `"ex-1: load 110 kg exceeds the allowed cap of 105 kg"`.
  - Expected red: before this slice `validateAdaptivePlanOutput` returns no `clampEvents` / `clampSummary` (both `undefined`).
- **Behavior**: a proposal exactly at the cap records nothing (ceiling boundary — `loadAtOrBelow(105, 105)` is true because `105 <= 105 + 0.001`).
  - Test: `validateAdaptivePlanOutput records no clamp event when the load is at the cap` -> `tests/unit/generation/adaptive-context/validation.test.ts`
  - Oracle: same setup with `load_target_kg: 105`. `result.clampEvents` deep-equals `[]`; `result.clampSummary` === `"No loads were capped."`; `result.errors` contains no `"exceeds the allowed cap"` string.
  - Expected red: `clampEvents` / `clampSummary` fields absent before this slice.
- **Behavior**: a trial-load top set above the cap records a clamp event.
  - Test: `validateAdaptivePlanOutput records a clamp event when a trial-load top set exceeds the cap` -> `tests/unit/generation/adaptive-context/validation.test.ts`
  - Oracle: summary `prescribedLoadKg: 100`; recommendation `action: "trial_load", max_load_increase_pct: 5` (=> cap 105); output exercise `prescription_sets` with top set `load_kg: 112` and back-off sets `load_kg <= 100`. `result.clampEvents` deep-equals `[{ exerciseId: "ex-1", proposedLoadKg: 112, cappedLoadKg: 105, capPct: 5 }]`; `result.errors` contains `"ex-1: trial-load top set exceeds the allowed cap of 105 kg"`.
  - Expected red: fields absent before this slice.

#### Automated Verification:
- [ ] `recorder.record(` appears exactly twice in `validation.ts` (the increase-load and trial-load cap branches only): `grep -c "recorder.record(" lib/generation/adaptive-context/validation.ts` → 2.
- [ ] No wall-clock/nondeterministic read added: `grep -nE "Date|Math.random|performance.now" lib/generation/adaptive-context/validation.ts` → 0 hits.
- [ ] `LoadClampEvent` is a consumed export (no knip unused-export flag): `grep -rn "LoadClampEvent" tests/unit/generation/adaptive-context/ lib/generation/` returns a by-name import outside `clamp-audit.ts` (see Slice 1 fixture typing).
- [ ] New + existing validation tests pass: `npm test -- validation`
- [ ] Biome CI passes: `npm run check`
- [ ] Boundaries / dead-code / types pass: `npm run deps`, `npm run knip`, `npm run typecheck`
- [ ] Full suite passes: `npm test`

#### Manual Verification:
- [ ] `build-validate.ts:64-68` still compiles reading only `.errors` (return-shape extension is backward-compatible).
- [ ] A generated plan with an over-cap increase-load proposal surfaces `clampSummary` naming that exercise.

## Desired End State

```ts
// A generation run validates its adaptive plan output; over-cap proposals are
// audited without disturbing the existing valid/errors contract.
const result = validateAdaptivePlanOutput(output, adaptiveContext);

result.valid;       // boolean — unchanged
result.errors;      // string[] — unchanged
result.clampEvents; // readonly LoadClampEvent[], e.g.
// [{ exerciseId: "back-squat", proposedLoadKg: 110, cappedLoadKg: 105, capPct: 5 }]
result.clampSummary;
// "1 load capped: back-squat proposed 110 kg, capped to 105 kg (max +5%)."

// No clamps this run:
// result.clampEvents === []  and  result.clampSummary === "No loads were capped."
```

## File Map

```
lib/generation/adaptive-context/clamp-audit.ts   # NEW — clamp event type + recorder buffer + summary formatter
lib/generation/adaptive-context/validation.ts    # MODIFY — thread recorder, record at 2 cap sites, return clampEvents/clampSummary
```

## Ordering Constraints

- Slice 1 (type + recorder) before Slice 2 (summary consumes `LoadClampEvent`).
- Slices 1-2 before Slice 3 (validation imports `createClampAuditRecorder`, `summarizeClampEvents`, and the `ClampAuditRecorder` type).
- Slices 1 and 2 share `clamp-audit.ts`; Slice 2 rewrites the file with the merged result.
- No parallelism — strictly sequential.

## Verification Notes

- Determinism preserved: the recorder adds no wall-clock read — grep `clamp-audit.ts` and the `validation.ts` diff for `Date`, `Math.random`, `performance.now` → 0 hits, and events carry no timestamp. This grep is the actual check: the existing `determinism-guard` test only guards ranking `localeCompare` in three named files and does not scan this module. `npm test -- determinism-guard` still passing confirms no regression to that ranking guard.
- Single-owner reuse: grep `clamp-audit.ts` for `EPSILON` / `0.001` → 0 hits; the cap value recorded is the `maxAllowedLoad` from the existing `getMaxAllowedLoadKg` call, not a re-derived comparison.
- Only the two cap sites record: `recorder.record(` appears exactly twice in `validation.ts`, in the `getIncreaseLoadValidationError` and `getTrialLoadSetValidationError` over-cap branches — not at the prior-load comparison sites.
- Existing behavior unchanged: the current `validation.test.ts` suite stays green (valid/errors contract intact).
- Quality pipeline: `npm run check`, `npm run deps` (clamp-audit stays within generation; no AI/DB/app import), `npm run knip`, `npm run typecheck`.
- Knip / unused-export detail: `createClampAuditRecorder`, `summarizeClampEvents`, and `ClampAuditRecorder` are imported by name in `validation.ts`. `LoadClampEvent` — the feature's event data contract — is NOT imported by name in `validation.ts` (both `recorder.record({...})` sites pass structurally-typed object literals), so to keep knip green it must have a by-name consumer: the clamp-audit unit test types its expected-event fixture as `LoadClampEvent[]` (and the deferred `cycle-narrative` consumer will import it too). Keep `LoadClampEvent` exported — do NOT unexport it to silence knip; it is public by design.

## Performance Considerations

Negligible: one array push per over-cap detection (rare in normal generation), one O(events) summary-string build per `validateAdaptivePlanOutput` call. No I/O, no caching, no N+1.

## Migration Notes

None — in-memory only. No schema change, no data migration, no rollback surface.

## Pattern References

- `lib/generation/load-cap.ts:15-32` — single-owner cap formula + predicates to reuse (never re-derive the epsilon).
- `lib/generation/adaptive-context/history.ts:461-463` — `formatNumber` to reuse for kg / pct formatting.
- `lib/generation/adaptive-context/validation.ts:289-319, 446-489` — the two cap-comparison functions to instrument.
- `tests/unit/generation/adaptive-context/validation.test.ts:19-113` — factory pattern for Slice 3 tests.

## Developer Context

Inherited from research (recorded, not re-asked):
- **Q (`validation.ts:475`): Where should clamp events be observed?** A: validation side, at the existing cap comparison. → Decisions: "Observation seam".
- **Q (`load-cap.ts:13`): Recompute the cap or reuse the owner?** A: reuse `load-cap.ts` exports. → Decisions: "Reuse the cap value".
- **Q (scope): How far does this go?** A: in-memory per-run buffer + coach summary; DB persistence and cycle-narrative wiring deferred. → Scope.

Headless design checkpoint (recommended options auto-selected):
- Recorder lifecycle → per-call, created inside `validateAdaptivePlanOutput` (resolves research Open Question). → Decisions.
- Module placement → co-located `adaptive-context/clamp-audit.ts`. → Decisions.
- Event fields → minimal scoped set (exerciseId, proposedLoadKg, cappedLoadKg, capPct). → Scope / Not Building.
- API shape → extend return object; keep signature. → Decisions.
- Summary formatting → reuse `formatNumber`. → Decisions.

## Design History

- Slice 1: clamp event type + recorder buffer — approved as generated (slice-verifier fix: reframed the header doc comment from a present-tense claim about `validateAdaptivePlanOutput` wiring to the factory's own per-call guarantee; corrected the determinism Verification Note to rely on the grep rather than overclaiming `determinism-guard` coverage)
- Slice 2: coach-facing summary — approved as generated (slice-verifier: Decisions/Cross-slice/Research all OK; all three oracles reproduced exactly against the live `formatNumber`)
- Slice 3: record clamp events at validation cap sites — approved as generated (slice-verifier: Decisions/Cross-slice OK, all three oracles hand-traced to exact matches incl. the `loadAtOrBelow(105,105)` ceiling boundary; Research WARNING on knip — `LoadClampEvent` is never imported by name, so a fixture-typing consumer + a corrected knip Verification Note were added, and the export is kept public for the deferred cycle-narrative consumer)

## References

- Research: `.rpiv/artifacts/research/2026-07-08_13-10-00_load-cap-clamp-audit.md`
- Precedent: unified load-cap clamp (arch-review IX-1) — centralized cap in `load-cap.ts`, forced predicate use.
