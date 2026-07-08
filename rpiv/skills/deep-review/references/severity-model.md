<!-- Read by code-review SKILL.md at Step 5 start; §Verification tag semantics & application also governs Step 6. Content moved verbatim from SKILL.md — apply as written, do not reword. -->

# Severity & verification model

## Evidence classification per lens (Step 5.1)

   - **Quality** — 🔴 traced flow contradiction (dropped error path, missing validation on a sink, null-deref); 🟡 blast-radius × complexity-delta (hot path + new allocation, ABI change without migration); 🔵 pattern divergence with nearby template; 💭 composite-lesson architecture concern.
   - **Security** — 🔴 concrete user-reachable source→sink trace via Discovery Map auth-boundary (reject hits without explicit trace); 🟡 concrete crypto issue (weak hash in auth/integrity role, non-constant-time compare, hardcoded key material); 🔵 divergence from a secure example in the same file; 💭 architectural question.
   - **Dependencies** — 🔴 Critical/High CVE in touched dep OR lockstep-contract violation; 🟡 Moderate CVE, outdated major with migration path, license incompatibility; 🔵 minor/transitive drift; 💭 architectural dep question.
   - **Interaction-sweep** — 🔴/🟡 only (no 💭): 🔴 concrete emergent failure across ≥2 files/components; 🟡 multi-component mismatch with bounded blast radius or existing mitigation. **Promotion rule**: when ≥2 lens findings share the same entity/flow and combine into an emergent failure, the aggregate is 🔴 even if each constituent was 🟡/🔵. The interaction IS the defect — don't leave constituents at their original severity and skip the cross-finding bullet.
   - **Gap-finder** — 🟡 uncovered risk-bearing region in a changed file with no lens coverage; 🔵 low-impact gap (style-only or defensive-only region missed). No 🔴 (gap findings are uncertain by nature).
   - **Peer-mirror** — treat every Missing/Diverged row as a finding. Base severity 🔵. **Bump to 🟡** when the missing invariant is a domain-event emission, a precondition guard on a state-mutating method, or a persisted-field invariant. **Bump to 🔴** when the missing invariant intersects a dispatch site the diff touches (switch/map/table/registry enumerating the peer's type alongside the new type — detectable from integration-scanner's `Wiring/config` output and the Discovery Map's `[config]`/`[hub]` files). Rationale: a missing mirror on a dispatched invariant is a silent-stranded-state cascade constituent; on a non-dispatched invariant it is a style issue. Record every peer-mirror bump in `## Reconciliation Notes`.
   - **Precedents** → compile into `## Precedents` (table: `hash | subject | 30d-follow-ups | note`), composite lessons below. **Severity weighting**: for each current finding, count precedent commits touching the same symbol/file that had ≥1 follow-up fix within 30 days. If count ≥ 2, bump the finding one severity tier (🔵→🟡, 🟡→🔴); cap at 🔴. Record the bump by annotating the finding's title line `[precedent-weighted]` — do NOT emit a separate reconciliation section.
   - **CodeScene business case** (tool-gated, when the `codescene_code_health_refactoring_business_case` tool is available AND the Discovery Map has per-file CodeScene scores): for each 🔴 finding whose cited file has a Discovery Map score < 9.0, run `codescene_code_health_refactoring_business_case` on that file. The tool returns optimistic/pessimistic ROI estimates (% development speed improvement, % defect reduction). Annotate the finding's title line `[roi: +{X}% velocity, −{Y}% defects]` and cite the estimates in the artifact's `## Recommendation` table. This does NOT bump severity — ROI is corroboration, not a tier change — but it transforms "fix before merge" from a hand-wavy opinion into a data-driven argument. If the tool is unavailable, skip silently — no degradation.

## Cascade detection (Step 5.5)

   - **Cascade detection** (load-bearing): before emitting severities, scan findings for these triples and emit a 🔴 Cross-Finding bullet if any fires —
       • *{entity reaches state X} + {no event on that transition} + {consumer filter excludes X}* = **silent stranded state**
       • *{check-then-act on shared resource} + {no ordering primitive} + {retry/replay path}* = **duplicate-processing cascade**
       • *{spec A accepts Y} + {spec B rejects Y} + {workflow depends on both}* = **contradictory-predicate deadlock**
     Also check `.rpiv/artifacts/reviews/*.md` and Precedents: if a prior review names a cascade whose constituents appear in current findings, cite it and assert reproduction. Missed cascades are the biggest historical quality regression; prefer false positives here.

## Verification tag semantics & application (Step 6)

**Before applying tags** — re-read every Weakened and Falsified justification (the tag is a summary; the justification is the evidence). Per `agents/claim-verifier.md` tag semantics: Weakened = narrower, Falsified = wrong direction, Verified = correct or understated. If a justification contradicts its tag (e.g. "inverted" / "opposite" under Weakened, or "worse than stated" under Weakened), override before applying the rules below. Also verify identity on the ID set — exactly one row per input finding; re-dispatch `claim-verifier` on any missing IDs before proceeding.

**Apply the tags** (on the corrected tag):
- **Falsified** findings — remove from the artifact entirely. Their ID is retired (never reused); the retirement is counted in the frontmatter `verification` string (`F` dropped) and nowhere else.
- **Weakened** findings — demote one severity tier (🔴→🟡, 🟡→🔵, 🔵→💭). Rewrite the finding's evidence line to reflect the narrower claim.
- **Verified** findings — carry through unchanged to Step 7.
- **Edge case**: if a 🔴 Cross-Finding Interaction bullet relies on constituents that are now Falsified or Weakened, re-evaluate the interaction. Drop the interaction if it no longer stands on ≥2 Verified constituents from different files.
