Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:interaction-sweeper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Target: lib/generation   Layers:
L0 — Generation core (policies + barrels, 37 loose generation/*.ts)
L1 — Plan orchestration (plan-generation/ + deterministic-plan/, 14 files)
L2 — Adaptive sub-pipeline (adaptive-context/ + adaptive-application/, 26 files)
L3 — Prescriptions / ranking / substitution / patterns (26 files)
L4 — Validator / rationale / goal-rules / planner-types (19 files)

Verified finding set (each: id | lens | file:line | `verbatim line` | severity | one-line what-it-is):
M1 | M | lib/generation/adaptive-application/prescription-mutators.ts:76 | `const loadTargetKg = getLoadIncreaseTarget({` | High | "max allowed load = `prior*(1+pct/100)`" + `0.001` kg epsilon
M2 | M | lib/generation/plateau-rules.ts:251 | `if (evidence.maxRpe === null || evidence.maxRpe < 9.5) {` | High | "near-max exertion" `maxRpe >= 9.5`
M7 | M | lib/generation/progression-knobs.ts:37 | `} as const satisfies Record<LoadProgressionAction, LoadProgressionMode>;` | High | progression action/mode vocabulary scaffold + increase-ness
M5 | M | lib/generation/session-patterns/templates.ts:62 | `resolvedCyclePhasePolicy.replaceTrainingDayWithRecovery` | Med-High | "recovery-replacement day = `orderedTrainingDays[0]`"
M3 | M | lib/generation/adaptive-context/snapshots.ts:114 | `function buildExactSummarySnapshot(summary: ExerciseHistorySummary) {` | Med | exact vs family summary-snapshot field projection (21/22 fields identical)
M4 | M | lib/generation/plateau-rules.ts:239 | `return evidence.loggedSessions === 0 || evidence.loggedSets === 0` | Med | "no training exposure" `loggedSessions===0 \
M6 | M | lib/generation/volume-classification.ts:18 | `prescription.is_warmup === true ||` | Med | warm-up/preparation skip-guard re-derived (primitive exists)
L1 | L | lib/db/types.ts:3 | `// Auto-typed from schema; regenerate with: npx supabase gen types typescript` | High | `db/types.ts:3,38` imported by ~70 generation files (`training-cycle-policy.ts:1`, `equipment-rules.ts:1`, `session-archetypes.ts:
L2 | L | lib/generation/planner-types/deterministic.ts:48 | `export type DeterministicPlanOutput = LLMPlanOutput & {` | High | `planner-types/deterministic.ts:48` `export type DeterministicPlanOutput = LLMPlanOutput & {`
L3 | L | lib/generation/plan-generation/service.ts:26 | `import { createSupabaseServerClient } from "@/lib/supabase/server";` | High | `plan-generation/service.ts:26,175`, `run-lifecycle.ts:1,9`
L4 | L | lib/generation/substitution/context.ts:2 | `import { getAthleteProfile } from "@/lib/db/athlete-profiles";` | Med-High | `substitution/context.ts:2-3`, `candidates.ts:1`, `plan-generation/context.ts:9`, `template-selection.ts:7`, `generation-errors.ts
L5 | L | lib/generation/training-cycle-policy.ts:1 | `import type { AthleteProfileRow } from "@/lib/db/types";` | Med | `training-cycle-policy.ts:1`, `planner-types/deterministic.ts:6`, `adaptive-context.ts:8`
D1 | D | lib/generation/adaptive-application/family-transforms.ts:133 | `function capPrescriptionToFamilySummary(` | Med | `adaptive-application/family-transforms.ts:133` ↔ `prescription-mutators.ts:164`
D2 | D | lib/generation/prescriptions/base.ts:81 | `const resolvedCyclePhasePolicy =` | Med | `prescriptions/base.ts:81` ↔ `session-patterns/templates.ts:38`
D3 | D | lib/generation/exercise-ranking/scoring.ts:65 | `.sort((left, right) => {` | Low | `exercise-ranking/scoring.ts:65` ↔ `substitution/candidates.ts:92`
D4 | D | lib/generation/adaptive-context/history.ts:62 | `export function buildExactSummaryMap(` | Low | `adaptive-context/history.ts:62` ↔ `:103`
A1 | A | lib/generation/limitation-rules.ts:28 | `export function getHighRiskPatternsByLimitationRegionMap() {` | Med | `getHighRiskPatternsByLimitationRegionMap`
A2 | A | lib/generation/limitation-rules.ts:247 | `export function exerciseMatchesRegion(exercise: ExerciseRow, region: string) {` | Med | `exerciseMatchesRegion`
A3 | A | lib/generation/prescriptions/load-targets.ts:27 | `export function roundLoadTargetKg(` | Med | `roundLoadTargetKg`
A4 | A | lib/generation/adaptive-context/note-signals.ts:387 | `export function shouldUseConservativeProgressionFromWeeklyCheckIn(` | Med | `shouldUseConservativeProgressionFromWeeklyCheckIn`
A5 | A | lib/generation/intake-derivation.ts:54 | `export function getStructuredInjuryRegions(limitations: UserLimitationRow[]) {` | Med | `getStructuredInjuryRegions`

Co-change pairs (hidden coupling, no import edge):
lib/generation/adaptive-context/validation.ts -> lib/generation/adaptive-application.ts	support=6	conf=1.00
lib/generation/plateau-rules.ts -> lib/generation/adaptive-application.ts	support=4	conf=1.00
lib/generation/limitation-rules.ts -> lib/generation/adaptive-application.ts	support=4	conf=0.80
lib/generation/persist-plan.ts -> lib/generation/validator.ts	support=4	conf=0.50
lib/generation/plan-generation/persistence.ts -> lib/generation/plan-generation/run-lifecycle.ts	support=3	conf=1.00
lib/generation/substitution/apply-persistence.ts -> lib/generation/plan-generation/service.ts	support=3	conf=1.00
lib/generation/experience-rules.ts -> lib/generation/validator.ts	support=3	conf=1.00
lib/generation/session-archetypes.ts -> lib/generation/validator.ts	support=3	conf=1.00
lib/generation/session-quality.ts -> lib/generation/validator.ts	support=3	conf=1.00
lib/generation/plateau-rules.ts -> lib/generation/limitation-rules.ts	support=3	conf=0.75
lib/generation/session-fit.ts -> lib/generation/persist-plan.ts	support=3	conf=0.75
lib/generation/adaptive-context/recommendations.ts -> lib/generation/adaptive-context/snapshots.ts	support=3	conf=0.60
lib/generation/limitation-rules.ts -> lib/generation/rationale-snapshot.ts	support=3	conf=0.60
lib/generation/adaptive-context/recommendations.ts -> lib/generation/adaptive-application.ts	support=3	conf=0.60
lib/generation/adaptive-context/recommendations.ts -> lib/generation/adaptive-context/validation.ts	support=3	conf=0.60

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 `file:line` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.
</agent-prompt>