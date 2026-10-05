# Candidate Workflow

Read this before shaping, executing, reviewing, revising, or validating a slice.
This file owns the workflow contract; callers select steps, not weaker gates.
Repository guidance and tool permissions still apply. This is an agent protocol,
not an execution sandbox or a mechanically enforced approval service.

## Intent And Brief

Keep one short authoritative brief for the intended outcome, concrete scenarios,
non-goals, constraints, decisions, and verification obligations. A design is an
optional deeper explanation; a plan is an optional scheduling view. Neither is
a second source tree. Implementation bodies live only in repository files.
Use a short signature or consumer example only when it explains a decision.

Give behaviors stable IDs. Read `test-contract-authoring.md` in this directory
before authoring their public seam, exact oracle, and Expected red reason.
The human approves intended behavior before production implementation begins.
Expected outcomes come from that agreement, not from the candidate's output.

A contract has one authoritative location. Plans reference its path, section,
behavior IDs, and content hash; reviewers resolve those links before reviewing.
The contract identity is the `content_hash` of the whole document body, as
`validate-artifact.mjs` computes it, plus the hash of every referenced contract
or decision on which the slice depends; a document without `content_hash` is
identified by the sha256 of its bytes. There is no hash per section.

Whoever records an approval stamps the approved text with
`validate-artifact.mjs --finalizing --stamp` before saving the exact file as the
approved copy, `.rpiv/evidence/<artifact-stem>/approved-<content_hash>.md`, so
its `content_hash` equals the hash in its name; the approval names that hash.
The latest approved copy of a document governs; earlier copies stay history.
A later version keeps the approval only when
`git diff --no-index --ignore-cr-at-eol <approved copy> <artifact>`
shows nothing but added lines inside `## Developer Context`,
`## TDD Evidence (implement)` or `## Follow-up`, plus changed `status`,
`last_updated`, `last_updated_by`, `last_updated_note` and `content_hash`
frontmatter lines: this is the append-only check.
Any other change reopens approval. A missing approved copy fails the check; it
never passes by default. Exit 0 or 1 is a result; any other exit or an error
message is a broken check, never a pass.
An artifact's `content_hash` alone is not proof of code identity or of unchanged
external references. Verify both when resuming or dispatching a reviewer.

Fully detail only the next executable slice. Keep later goals, dependencies,
risks, and the question that unlocks each under `## Deferred Work`, outside
executable Phase headings. Deferred does not mean completed or exempt.
Resolve cross-cutting interfaces and irreversible choices before work relying
on them; local implementation detail can be learned during the slice.

When a plan uses counters, `phase_count` counts executable `## Phase N` headings;
`unresolved_phase_count` counts those without a complete build-approved contract.
These counters do not measure implementation, review, acceptance, or deferred
scope. `ready` means the stated intent passed its document gates, not that every
future goal is executable. A next-slice approval never authorizes deferred work.

## Workspace And Authority

Keep these three decisions separate and record their exact scope:

- **Build authorization:** permission to implement a specified contract in a
  named workspace, with bounded commands, effects, and continuation scope.
- **Candidate acceptance:** the human accepts the exact reviewed result as a
  predecessor for later slices. Passing tests is not this decision.
- **Integration authorization:** explicit permission to integrate a specified
  accepted candidate into a named target. Candidate acceptance alone grants none.

Planning-only requests stay document-only. In particular, an invocation of
`blueprint` is not itself permission to write application code. Ask when build
authority is missing; offer to stop with the brief rather than manufacture it.

For candidate work, use the workspace the slice's lane requires (**Lanes**).
Before creating a branch or worktree, inspect repository root, current branch, status including untracked
files, existing worktrees, and the intended integration target. Agree the new
path, branch, and exact starting commit. Verify its parent directory exists and
the destination is unused. A user may explicitly select another workspace;
record that choice and retain the same ownership and review rules.

Uncommitted work is not part of a new worktree's starting commit. Never silently
stash, copy, discard, reset, or commit another person's changes to make setup
work. If the slice requires them, ask for an explicit transfer or checkpoint
decision. Otherwise leave them untouched. Protect unrelated untracked files too.

A worktree is **not a command sandbox**. Git shares repository metadata and refs;
commands retain host filesystem, credential, network, and database access.
Use isolated test data, appropriate ports, and explicitly permitted effects.
Do not run destructive migrations, deploy, or access real services merely because
the code is isolated. A clone does not solve process-level permissions either.
Commit, push, merge, cherry-pick, and cleanup only when explicitly authorized.

## Lanes

Every slice runs in one lane: `fast`, `normal` or `rigorous`. The active-slice
brief records it as a `Lane:` line taken from `lane.mjs --paths` when the brief
is written. Before candidate review, `lane.mjs --range <base>..<candidate>`
re-checks it on the real diff; a re-check only raises the lane. A missing
`Lane:` line or a broken lane call means `normal`, never `fast`.

