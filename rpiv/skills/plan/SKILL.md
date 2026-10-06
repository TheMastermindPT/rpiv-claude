---
name: plan
description: Project existing behavioral contracts into a lean dependency and scheduling plan. Use to sequence a brief or design, or split, merge, and reorder proposed slices while preserving commitments. Planning is optional and document-only; contracts remain at their canonical owners and future work is refined just in time.
argument-hint: "[brief/design path or scheduling request with contract references]"
shell-timeout: 10
---

# Plan

A plan is an optional scheduling projection, not a second specification or a source-code container. It links to canonical contracts and makes the next executable slice clear.

## Required Contract

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before proceeding. Apply **Intent And Brief**, **Candidate Identity**, and **States And Evidence**; **Workspace And Authority** and **Integration** separate later build and merge consent from planning approval.

This skill writes documents only. It never edits source; its `**Next step:**` names `/rpiv:implement`, which agrees the build with the developer before any source edit.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git
```

Copy metadata values verbatim, including the timestamp offset. Write `.rpiv/artifacts/plans/<slug>_<topic>.md` using the returned slug.

## 1. Read Authoritative Intent

1. Read the brief or design and its canonical contract references. A direct scheduling request may identify existing contracts without a design artifact; do not invent an upstream parent.
2. If the intended outcome or contract owner is missing, ask for it. Do not require a full research/design pipeline merely to obtain the missing intent.
3. Read applicable repository guidance and source at dependency boundaries. Verify the upstream hashes and facts the proposed ordering relies on.
4. Preserve valid decisions. When source evidence demonstrates staleness or a contradiction, identify the affected commitment and ask to reopen it at its owner; do not silently repair it in the plan.
5. Resolve a concrete research gap when it affects ordering, atomicity, or verification. Use targeted help when useful rather than launching a default research sweep.

Done when behavior IDs, contract owners, and the next slice's actual prerequisites are known. Distant implementation questions may remain deferred.

## 2. Project Dependencies

- Sequence vertical outcomes that can be tested through the agreed seam. A types-only foundation is not an automatic first phase.
- Split, merge, or reorder slices when that improves atomicity or scheduling. Preserve behavior IDs and every oracle, exclusion, and constraint at the canonical owner.
- Record old-to-new slice mappings and rationale. Explicitly reopen affected commitments before changing their meaning, test seam, oracle, or approved scope; invalidate affected approvals and reviews.
- Keep the full contract only for the next executable slice. Place speculative later outcomes and their decision triggers in `## Deferred Work` rather than placeholder Phase sections.
- Mark work parallel only when its prerequisites and verification are independent. Scheduling grants no authority to create worktrees or transfer dirty state.

Present the proposed next slice, dependency changes, and deferred scope for confirmation. Approval of ordering is not build authorization.

Done when the next phase can stand alone on its declared predecessor, without depending on uncommitted or imagined future changes.

## 3. Write The Projection

Create `status: in-progress` frontmatter with `date`, `author`, `commit`, `branch`, `repository`, `topic`, `tags`, `last_updated`, and `last_updated_by`. Add `parent` only for a real upstream artifact. Include `phase_count` and `unresolved_phase_count` with the semantics below.

| Section | Content |
|---|---|
| Overview | Scheduling purpose, scope, and authoritative brief pointer, not copied requirements. |
| Ordering Constraints | Dependencies, scheduling rationale, and changed slice mappings. |
| Phase N: Name | Only an active executable slice, using the structure below. |
| Deferred Work | Unscheduled outcomes, dependencies, open questions, and triggers for elaboration. |
| Verification Notes | Cross-slice risks and integration checks, referencing canonical criteria. |
| Developer Context | Scheduling rationale and stable evidence locations for ordering approvals, reopened commitments, and authority. |
| References | Actual upstream artifacts and source evidence. |

For each active `## Phase N: <name>`, include:

- `slice_id` and stable behavior IDs; phase numbering is presentation, not behavior identity.
- `### Overview`: bounded outcome and dependencies; distinguish a prospective predecessor from a resolved candidate `base_commit`.
- `### Changes Required:`: affected source and test paths with concise change intent, not implementation bodies.
- `### Test Contract:`: canonical file + section + exact content hash references. Read and validate the referenced content; never copy or re-author its Behavior/Oracle/Expected-red entries here.
- `### Success Criteria:`: exact references to canonical automated/manual criteria, plus scheduling-specific integration requirements owned here. Preserve meaningful criteria; do not replace them with a generic green-check claim.
- Build-approval state and evidence pointers using **Candidate Identity** and **States And Evidence**. Leave absent candidate evidence visibly absent.

