# Independent Artifact Review

Before dispatch or triage, read `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md`. It owns the common packet, frozen identities, referenced contracts, evidence validity, and readiness/acceptance rules. This file owns only dispatch of the independent code/coverage pair, their merged table, and user triage. The pair runs for slice candidate reviews where the slice's lane requires it (the shared **Lanes** table); intent reviews in design and plan follow the same table (normal only). Preserve the public agent names and role boundaries.

The caller supplies **write-step** (the existing artifact write), **review-step** (the review heading), and **triage-step** (where the user decides findings). Reuse the write-step's resolved artifact path; do not rebuild it from the current directory. Substitute these references below rather than assuming fixed step numbers.

## 1. Check and dispatch one frozen packet

Require an explicit `mode=intent` or `mode=candidate`. Read the shared contract and validate the caller's common inputs: `mode`, `workflow_path`, `artifact_path`, `slice_id`, `repository_path`, `base_commit`, `candidate_revision`, `patch_path` (candidate mode), `requirements`, and `evidence_paths`, plus its required identity/contract references. Write `patch_path` once, outside the frozen candidate, from the same identity every reviewer inspects. Earlier review reports are not evidence for a new review: leave them out of the packet. Resolve `workflow_path` to the readable absolute path of `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` in the installed plugin before dispatch. `slice_id` may be omitted for the pair's whole-current-brief review; it is required by slice-verifier. Verify the artifact and required inputs are readable before dispatch. Missing inputs mean incomplete review, not an inferred mode or empty candidate.

- **Intent:** no actual candidate is required. Review feasible intent, scope, contracts, and test seams before build. A clean intent review cannot claim tested/runtime readiness or implementation correctness.
- **Candidate:** the parent has already frozen the actual worktree and evidence under the shared contract. Review the actual diff/files/tests against the exact accepted predecessor/base `base_commit`, not the original integration target base. Inspect the supplied immutable `candidate_revision`; never reconstruct HEAD plus artifact code fences.

The parent owns snapshot derivation and evidence collection. Validate its commit-or-frozen-patch identity and accepted-predecessor evidence using the shared contract, without creating a second snapshot format here. Ensure contract references bind the exact `content_hash` of each referenced document. Reviewers read the referenced normative behavior sections, not merely headings or local summaries. Each reviewer must inspect the same frozen target and evidence. No per-reviewer revisions, modified packets, or substitute branch tips.

Serialize the validated shared packet once as `review_packet`, a string containing the common inputs and their existing bindings. Both roles receive that identical string; their registered agent instructions supply the different review lenses. When slice-verifier is also mandatory, give it the same frozen packet, including `slice_id`, independently of the pair's outputs. Reviewers receive no other reviewer's conclusions. Reviewers may read Git themselves through a read-only allowlist (diff, show, log, blame, rev-parse, merge-base, ls-files and rg; `.claude/hooks/_shared.mjs` BASH_ALLOWLIST denies everything else and approves exactly that), so they can read a base file with `git show <base>:<path>` instead of reconstructing it; the parent still supplies `patch_path`, the frozen view every reviewer shares. Do not broaden shell/write permissions beyond that allowlist, or ask a reviewer to generate snapshots or run tests.

Send the two task calls together to run in parallel:

```javascript
task({
  subagent_type: "rpiv:artifact-code-reviewer",
  description: "independent code and test-contract review",
  prompt: review_packet
})

task({
  subagent_type: "rpiv:artifact-coverage-reviewer",
  description: "independent verification-coverage review",
  prompt: review_packet
})
```

## 2. Validate outcomes and persist the table

Before merging, validate each response's mode, scope, reviewed identity/contract bindings, outcome, diagnostics, and role output against the supplied packet and shared contract. Candidate files and contract bindings must still match the frozen target after inspection. Missing outcome/identity or malformed output is broken review, not an empty findings list. A changed target invalidates the review.

The parent persists responses and their identities in the existing evidence/artifact location outside the frozen candidate; reviewers return text only. Collect all responses before writing review bookkeeping. After approval, store the review table and its triage in the evidence folder, not as a new section of the approved artifact, which the append-only check would treat as a change. If persistence would change a bound artifact, contract, or candidate input, follow the shared invalidation rule rather than silently mutating the reviewed target.

Each pair member returns `plan-loc | codebase-loc | severity | dimension | finding | recommendation`. Merge confirmed rows into `## Plan Review (<review-step>)`, adding `source` (`code` or `coverage`) and `resolution` (blank until user triage). Keep inspection outcomes/diagnostics above the table, separate from defects. Preserve actual `codebase-loc` values from both sources.

```markdown
## Plan Review (<review-step>)

Mode: {mode}. Reviewed target: {shared packet identity and contract bindings}.
Code review: {outcome and diagnostic}. Coverage review: {outcome and diagnostic}.

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | {plan-loc} | {codebase-loc} | {severity} | {dimension} | {finding} | {recommendation} | |
| coverage | {plan-loc} | {codebase-loc} | {severity} | verification-coverage | {finding} | {recommendation} | |
```

