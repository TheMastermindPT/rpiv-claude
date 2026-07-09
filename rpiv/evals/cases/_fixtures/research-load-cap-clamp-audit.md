---
date: 2026-07-08T13:10:00+01:00
author: Pedro Mesquita
commit: b460257
branch: main
repository: GymApp
topic: "Load-cap clamp audit trail — enforcement surface and feature grounding"
tags: [research, codebase, load-cap, generation, adaptive-context]
status: complete
last_updated: 2026-07-08T13:10:00+01:00
last_updated_by: Pedro Mesquita
---

# Research: Load-cap clamp audit trail — enforcement surface and feature grounding

## Research Question

We want to add an audit trail that records each time the adaptive generation pipeline caps a proposed load (a "clamp" event), so coaches can see which exercises were capped and by how much. Before designing it, map where load caps are decided and enforced today, and identify the seam where a clamp is observable so a recorder can hook in without disturbing the single-owner load-cap contract.

## Summary

The max-allowed-load formula and its kg tolerance live in a single leaf module, `lib/generation/load-cap.ts`, which deliberately keeps its epsilon unexported so consumers must speak through its predicates. Two sides consume it: the validation side (`lib/generation/adaptive-context/validation.ts`) and the apply side (`lib/generation/adaptive-application/prescription-math.ts` and `prescription-mutators.ts`). The clamp-audit feature should observe clamp events at a consumer seam and buffer them per generation run, reusing the load-cap predicates rather than re-deriving the comparison. `lib/generation` carries a documented determinism invariant, so the recorder must not introduce wall-clock or other nondeterministic reads into the generation path.

## Detailed Findings

### Load-cap contract owner (`lib/generation/load-cap.ts`)
- `getMaxAllowedLoadKg(prescribedLoadKg, maxLoadIncreasePct)` (`lib/generation/load-cap.ts:15`) — the sole max-allowed-load formula.
- `LOAD_EPSILON_KG = 0.001` (`lib/generation/load-cap.ts:13`) — kept **unexported** by design; the header comment states consumers must use the predicates so the tolerance cannot be re-derived inline at call sites.
- Predicates: `loadExceeds` (`:22`), `loadAtOrBelow` (`:26`), `loadReducedBelow` (`:30`) — the only sanctioned comparisons. Leaf module, no imports.

### Validation side (`lib/generation/adaptive-context/validation.ts`)
- Imports the predicates + `getMaxAllowedLoadKg` (`lib/generation/adaptive-context/validation.ts:18-23`).
- Computes the cap and compares: `getMaxAllowedLoadKg(...)` at `:309` and `:468`; `loadExceeds(...)` at `:351`, `:378`, `:407`, `:475`.
- This is the seam where an over-cap proposed load is detected — the natural observation point for a clamp event.

### Apply side (`lib/generation/adaptive-application/`)
- `prescription-math.ts` uses `loadExceeds`/`loadAtOrBelow`/`loadReducedBelow` (`:161-188`) to floor/clamp targets.
- `prescription-mutators.ts` imports `getMaxAllowedLoadKg` (`:2`) and computes the cap at `:77`.

## Code References
- `lib/generation/load-cap.ts:15` — `getMaxAllowedLoadKg`, the single-owner formula
- `lib/generation/load-cap.ts:13` — unexported `LOAD_EPSILON_KG`
- `lib/generation/load-cap.ts:30` — `loadReducedBelow`, the "meaningful reduction" predicate a clamp recorder should reuse
- `lib/generation/adaptive-context/validation.ts:309` — cap computed on the validation side
- `lib/generation/adaptive-context/validation.ts:475` — `loadExceeds` clamp comparison
- `lib/generation/adaptive-application/prescription-math.ts:161-188` — apply-side clamp logic
- `lib/generation/adaptive-application/prescription-mutators.ts:77` — apply-side cap computation

## Integration Points

### Inbound References
- `lib/generation/adaptive-context/validation.ts:18-23` — imports the load-cap predicates
- `lib/generation/adaptive-application/prescription-math.ts:4-6` — imports the load-cap predicates
- `lib/generation/adaptive-application/prescription-mutators.ts:2` — imports `getMaxAllowedLoadKg`

### Outbound Dependencies
- `lib/generation/load-cap.ts` — leaf module, no outbound dependencies (this is what keeps it the single owner)

### Infrastructure Wiring
- No background jobs, events, or DI registration touch the load-cap path — it is pure synchronous computation inside plan generation.

## Architecture Insights
- **Single-owner contract**: the epsilon is unexported precisely so the tolerance cannot drift across call sites (the arch-review IX-1 lesson). Any new consumer (the clamp recorder) must reuse the predicates, never re-derive `cappedKg < prescribedKg` inline.
- **Determinism invariant**: `lib/generation` is documented as deterministic (same inputs → same output; a `determinism-guard` unit test polices it). A clamp recorder must not read the wall clock or other nondeterministic sources in the generation path.
- **Test convention**: generation unit tests live under `tests/unit/generation/`, not co-located under `lib/` (enforced by dependency-cruiser `no-dev-deps-in-runtime-code` and knip entry globs).

## Precedents & Lessons
1 similar past change analyzed.

### Precedent: unified load-cap clamp (arch-review IX-1)
**Blast radius**: load-cap.ts + validation.ts + adaptive-application
**Takeaway**: the apply and validate sides previously drifted because the cap formula was inlined in two places; the fix was to centralize in `load-cap.ts` and force predicate use. A new clamp recorder must not reintroduce inline comparisons.

### Composite Lessons
- Reuse `load-cap.ts` predicates for any load comparison; never inline the epsilon (`load-cap.ts:13`).
- Keep the generation path deterministic — inject any clock rather than calling `new Date()` inside a generation-path function.

## Historical Context (from `.rpiv/artifacts/`)
- (none inside this worktree — `.rpiv/artifacts` is gitignored in GymApp)

## Developer Context
**Q (`lib/generation/adaptive-context/validation.ts:475`): Where should clamp events be observed?**
A: On the validation side, at the existing `loadExceeds` cap comparison — that is where an over-cap proposed load is detected.

**Q (`lib/generation/load-cap.ts:13`): Should the recorder recompute the cap or reuse the owner?**
A: Reuse `load-cap.ts` exports; the formula and tolerance stay single-owner.

**Q (feature scope): How far does this feature go?**
A: In scope: an in-memory, per-generation buffer of clamp entries (exercise id, prescribed vs capped load, cap pct) plus a coach-facing summary string. Out of scope: database persistence and wiring the summary into `cycle-narrative.ts` (deferred follow-up).

## Related Research
- (none)

## Open Questions
- Whether concurrent generation runs need isolated buffers (threaded recorder) or a module-level buffer is acceptable for the first cut — resolve during design.
