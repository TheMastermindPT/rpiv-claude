---
name: blueprint
description: Shape a lean brief and, only with explicit bounded build and workspace approval, develop real candidate slices with test-first evidence and independent review. Use for combined design and candidate iteration from a request, brief, research, or solutions artifact. A plan-only or legacy blueprint planning request stays document-only until the user asks to build.
argument-hint: "[request or brief/research/solutions path; optional bounded build request]"
shell-timeout: 10
---

# Blueprint

Blueprint connects architectural intent to real, reviewable candidate slices. The brief holds contracts and decisions; source lives in an approved candidate worktree, never duplicated in document code fences.

## Required Contract

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before proceeding. Apply its **Intent And Brief**, **Workspace And Authority**, **Candidate Identity**, **Slice Loop**, **Integration**, and **States And Evidence** directly; they are the common workflow, not optional advice.

Use **Slice Loop** for authorized builds. `/rpiv:implement` is user-invoked; blueprint must not silently invoke it to perform this loop.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git recent .rpiv/artifacts/research 4 recent .rpiv/artifacts/solutions 4
```

Copy values verbatim, including timestamp offsets. Use the returned slug for `.rpiv/artifacts/plans/<slug>_<topic>.md` when a new brief is needed.

## 1. Establish Intent And Authority

1. Read the request and supplied brief, research, or solutions artifact. Direct user intent is valid input; do not force a research/design/plan chain.
2. Read repository guidance, applicable decisions, and source at the relevant public seam, callers, and integration points. Verify upstream hashes and source facts before inheriting decisions.
3. Research meaningful gaps that affect the next slice. Reuse valid findings; dispatch targeted research agents only for questions that benefit from independent investigation.
4. Classify the request: planning only, or an explicit bounded build request. An old-style "blueprint this" or "make a plan" invocation remains document-only. Intent approval is not permission to write source.
5. Record the requested bound and outstanding permissions. Apply **Workspace And Authority** before any candidate source writes; absent authority means continue with documents or ask, not assume.

Done when the desired outcome and the allowed kind of work are explicit.

## 2. Stabilize The Next-Slice Brief

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/dimension-sweep-and-checkpoint.md` and apply it to the next slice. Resolve material ambiguities now; record distant unknowns with triggers in Deferred Work instead of deciding the entire feature in advance.

Use the existing authoritative brief when suitable. Otherwise create the plan-path brief with `status: in-progress`, metadata fields `date`, `author`, `commit`, `branch`, `repository`, `topic`, `tags`, `last_updated`, and `last_updated_by`. Set `parent` only to an actual upstream artifact; omit it for direct input.

| Section | Content |
|---|---|
| Intent | Outcome, non-goals, constraints, and references to authoritative requirements. |
| Architecture | Boundaries, ownership, integration, important interface shapes, and source evidence. |
| Decisions | Settled choices, inherited commitment references, rationale, and explicitly reopened commitments. |
| Next Slice | Stable `slice_id`, behavior IDs, bounded deliverable, affected source/test paths, and canonical contract references. |
| Test Contracts | Only contracts this brief owns; reference existing ones by file + section + exact content hash. |
| Deferred Work | Future outcomes, dependencies, unknowns, and triggers; no placeholder Phase headings. |
| Developer Context | Decision rationale and stable evidence locations for intent/build/workspace approvals, reviews, acceptance, and integration. |
| References | Verified upstream artifacts, source anchors, and documentation links. |

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-contract-authoring.md` before authoring contracts. Follow **Intent And Brief**: preserve stable behavior IDs, the public seam, exact oracle, expected red, exclusions, constraints, and observable automated/manual criteria. Keep each contract authoritative once; the brief links to existing contracts rather than copying them.

Only the next executable slice needs a complete contract. Expected red is an intent prediction until a real test run proves it. Keep implementation and test bodies in source, not the brief.

If the user wants a scheduling projection, use active `## Phase N:` sections with `### Overview`, `### Changes Required:`, `### Test Contract:`, and `### Success Criteria:` references, not code replicas. Splitting, merging, and reordering must preserve behavior IDs and explicitly reopen changed commitments.

Set `phase_count` to executable Phase headings and `unresolved_phase_count` to those missing complete, build-approved contracts. Recompute when approval or scope changes. These are orchestrator-maintained workflow counts, not a store-enforced execution gate. Deferred Work stays outside both counts and Phase headings; moving an active commitment there requires scope agreement. Without executable headings both counts are zero, not evidence of completed work.

Done when the user confirms next-slice intent and the authoritative contract is ready for independent review.

