Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:interaction-sweeper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Target: zero-fixture sample (five standalone modules)   Layers:
L0 — src/irrigation (valve scheduling)
L1 — src/chessclock (move timing)
L2 — src/ocr (invoice repair)
L3 — src/radio (beacon encoding)
L4 — src/aquarium (dosing)

Verified finding set (each: id | lens | file:line | `verbatim line` | severity | one-line what-it-is):
Z1 | Lc | src/irrigation/valve-scheduler.ts:14 | `return { valveId: telemetry.valveId, minutes, label: formatValveLabel(telemetry.valveId, minutes) };` | Med | window arithmetic mixed with display-label formatting in one unit
Z2 | G | src/chessclock/increment-engine.ts:13 | `export function estimateRoundsForPlayers(playerCount: number) {` | Med | unrelated tournament-pairing arithmetic accreted into the clock file
Z3 | A | src/ocr/invoice-normalizer.ts:9 | `export function normalizeVendorGlyphs(invoice: ScannedInvoice) {` | Med | speculative export with no production caller
Z4 | D | src/radio/morse-beacon.ts:3 | `const MORSE_TABLE: Record<string, string> = { A: ".-", B: "-...", C: "-.-." };` | Med | encoding table restated in the comment above it (drift risk)
Z5 | C | src/aquarium/ph-dosing.ts:5 | `const drift = 7.0 - reading.phMeasured;` | Med | dosing thresholds hard-coded at the call site instead of a named profile

Co-change pairs (hidden coupling, no import edge):
(none — no pair cleared the threshold)

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 `file:line` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.
</agent-prompt>