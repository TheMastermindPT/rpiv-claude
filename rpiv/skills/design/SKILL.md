---
name: design
description: Shape architectural intent and the next slice's behavioral contract in a lean design brief. Use for architecture, boundaries, or feature decomposition from a user request, brief, research, or solutions artifact. Produces documents only; use plan for scheduling existing contracts and implement to build an agreed slice.
argument-hint: "[request or brief/research/solutions path]"
shell-timeout: 10
---

# Design

Design records what must hold and where responsibilities belong. Implementation belongs in source, not in an architectural document.

## Required Contract

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before proceeding. Its **Intent And Brief**, **Candidate Identity**, and **States And Evidence** sections govern this skill; its workspace, build, acceptance, and integration rules govern any later execution.

Design is document-only. Approval here approves architectural intent, not source writes, candidate acceptance, or integration.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git recent .rpiv/artifacts/research 4 recent .rpiv/artifacts/solutions 4
```

Copy metadata values verbatim, including the timestamp offset. Use the returned slug for `.rpiv/artifacts/designs/<slug>_<topic>.md`.

## 1. Ground The Request

1. Read the supplied request and documents. Accept a brief, user request, research, or solutions artifact directly; no mandatory research-to-design pipeline.
2. If intent is missing, ask what outcome the user wants. Recent artifacts are selection aids, not automatic parents or prerequisites.
3. Read repository guidance, applicable standing decisions, and the actual source at the proposed boundary and public test seam. Check relevant callers and integration points, not just the named file.
4. Verify upstream content hashes and cited source facts before inheriting commitments. A changed timestamp or branch alone is not proof of staleness. Record the conflicting evidence and reopen only affected commitments with the user.
5. Reuse valid upstream findings. Research a concrete gap in behavior, wiring, precedent, or a novel API before deciding; use targeted agents only when independent questions justify them. Verify their findings against source.

Done when the next architectural choice is grounded in evidence and remaining unknowns are classified by whether they block it.

## 2. Resolve The Next Decision

Read and apply `${CLAUDE_PLUGIN_ROOT}/skills/_shared/dimension-sweep-and-checkpoint.md` to the current boundary and next slice.

- Record settled constraints with evidence; retain inherited user decisions without asking again.
- Ask grounded questions about material ambiguities that affect the next slice. Record the answer and its consequences in Developer Context and Decisions.
- Put distant questions in Deferred Work with their decision trigger. They need not be settled to review today's intent.
- Confirm the architectural approach, exclusions, public seam, and next behavior with the user before stabilizing the brief.

Done when the next slice has no unresolved material ambiguity; the rest is an honest roadmap rather than invented certainty.

## 3. Write The Lean Brief

Create the artifact with `status: in-progress`. Include `date`, `author`, `commit`, `branch`, `repository`, `topic`, `tags`, `last_updated`, and `last_updated_by`. Set `parent` only to an actual upstream artifact; omit it for direct user input. List other sources in References.

Use these sections, keeping each fact in one authoritative place:

| Section | Content |
|---|---|
| Intent | User outcome, scope, non-goals, constraints, and links to existing authoritative requirements. |
| Architecture | Ownership, boundaries, data flow, integration points, important signatures or schema shapes, and rationale with source evidence. |
| Decisions | Settled choices, rejected alternatives when material, inherited commitment references, and explicitly reopened decisions. |
| Next Slice | Stable `slice_id`, behavior IDs, deliverable, affected source/test paths, dependencies, and canonical contract references. |
| Test Contracts | Only contracts this artifact owns; otherwise file + section + exact content hash pointers to their owner. |
| Deferred Work | Later outcomes, dependencies, unknowns, and triggers for refining them; no executable phase headings. |
| Verification Notes | Relevant risks, source anchors, known baseline warnings, and evidence locations. |
| Developer Context | Decision rationale and stable evidence locations for approval/reopening records; intent approval is distinct from build authority. |
| References | Real upstream documents, tickets, and verified source or documentation links. |

Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/test-contract-authoring.md` before authoring a contract. Apply **Intent And Brief** for its canonical structure: stable behavior IDs, public seam, exact oracle, expected red, non-goals, constraints, and observable automated/manual verification. Preserve risk-bearing boundaries, invariants, and error paths; a non-behavioral exemption needs an explicit reason.