## 3. Review Intent Before Building

Stabilize and pin the brief and referenced contracts through **Candidate Identity**; persist evidence separately. Set `status: in-review`.

1. Dispatch `slice-verifier` with `mode=intent`, exact `artifact_path` identity, and `slice_id`.
2. Dispatch independent `artifact-code-reviewer` and `artifact-coverage-reviewer` agents in parallel on the same stabilized intent. Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/artifact-review-dispatch.md` for dispatch and evidence persistence.
3. Present verified findings; fix gaps or explicitly reopen the affected commitment with the user. Re-record the body hash and rerun affected reviews whenever reviewed intent changes.
4. Apply **States And Evidence**. Unavailable or broken review is not an empty clean result; failed gates remain failed. A filled `resolution` cell cannot replace missing evidence or waive a blocker.

For a planning-only request, finalize the reviewed document in Step 6 and stop. Report build approval still pending; do not create a worktree or write source.

For an explicit build request, continue only after required intent gates pass and the bounded contract is approved for build.

## 4. Approve The Candidate Workspace

Apply **Workspace And Authority** with the user: dedicated branch, linked worktree path, agreed base, and bounded write/test authority. Keep existing dirty state where it is unless transfer of specified changes is explicitly approved.

Derive permissions for secrets, network, and external effects from actual consent; a worktree or build approval supplies none implicitly. If workspace setup or required tooling fails, record the distinct diagnostic and pause that operation.

Bind the candidate using **Candidate Identity**: `artifact_path` at the exact contract content hash including referenced documents, `slice_id`, candidate-worktree `repository_path`, exact predecessor `base_commit`, `candidate_revision`, and `evidence_paths`. Keep the original integration-target base separate from later accepted predecessors.

Use a commit SHA plus clean state, or an immutable patch with the complete included-file digest manifest covering new files, modes, and deletions. Never identify a mutable working directory or moving branch name as the reviewed revision. The shared snapshot path supports durable predecessors without committing; request commit permission only if choosing the commit path, never manufacture it to satisfy identity.

Done when workspace authority and the exact candidate inputs are recorded, with no implied dirty-state transfer or external permissions.

## 5. Run The Shared Slice Loop

Execute **Slice Loop** directly for the one authorized slice: real behavioral red, minimal green in source, then the separate independent review/refactor gate. Record command results and runtime/manual proof against the pinned contract and candidate revision.

Once code exists, dispatch `slice-verifier` with `mode=candidate` and the independent reviewer pair against that exact candidate identity and complete included diff. Intent review cannot substitute for candidate review. Refactor or fixes change the revision and require the affected checks and reviews again.

Present the observable outcome, evidence, findings, and exact revision for user acceptance. Checks passing is not acceptance. Accept only the reviewed revision, and invalidate acceptance if its content or contract changes.

For another slice, re-ground on the accepted predecessor, elaborate its contract just in time, and repeat the approval and review gates. Pin the predecessor commit or frozen predecessor snapshot plus its underlying `base_commit` using **Candidate Identity**, not the original target base or a moving HEAD. If that predecessor cannot yet be pinned, pause chaining rather than implicitly committing or transferring changes.

Stop at the authorized bound. Integration is a separate decision: apply **Integration** only with explicit merge consent, validate the current target and full combined diff, and rerun invalidated proof after target drift or conflict resolution. Never commit, push, or merge automatically.

## 6. Finalize And Report

1. Check canonical references, review/evidence identity, and executable/unresolved counts. Keep candidate acceptance and integration records separate from document readiness.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/decision-ledger.md` for opt-in promotion of decisions tagged `scope: standing`, `key`, and `rule`, within authorized scope. Shared TDD requirements and feature-local decisions are not automatic promotions.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <brief-path> --finalizing --stamp`; fix reported faults and rerun. Retain the stamped `content_hash`; re-record the body hash and re-review if finalization changes reviewed intent.
4. Flip `status: in-review` to `status: ready` only when required intent gates and finalization lint pass. `ready` does not authorize source writes, mark a candidate accepted, or imply integration.
5. Report the brief path, current authority, exact candidate/evidence pointers when present, unresolved gates, and Deferred Work. Completing the active slices is not whole-feature completion while deferred scope remains.

## Follow-Ups

Verify claimed upstream staleness against hashes and source before requesting new research. Reopen only affected commitments with the user, update their authoritative owner, invalidate dependent reviews/acceptance, and repeat the relevant gates. Update `last_updated`, `last_updated_by`, and `last_updated_note`; never change an oracle merely to excuse a failing candidate.