| Step | fast | normal | rigorous |
| --- | --- | --- | --- |
| Workspace | branch in the main working tree | linked worktree | linked worktree |
| Intent review | no | no | yes |
| slice-verifier | yes | yes | yes |
| Code/coverage reviewer pair | no | no | yes |
| Per-slice human acceptance | no | no | yes |

A fast slice falls back to a linked worktree when the main working tree has
uncommitted changes unrelated to the slice; never stash, move, or commit them.
Run the deterministic checks (tests, types, lint, and CodeScene where available)
before dispatching any review agent.

A fix round is one review of the candidate followed by its fixes, in any lane.
After 2 fix rounds, stop and ask the developer with `question`,
presenting the open findings and the choices; never start a third round unasked.
The cap never turns unresolved findings or an incomplete inspection into
acceptance.

Each slice ends as exactly one commit on the feature branch. Observe and log
each red and green, but do not commit intermediate states. Commit once the
slice is green; review fixes amend that commit while it is unpushed, which gives
a new candidate identity whose checks and reviews re-run. Never amend a pushed
commit. The commit message carries the red and green evidence summary.

## Candidate Identity

Each review receives the same packet, containing references rather than copied
source. Reuse this schema in `artifact-review-dispatch.md` and the three agents:

- `mode`: `intent` or `candidate`.
- `workflow_path`: parent-resolved absolute path to this shared workflow in the
  installed plugin. Supply it to every reviewer; an agent prompt does not
  establish its own filesystem location.
- `artifact_path`: authoritative brief/plan, resolved contract hashes, and the
  approved copy path.
- `slice_id`: stable slice ID, or the explicitly scoped brief for intent review.
- `repository_path`: the actual repository/worktree being inspected.
- `base_commit`: exact predecessor commit; retain the original integration
  target and starting SHA separately, not as a moving branch alias.
- `candidate_revision`: immutable commit plus clean candidate state, or a
  frozen snapshot as described below. Omit only in intent mode.
- `evidence_paths`: observed commands/results, previous acceptance records,
  and review reports. Include the source revision to which each result belongs.

If commits are authorized, pin a commit SHA and verify candidate files match it.
Otherwise capture a frozen snapshot: base SHA, complete binary-capable patch,
and a sorted manifest of every included path with content digest, mode, symlink
target where relevant, and addition/deletion status. Include staged, unstaged,
and untracked candidate files; record and preserve deliberate exclusions.
Store new-file contents with the snapshot, not only their names. A tracked-only
`git diff`, branch name, or timestamp is not an identity. Never stage changes
just to obtain a snapshot without permission.

Freeze writes while reviewers read. Compare the manifest/commit and contract
hashes before and after review and again before acceptance. A mismatch makes
the review stale, unless the candidate identity is unchanged and both the
reviewed and the current contract version pass the append-only check against
the same approved copy.
If a complete identity cannot be captured or reproduced,
block candidate review rather than report an approximate result as approved.

For a subsequent slice, its base is the exact accepted predecessor. If that
predecessor is an uncommitted snapshot, record its digest in addition to the
underlying `base_commit`, retain the frozen contents, and supply the incremental
diff plus full candidate snapshot. A new worktree cannot inherit those edits by
branch name. Preserve the chain so final validation can inspect the whole change.

## Slice Loop

1. Read current source, applicable guidance, approved intent, and predecessor
   evidence. Select the next bounded slice. Resolve its open behavior questions
   and get Build authorization if not already explicitly recorded for this scope.
2. Run `slice-verifier` in `intent` mode against the proposed contract and real
   predecessors. It checks feasibility, commitments, dependencies, and atomicity,
   not implementation correctness. Stabilized briefs also receive the independent
   reviewer pair through `artifact-review-dispatch.md`, in `intent` mode. Reuse a
   still-current intent review; do not repeat it just because the skill changed.
3. Write one failing behavior test through the agreed seam. Run the smallest
   relevant command and observe the contract's Expected red failure. Setup errors,
   unrelated compile failures, or retrospective claims are not red evidence.
   If minimal interface scaffolding is necessary, establish it without the behavior
   and rerun until the behavioral failure is observed. Write the smallest real
   implementation to get green, then repeat for the next behavior.