Only the next executable slice needs a complete contract. An existing contract stays at its owner; the brief links to it rather than copying Behavior entries or verification criteria. Expected red is a prediction here, never evidence that a test ran.

Architecture may show an interface or data shape that resolves a decision. Keep implementation bodies, test implementations, and source-file replicas out of the document. File maps describe responsibilities, not code to transcribe.

Slice boundaries are proposals, not a permanent scheduling lock. Later splitting, merging, or reordering must preserve behavior IDs and explicitly reopen any changed commitment.

Done when a reviewer can judge the next slice without reconstructing intent from imagined code.

## 4. Review Intent

Stabilize the brief and record its body hash and the referenced contracts' hashes using **Candidate Identity**; later evidence appends are governed by the append-only check. Set `status: in-review`.

1. Dispatch `slice-verifier` with `mode=intent`, the exact `artifact_path` identity, and the next `slice_id`. It reviews commitments, seam/oracle sufficiency, dependencies, and verified upstream facts, not hypothetical implementation correctness.
2. Dispatch independent `artifact-code-reviewer` and `artifact-coverage-reviewer` agents in parallel on that same intent identity. Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/artifact-review-dispatch.md` for dispatch and evidence persistence.
3. Present verified findings to the user. Fix gaps or explicitly reopen the affected commitment; then re-record the body hash and rerun affected reviews. A changed contract cannot inherit approval for the old hash.
4. Apply **States And Evidence**: unavailable, broken, failed, and passed remain distinct. Missing review or a blocker cannot be waived by filling a `resolution` cell. Hold the gate until the required evidence supports it.

Done when the required intent reviews pass on the stabilized brief and the user confirms that intent; on that approval, save its approved copy per the shared workflow. Candidate-mode review belongs to the later real source revision.

## 5. Finalize And Present

1. Verify canonical references, intent review evidence, and next-slice completeness; keep deferred questions explicit.
2. For opt-in standing decisions, read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/decision-ledger.md` and apply its promotion protocol only to entries tagged `scope: standing`, `key`, and `rule`, within authorized write scope. Feature-local choices and the shared TDD requirement are not automatic promotions.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <design-path> --finalizing --stamp`. Fix reported faults and rerun; a broken gate is not a pass. Preserve the stamped `content_hash` as the final body identity. A body change during finalization that the shared append-only check does not allow reopens approval.
4. Flip `status: in-review` to `status: ready` only after the required gates pass. If finalization changed reviewed intent, re-record the body hash and re-review before the flip.
5. Present the path, architectural outcome, next-slice readiness, and deferred scope. `ready` means reviewed design intent, not permission to build or proof of feature completion.

**Next step:** `/rpiv:implement <design-path>` — build the agreed next slice; implement agrees the workspace and build authorization first. Run `/clear` first, then this command, so the next stage starts in a fresh session; stop here instead if a developer decision or any other **Lanes** stop (a failed, broken, or missing gate) is pending.

Scheduling through `/rpiv:plan` is optional, for a rigorous multi-slice change.

## Follow-Ups

Edit the authoritative decision or contract, not a downstream copy. Update `last_updated`, `last_updated_by`, and `last_updated_note`; return affected intent to `in-progress`, record reopened commitments, and invalidate affected approvals.

Verify claimed upstream staleness against hashes and source before requesting fresh research. Research only the demonstrated gap, then repeat the checkpoint, reviews, and finalization for the changed intent. Never rewrite a contract merely to match an implementation that violated it.
