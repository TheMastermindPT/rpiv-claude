---
name: rpiv-implement
description: "Execute approved slices, prove each behavior, review by lane, and stop for human acceptance per slice in the rigorous lane or once for the combined result in fast and normal."
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

# Implement

## Read First

READ `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` before execution or resume. It owns the agreed brief and test contract, lane workspace setup and dirty-state preservation, candidate and contract identity, reviewer dispatch, and acceptance/integration gates. Follow that loop directly; a missing or broken shared workflow blocks execution.

Another skill may start this skill as its next step (its `**Next step:**` line); this skill still agrees the brief, workspace, and build authorization with the developer before any source edit. Skills that supervise a candidate themselves use the shared loop directly.

## Input and Scope

`$ARGUMENTS` accepts an approved short brief, design, slice, or plan, with an optional phase or slice selector. A full plan and a prior chained design are not prerequisites. Ask for the intended input when it is absent or ambiguous; agree and record its short behavioral contract through the shared workflow before source edits.

A fast-lane research artifact (its `lane: fast`) arrives without a design. In the fast lane, write the slice's short brief with its contract (behaviors, seam, oracle, Expected red) as a design artifact under `.rpiv/artifacts/designs/` with `lane: fast` and the research as `parent`. In the fast lane, ask the developer to approve the behaviors and authorize the build in one question; save the approved copy on approval. That one question also covers creating the branch (name and starting commit); the approval hook still confirms the command itself. The rule that the human approves behavior before production code still holds.

A deep-review artifact (`.rpiv/artifacts/reviews/`) is a fix round on the reviewed branch. Its contract is the review's verified 🔴 and 🟡 findings (🔵 and 💭 only when the developer picks them); agree that list with the developer in one question before any edit. Each behavior-changing fix starts with its own expected red, then green. The round ends as one fix commit per round on the branch: it never amends a slice commit, and its message carries the trailer `Review: <review-path>` (the repo-relative `.rpiv/artifacts/reviews/<name>.md`), the one marker of a fix commit; a slice commit never carries it. The `Review:` line goes in the message's last paragraph, in the same block as any `Co-Authored-By:` line: git reads trailers only from that paragraph, so a `Review:` line in an earlier paragraph marks nothing. The next step runs deep-review again on the branch; deep-review allows 1 fix round before the developer decides. A deep-review artifact has no approved copy: the developer's one-question agreement on the findings list, recorded in the owning design's `## Developer Context`, is its approval; the approved-copy start check applies to the owning design, not to the review. In the rigorous lane, a fix commit voids the slice's acceptance: ask the human to accept the fixed revision again before validate.

A named phase limits the work; it does not waive the one-slice loop if it contains several slices. With no selector, agree the next pending real slice. Later detail stays under `Deferred Work` until its turn. Never interpret an omitted selector as authorization to execute the whole backlog.

Read the input, its referenced normative sections, relevant project guidance, and the current source. Historical implementation fences in shipped plans are historical proposals, not code truth. Resolve disagreements against approved intent and observed behavior; route changed intent or contracts through revise, not through silent implementation changes.

## 1. Verify and Prepare

On start and resume, verify managed RPIV artifacts' recorded `content_hash` with `node "$RPIV_PLUGIN_ROOT/skills/_shared/validate-artifact.mjs" <absolute-artifact-path> --root <repository-path>` without `--stamp`. Verify referenced plain documents by their hash and run the shared append-only check against the approved copy, without requiring artifact frontmatter on every referenced document. A failed check, a missing approved copy, or a mismatch needs reconciliation and renewed approval, not a silent re-stamp.

Reconcile the actual candidate, accepted predecessor, reviews, and evidence before selecting work. Existing checkmarks are claims to verify, not proof. Preserve the artifact status vocabulary `in-progress`, `in-review`, `ready`; document readiness is separate from slice acceptance and scope completion.

Use the shared workspace setup for the workspace the lane requires (shared **Lanes**), preserving unrelated dirty work. Record the original integration target separately from the accepted predecessor base. If setup or identity cannot be verified, stop before changing implementation files.

Completion criterion: one approved contract, one identified active slice with its lane, and a verified workspace for that lane. Missing behavioral proof requirements are a contract gap, not an implied TDD exemption.

## 2. Prove Each Behavior