Sort by severity (`blocker`, `concern`, `suggestion`), then source (`code`, `coverage`); retain each reviewer's emitted order within that bucket. One finding per row; a row that names a class keeps its listed instances. Keep the header and confirmed rows if one source cannot complete.

Below the table, keep each source's other parts under its name: `Alternatives` (advisory; shown to the user at triage, never a blocker and never a fix-round trigger), `needs-run:` lines (the parent runs the ones the user picks at triage and records the result with the row they confirm or refute), and the `polish:` line (one triage decision for the whole line).

Only when both reviewers completed successfully on the identical target and returned zero findings, add `_No findings - both reviewers completed the stated mode on the frozen review target._`. An empty table alone is never clearance. In intent mode this marker clears only intent inspection; in candidate mode it does not replace execution evidence, other mandatory reviews, or user approval. Persist diagnostics even when there are no rows.

## 3. Classify gaps without a ready fallback

Apply the shared outcome rules, retaining confirmed findings independently of inspection gaps:

- Missing required review capability: `unavailable` with the exact missing capability.
- Reviewer crash, malformed output, or timeout: `broken` with the observed diagnostic.
- Identified mandatory defects: the gate is `failed` with severity-tagged findings; do not mislabel defects as tool unavailability. Retain completed inspection and nonblocking findings separately.
- Missing evidence or an uncompleted inspection: incomplete, never clean. A mandatory incomplete, unavailable, or broken review blocks ready/acceptance even if the other reviewer is clean.

Record each source's outcome and cause under Plan Review and note the blocked gate in Developer Context. The user may triage existing findings or resolve the blockage, but there is no fallback to ready/acceptance without the mandatory review. Do not silently turn candidate mode into intent mode to bypass missing evidence.

## 4. Triage and re-review

Present `{B} blockers, {C} concerns, {S} suggestions` together with inspection status, including a blocked status when counts are zero. At the triage-step, record the user's decision and reason for every finding in `resolution`: start it with one of `fixed`, `dismissed`, `deferred`, `residual` or `follow-up`, then ` — <reason>`, so `node "$RPIV_PLUGIN_ROOT/skills/_shared/review-yield.mjs" --root .rpiv` can count how often each reviewer's findings are acted on (a cell left blank stays pending); never auto-apply or invent an apply/defer/dismiss decision.

Before any blocker is fixed, from any reviewer (code, coverage, slice-verifier `VIOLATION`), tag it `patch` or `mechanism`. Triage owns this question; it never waits on a reviewer's optional section. Group the blockers by root mechanism. For each group that no reviewer's `## Alternatives` already answers with a design removing its class, dispatch one `rpiv:mechanism-scout` (in the normal lane) whose packet is the blocker's trigger, the outcome the behavior needs, the constraints, the seam at the slice's base revision and a `do not read:` list of the files the candidate changed (`dimension-sweep-and-checkpoint.md`, **Mechanism Options**). The group is `mechanism` when a reviewer alternative or a scout option removes its class without breaking a behavior's example; otherwise `patch`. A scout that is `unavailable`, `broken` or `anchored` leaves the tag `unknown: <state>`, and that group goes to the developer as a mechanism question, never silently patched. When the scout's agent type is not found, the session started before the agent was added (agents load at session start): tag it `unknown: unavailable: restart the session to load new agents` and say so in the question. A `mechanism` (or `unknown`) group is never patched without the developer's answer to one question: patch, or switch to <the option>, with what each costs. Record the answer in `resolution` inside the existing vocabulary: `fixed — patch: <reason>` or `fixed — mechanism: switched to <option>` (`deferred`/`follow-up` keep their meaning). A `patch` group is fixed as before. Who owns a switch, and how it counts against the round cap, is in the shared **Lanes** rules.

A defer/dismiss label is not a silent scope, TDD, or approval waiver. Scope or contract changes require explicit user approval and the shared invalidation process. Findings requiring changes remain tied to their original review; do not rewrite old evidence as though it reviewed the fix.

Keep inspection completion separate from finding disposition. A completed review
can clear after explicit triage of nonblocking concerns with recorded residual risk,
but only when no mandatory blocker, required proof gap, or incomplete inspection
remains. Record that clearance separately from the original findings and outcome;
accepted concerns do not become a zero-findings review.

After changes, the parent obtains fresh evidence and reviews at the new identity, including new contract `content_hash` values where applicable. Re-run every invalidated mandatory role on the same new frozen packet. Retry a broken invocation on the same identity only if the target and evidence have not changed. After 2 fix rounds (an intent review that needed fixes counts as one of them; a clean intent review spends none), stop and ask the developer as the shared **Lanes** rule says, including its convergence check; that cap never converts unresolved findings or incomplete inspection into acceptance. Stop blocked when required proof or approval cannot be obtained.