If a referenced contract is incomplete, read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-contract-authoring.md` to identify the gap and route it to the owner. A complete contract has the shared behavior/seam/oracle/expected-red structure and justified exemptions; a heading or link alone is not completeness.

### Phase Counts

`phase_count` equals the number of executable `## Phase N:` headings. `unresolved_phase_count` equals the number of those phases missing a complete, build-approved contract, including phases reopened since approval. Recompute both from records; never decrement merely because prose was generated or checks passed.

These are orchestrator-maintained workflow counts, not a store-enforced execution gate. Keep the deferred roadmap outside these counts and outside Phase headings so unfinished future work is not disguised as executable work. Conversely, do not hide an unresolved active commitment in Deferred Work to bypass its gate; changing scope needs explicit agreement.

A planning-only request can leave build approval pending. Report that honestly; plan review does not create approval or bypass the execution gate. Finishing all active phases does not mean the deferred feature scope is complete.

## 4. Review The Projection

Stabilize the plan, authoritative brief, and referenced contracts and record their hashes through **Candidate Identity**; later evidence appends are governed by the append-only check. Set `status: in-review`.

Plan reads the lane from the brief or design frontmatter (`normal` when absent). Intent review runs only in the rigorous lane (**Lanes** table), the lane plan exists for. In fast and normal, skip steps 1–2 and ask the user to confirm the projection; steps 3–4 still apply.

1. Dispatch `slice-verifier` with `mode=intent`, the exact `artifact_path` identity, and each active `slice_id`. Review the projection against the canonical commitments and predecessor constraints.
2. Dispatch independent `artifact-code-reviewer` and `artifact-coverage-reviewer` agents in parallel on the same stabilized intent. Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/artifact-review-dispatch.md` for dispatch and persistence.
3. Present verified findings for user triage. Fix scheduling faults here; change a contract only at its owner after explicitly reopening it. Re-record the body hash and rerun affected reviews after changes.
4. Preserve distinct unavailable, broken, failed, and passed states. Filling a `resolution` cell does not waive missing review or a failed gate; apply **States And Evidence** before finalization.

Done when required intent reviews pass on the current projection and authoritative references. This is not candidate-mode review or acceptance of code.

## 5. Finalize And Hand Off

1. Verify links and hashes, behavior-ID coverage, dependency mappings, review evidence, and both phase counts.
2. Preserve standing-decision ownership upstream. If an explicitly reopened decision is opted into promotion, read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/decision-ledger.md`; promote at its owner only with `scope: standing`, `key`, and `rule`, within authorized scope. Do not duplicate or automatically promote inherited decisions.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <plan-path> --finalizing --stamp`. Fix faults and rerun; retain `content_hash` as the final body identity. A body change during finalization that the shared append-only check does not allow reopens approval. Re-record the body hash and re-review any changed intent.
4. Flip `status: in-review` to `status: ready` only after required intent gates and finalization lint pass. Readiness describes reviewed planning intent; build approval and execution gates remain separate.
5. Present the path, next slice, executable/unresolved counts, review outcome, and deferred scope. Never imply automatic commits, pushes, or merges.

**Next step:** `/rpiv:implement <plan-path>` — build the next slice; implement agrees the workspace and build authorization first. Run `/clear` first, then this command, so the next stage starts in a fresh session; stop here instead if a developer decision or any other **Lanes** stop (a failed, broken, or missing gate) is pending.

## Follow-Ups

Update the projection in place for scheduling changes, keeping behavior IDs stable. Update `last_updated`, `last_updated_by`, and `last_updated_note`; reopen affected commitments and approval records, recompute counts, and repeat review/finalization.

Verify upstream staleness before replacing references. A new canonical hash invalidates dependent evidence until reviewed. Use `/rpiv:revise` for surgical plan changes when requested; a plan is never permission to weaken TDD or rewrite an oracle to fit a candidate.