Follow the shared test contract one behavior at a time. An observed failing test must match its **Expected red** reason before the behavior's implementation is edited. Use the agreed public seam and oracle; compile/import errors and unrelated failures do not qualify. If the expected failure cannot be demonstrated, stop and resolve the contract mismatch with the human.

Write the minimal implementation, run the focused test, and record green. Complete this red -> green pair before starting the next behavior. The slice ends as exactly one commit (shared **Lanes**); intermediate red and green states are logged, not committed. A documented non-behavioral exemption must satisfy the shared contract and actual project rules; existing implementation is not itself an exemption.

Keep detailed evidence in a separate append-only record linked from `## TDD Evidence (implement)` in the owning artifact. Identify the slice, contract identity, behavior, test name/path, commands, observed failure and success, and evidence paths. Existing inline evidence stays historical; never rewrite or duplicate it. Record exemptions and their approved reasons. Preserve the chronological link from red through implementation to green; never fabricate historical red.

Completion criterion: every in-scope behavior has its own observed expected red followed by green, or a valid recorded exemption. Green is the entry to review, not acceptance.

## 3. Separate Independent Review/Refactor Gate

After minimal green, enter the separate independent review/refactor gate in the shared workflow. Build its exact review input with `mode=candidate`; use its candidate revision and contract identity rules, not a branch label or an ad hoc tracked diff. After the deterministic checks, dispatch the reviewers the lane requires (shared **Lanes**) through `task` using the shared dispatch contract. Reviewers are read-only; your own inspection does not substitute for their review.

Apply project-defined gates and the shared **Available Quality Checks** for test-quality lint, CodeScene, and mutation. Discover actual commands, scope, thresholds, and tool guidance; preserve availability-based checks unless an explicit permitted exception is recorded. Record absent tools as `unavailable` and failed invocations as `broken` with diagnostics. A required gate stays blocking in either case; never silently waive it.

Address verified findings in small changes. Re-run the affected tests and independent reviews after any edit; any new behavior starts its own expected-red cycle. Re-freeze the revision and discard stale approval claims, while keeping their old evidence. If dispatch or a required review fails, stop rather than self-approve.

Completion criterion: the frozen current revision has passing required checks and fresh independent reviews with no unresolved blockers.

## 4. Human Checkpoint

Present the exact candidate revision, contract identity, changed scope, red/green evidence, review findings, gate outcomes, and remaining work. In the rigorous lane, ask the human to accept this revision, request changes, or pause; in fast and normal, keep this report for the combined acceptance. Passing tests and reviewer approval do not supply human acceptance.

In the rigorous lane, stop until the human accepts the exact candidate revision. Edits after that checkpoint invalidate acceptance for the changed revision and require new tests, reviews, and acceptance. Only then may an authorized next slice start from this accepted predecessor via the shared setup. In fast and normal, a slice whose gates pass becomes the predecessor for the next authorized slice without a stop, and the human accepts the combined result once before integration. Every lane still stops at the shared **Lanes** stops. A request for one slice ends here even when more work is pending.

Update only evidence-backed progress for this slice. Keep pending, deferred, and blocked scope visible; the active slice being done never marks the whole scope complete. When evidence or progress changes a document body, run the shared append-only check against the approved copy before finalizing its new `content_hash` with the artifact validator's `--finalizing --stamp`; retain the prior identity in the append-only audit trail. Contract edits belong to revise and require renewed approval.

## 5. Integration and Close

Slice acceptance is not integration permission. Request separate integration authorization for the exact accepted candidates and original target before any merge or equivalent integration action. Follow the shared integration gate, then require final combined integrated-tree validation against all accepted contracts, not merely the last slice's green checks.

Report the artifact path, active slice and exact revision, evidence/review results, human acceptance, integration authorization and validation state, and remaining scope. If paused or blocked, name the missing evidence or decision. Offer revise for intent changes and a handoff for session pauses; neither passing checks nor a closing message authorizes commits, more slices, or integration.

**Next step:** `/rpiv:deep-review <candidate-branch-or-range> lane=<lane> design=<design-path>` — Deep-review and validate run once over the whole feature's range after its last authorized slice (rigorous: after that slice's human acceptance). Pass the slice's lane and its approved design. Run `/clear` first, then this command, so the next stage starts in a fresh session; stop here instead if a developer decision or any other **Lanes** stop (a failed, broken, or missing gate) is pending.

