Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:slice-verifier" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Verify the just-generated slice before it is locked.

- artifact_path: .rpiv/eval-fixture/design-load-cap-audit.md
- slice_id: Slice 2
- target_files: lib/generation/adaptive-context/validation.ts, lib/generation/load-cap.ts (read both in full at HEAD; the Slice 1 modules `load-cap-audit/types.ts` and `load-cap-audit/recorder.ts` are the locked prior slice in the artifact and are not yet on disk — read them from the artifact's Slice 1 section)
- current_slice_code:

#### 1. lib/generation/adaptive-context/validation.ts
**File**: `lib/generation/adaptive-context/validation.ts`
**Changes**: MODIFY — record a clamp event at the existing increase-load cap comparison (around `lib/generation/adaptive-context/validation.ts:305-318`), without changing the accept/reject result.

```ts
import { getMaxAllowedLoad, loadExceeds } from "@/lib/generation/load-cap";
import { recordClampAudit } from "@/lib/generation/load-cap-audit/recorder";

// inside getIncreaseLoadValidationError, at the existing cap comparison:
const maxAllowedKg = getMaxAllowedLoad(
  summary.prescribedLoadKg,
  recommendation.max_load_increase_pct,
);
if (loadExceeds(maxAllowedKg, exercise.load_target_kg)) {
  recordClampAudit(
    exercise.exercise_id,
    exercise.load_target_kg,
    maxAllowedKg,
    recommendation.max_load_increase_pct,
  );
}
```

#### 2. lib/generation/load-cap-audit/format.ts
**File**: `lib/generation/load-cap-audit/format.ts`
**Changes**: NEW — pure coach-facing summary formatter.

```ts
import type { LoadCapAuditEntry } from "./types";

export function formatClampSummary(entries: LoadCapAuditEntry[]): string {
  if (entries.length === 0) {
    return "No load caps applied.";
  }
  const count = entries.length;
  const maxDeltaKg = Math.max(
    ...entries.map((e) => e.proposedLoadKg - e.cappedLoadKg),
  );
  return `${count} load cap${count === 1 ? "" : "s"} applied (largest reduction ${maxDeltaKg.toFixed(1)} kg).`;
}
```

#### Test Contract:
- **Behavior**: a clamp is recorded when the recommended load exceeds the allowed cap.
  - Test: `records one clamp when load exceeds cap` -> `lib/generation/adaptive-context/validation.test.ts`
  - Oracle: for prior prescribed load 100, `max_load_increase_pct: 5` (cap 105 kg), `load_target_kg: 110` -> exactly one recorded entry `{ exerciseId, proposedLoadKg: 110, cappedLoadKg: 105, maxLoadIncreasePct: 5 }`; for `load_target_kg: 104` -> no entry recorded.
  - Expected red: validation.ts does not call the recorder at HEAD.
- **Behavior**: the coach summary reads correctly for zero, one, and many clamps.
  - Test: `formatClampSummary renders the buffer` -> `lib/generation/load-cap-audit/format.test.ts`
  - Oracle: formatClampSummary returns a well-formed summary string describing how many caps were applied and the largest reduction.
  - Expected red: `lib/generation/load-cap-audit/format.ts` does not exist at HEAD.

#### Success Criteria:
##### Automated Verification:
- [ ] Contract tests pass: `npx vitest run lib/generation/adaptive-context/validation.test.ts lib/generation/load-cap-audit/format.test.ts`
- [ ] Each recorded entry is persisted to the `load_cap_audit` table so the audit survives the generation run.
##### Manual Verification:
- [ ] The clamp summary renders on the coach plan page via `<ClampSummaryCard>`.

Audit this slice per your procedure and emit your four-row summary.
</agent-prompt>