4. Enter a **separate independent review/refactor gate** after green. Capture
   the candidate identity. Dispatch `slice-verifier` and the independent code and
   coverage reviewers in `candidate` mode, against actual source, tests, and
   evidence. Keep reviewers read-only. Triage findings per the shared dispatch.
   Refactor only in this separate gate; rerun checks and obtain fresh candidate
   reviews after any source, test, contract, or relevant configuration change;
   a contract change that keeps reviews valid under the append-only check
   (**Candidate Identity**) is not such a change.
   Refactor in measured steps. When CodeScene or another Code Health tool is
   available, record a baseline score for each touched file first. Then make one
   small behavior-preserving change at a time; rerun the relevant tests and
   re-measure after each. Revert a step that breaks tests or lowers the score.
   Stop when the repository's declared threshold is met or, when none is
   declared, when no touched file regresses from its baseline. If small steps
   cannot reach the threshold, report the gap instead of rewriting. With no such
   tool, record the measurement as `unavailable`, or as `broken` with its
   diagnostic when the tool fails; never claim an unmeasured improvement.
5. Run the slice's required automated and manual verification, preserving exact
   command, working directory, result, and inspected revision. Missing manual
   proof remains pending. Apply the availability-based checks below as well as
   repository policy and the approved verification scope; discover actual commands
   rather than inventing them from a script name. Add deep review where required.
6. Present the behavior now demonstrated, differences from agreed expectations,
   remaining uncertainty, findings/resolutions, and exact candidate identity.
   Ask the human to accept, revise, or discard this candidate. A discard choice
   is not blanket permission for destructive cleanup; preserve other work.
7. After acceptance, make this exact candidate the next predecessor. Continue
   only within recorded build authority. Detail the next slice just in time;
   scope/behavior/permissions or major decision changes need renewed approval.
   Stop on deferred blockers instead of filling them with guesses.

Behavior-changing work requires observed red-green proof. Exemptions apply only
to genuinely non-behavioral changes with reasons, or a separately approved
exception permitted by repository policy. Difficulty writing a test is not an
exemption; rules of the repository being changed take precedence.

### Available Quality Checks

Retain RPIV's availability-based checks unless an explicit exception is agreed
and permitted by repository policy. Run available test-quality lint on changed
tests. Use connected CodeScene for changed-file baseline and post-change review;
retain the existing advisory target of at least 9.0 with no new smells unless
project policy or a recorded accepted regression says otherwise. Discover and
run an applicable mutation command for behavior-changing work when available;
verify its actual scope and arguments, not merely its script name. Wholly
non-behavioral work needs no mutation run. In validate, these are read-only
checks: findings go back to implement, never to an automatic source/test edit.
Absent tools remain unavailable; broken invocations retain diagnostics and block
their required check. An optional unavailable tool is not a successful check.

## Integration

Validate the composed candidate against the entire approved scope, not just
the last slice. Check cross-slice interactions and whole-project gates. Report
remaining Deferred Work and manual checks separately from accepted slice count.

Before requesting Integration authorization, resolve the current target SHA,
compare it to the recorded starting target, and inspect the complete candidate
diff. If the target has changed, validate a separately prepared combined result
against that new target before presenting it. Preparing that result also requires
permission; never change the user's target worktree just to test a merge.
Rebases, conflict resolution, or changed dependencies require fresh affected
reviews and whole-result checks. Bind authorization to the accepted candidate,
current target SHA, integration method, and validated result identity.

Immediately before the authorized operation, recheck those identities. After
integration, verify the resulting tree matches the validated result and run the
required integration checks. A failed check means integration failed validation;
report it and request remediation, never silently reset or claim completion.
With no integration authorization, leave the accepted candidate isolated.

## States And Evidence

Keep document readiness, build authority, technical validation, human acceptance,
and integration state separate. A checkmark or `status: ready` grants no authority.

- `passed`: the named check ran on the identified input and passed.
- `failed`: a check ran and identified a defect or unmet criterion.
- `unavailable`: a required capability is absent; state which one.
- `broken`: a crash, timeout, malformed response, or corrupt evidence prevented
  a trustworthy result. Preserve the diagnostic instead of calling it unavailable.
- `pending`: not yet performed. `stale`: its bound inputs changed.

Missing, broken, failed, pending, or stale required gates block readiness or
acceptance at the corresponding boundary. Never convert them into an empty clean
review. Optional absent tools may remain unavailable without blocking; explain
their limited coverage. A waived finding cannot waive a mandatory authority or
proof requirement. User-triaged concerns retain their rationale and residual risk.

Record inspection completion separately from finding disposition. A completed
inspection with findings is not a clean review. After explicit triage, its gate
can clear with accepted nonblocking concerns and recorded residual risk, provided
no mandatory blocker or proof gap remains. Preserve the original findings and
record clearance separately; do not relabel their historical outcome as clean.

Link evidence once from the brief; keep logs/source out of it. Record red then
green at their actual intermediate identities, and final verification at the
reviewed candidate. Preserve prior results and decisions as history. Later fixes
produce new evidence and reviews; do not rewrite earlier failures into passes.
Validation reports facts and remediation needs without editing implementation.
