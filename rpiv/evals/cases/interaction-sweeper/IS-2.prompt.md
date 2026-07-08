Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:interaction-sweeper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Target: the GymApp application (cross-cutting sample)   Layers:
L0 — app/ routes and pages
L1 — components/ UI
L2 — lib/ domain + db access
L3 — supabase/ schema + migrations
L4 — tests/ + tools/

Verified finding set (each: id | lens | file:line | `verbatim line` | severity | one-line what-it-is):
X1 | Lc | lib/db/body-metrics.ts:16 | `type ExistingBodyMetricKey = Pick<` | Med | mutation-input assembly mixed with dedup-key derivation in one module
X2 | C | components/shared/account-menu.tsx:13 | `const MENU_ACTION_COLOR = "#f5efe7";` | Med | presentation copy hard-coded in a shared primitive
X3 | A | lib/external/exercise-providers/exercisedb-oss.ts:25 | `instructions: z` | Med | exported mapper has a single internal caller (speculative export)
X4 | D | supabase/migrations/20260617114300_clear_structured_prescription_on_exercise_change.sql:5 | `SET search_path = public` | Med | trigger intent restated in a schema comment
X5 | G | lib/workout/adherence.ts:12 | `cycleAnchorDate: string;` | Med | file accretes unrelated calculations

Co-change pairs (hidden coupling, no import edge):
(none — no pair cleared the threshold)

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 `file:line` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.
</agent-prompt>