---
name: rpiv-revise
description: "Revise an approved brief, design, slice, or plan when feedback changes pending work, preserving intent IDs and prior evidence. Use for contract changes, reordering, splitting, merging, or deferring slices."
compatibility: opencode
metadata:
  source: rpiv
  generated: "true"
---

> OpenCode adapter: use lowercase native tool names. Treat `task` as the
> subagent dispatcher and `question` as the structured user-question tool. The text
> supplied after `User arguments:` by an `/rpiv:*` command is `$ARGUMENTS`.
> Resolve bundled scripts through `$RPIV_PLUGIN_ROOT` and project state through
> `$RPIV_PROJECT_DIR`.

# Revise

## Read First

READ `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` before revising or resuming. It owns brief/test-contract requirements, workspace preservation, candidate and contract identity, review dispatch, and gates. Use `$RPIV_PLUGIN_ROOT/skills/_shared/test-contract-authoring.md` when authoring or changing a behavior contract; do not copy its schema here.

Revise changes intent artifacts, not implementation or review reports. An approved short brief or slice is sufficient input; a full plan and prior chained design are not required.

## Input and Metadata

`$ARGUMENTS` supplies the target artifact and feedback. If given only a review, ask which intent artifact it should change and which findings apply. If either target or requested change is missing, ask for that information rather than requiring a new planning chain.

Run this command with the `bash` tool and use its output:

```sh
node "$RPIV_PLUGIN_ROOT/skills/_shared/skill-context.mjs" now
```

## 1. Reconcile the Current State

Read the target, its referenced normative sections, decisions, and evidence. On start and resume, verify every referenced document's `content_hash` with `node "$RPIV_PLUGIN_ROOT/skills/_shared/validate-artifact.mjs" <absolute-artifact-path> --root <repository-path>` without `--stamp`. Run the shared append-only check against the approved copy. A mismatch, a failed check, or a missing approved copy requires reconciliation before editing; do not silently replace the approved identity.

Separate accepted slices, the active candidate, pending slices, and deferred intent. Verify claimed completion from actual candidate and review evidence; old checkmarks are not proof. Preserve the original integration target and exact accepted predecessor relationships. Research only the code or decision uncertainty needed for this revision.

Completion criterion: the feedback is mapped to specific intent IDs and affected candidate/contract identities, with existing accepted history understood.

## 2. Agree the Revision

Present the smallest change that addresses the feedback and its effect on scope, dependencies, proof, and existing approvals. Confirm any choice the user's request has not already settled. Resolve active-slice behavioral questions before treating the new contract as executable.

Pending work may split, merge, or reorder while preserving intent IDs. Give newly separated execution slices distinct slice IDs and retain an explicit old-to-new mapping; renumbering display phases must not change identity. For a merge, retain every covered intent ID and its original evidence links. Explain changed dependencies and what becomes invalid rather than silently relabeling old evidence.

Place unresolved or later detail under `Deferred Work`, with its intent ID, reason, and trigger for refinement. Deferred Work is not a fake executable phase, a completed item, or an excuse to omit the active slice's contract. Keep the next real slice short and agreed; defer implementation detail until that slice is active.

Completion criterion: the human agrees the changed intent and the active slice has the shared behavioral contract, or the unresolved work is explicitly deferred and not executable.

## 3. Edit the Artifact

Make focused edits that preserve unaffected intent. Use behavior, boundaries, constraints, source references, and project-derived verification commands; plans contain no implementation fences. Keep automated checks distinct from manual acceptance criteria.

Treat old shipped fence-based plans as historical proposals, not code truth. Preserve their historical record and retire superseded normative sections explicitly. Derive replacement contracts from approved intent, user-visible behavior, and current public seams, not from copying proposed implementation. Read the shared test-contract authoring standard for the replacement contract.

Preserve prior approvals, review records, and `## TDD Evidence (implement)` verbatim. Append a timestamped Follow-up recording the change, intent/slice mapping, prior and new contract identities, affected dependencies, and invalidated approvals. Never fabricate, rewrite, or reassign old evidence to a new contract. Missing historical red stays an unproven gap; being implemented pre-TDD is not a TDD exemption.

If accepted behavior must change, create explicit new pending work linked to the accepted revision rather than rewriting what was accepted. An active candidate affected by this revision needs renewed tests and the reviews and acceptance its lane requires under the shared loop (shared **Lanes**). Scope reduction or deferral requires explicit agreement; it cannot silently make the whole scope complete.

Update `last_updated`, `last_updated_by`, and a concise `last_updated_note` where frontmatter is used. Preserve `in-progress`, `in-review`, `ready` as document statuses, distinct from candidate acceptance. Reopen changed normative content for review; do not preserve a stale ready/approved claim.

## 4. Review and Resume

Where the slice's lane requires intent review (shared **Lanes**), dispatch independent read-only intent review with `mode=intent` and the exact input fields in the shared workflow. Freeze and verify the revised contract identity: the revised document's body hash and the referenced document hashes. Resolve findings and repeat review after edits. Capture human approval of the exact revised contract, not merely permission to edit the document, and save its approved copy per the shared workflow.

Before finalizing a revised artifact, use `node "$RPIV_PLUGIN_ROOT/skills/_shared/validate-artifact.mjs" <absolute-artifact-path> --root <repository-path> --finalizing --stamp` after reconciling the old identity and preserving history. Verify the new `content_hash` without `--stamp`. This document hash is not a candidate approval and does not replace the human approval of the revised contract.

Report the artifact path, changed intent IDs, active slice, deferred work, invalidated proof, and approval state. Resume only the authorized active slice through the shared loop after contract approval; then require observed expected red, minimal green, separate independent review/refactor, and the human acceptance its lane requires. The next slice, integration consent, and final combined validation remain separate checkpoints.

