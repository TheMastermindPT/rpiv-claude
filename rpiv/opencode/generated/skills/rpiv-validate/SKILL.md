---
name: rpiv-validate
description: "Audit a candidate revision or an integrated tree against approved behavioral contracts, TDD evidence, independent reviews, and human decisions. Use for a slice checkpoint or final combined validation."
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

# Validate

## Read First

READ `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` before validation or resume. It owns the brief/test contract, workspace preservation, candidate and contract identity, exact review input and dispatch, project gates, human acceptance, and integration consent. Audit those rules rather than inventing a second workflow.

Validate is read-only for source, tests, plans, approval records, and existing evidence. Its only authored output is a fresh validation report and that report's hash stamp. Run checks in a way that preserves the candidate; report fixes for implement instead of editing tests or source, including during mutation analysis. Reviewers are read-only too.

## Input and Metadata

`$ARGUMENTS` names a brief, design, slice, or plan plus the candidate or integrated scope to audit. A full plan is not required. If input or scope is ambiguous, ask which approved contract and exact revision to validate; session history does not establish identity.

Run this command with the `bash` tool and use its output:

```sh
node "$RPIV_PLUGIN_ROOT/skills/_shared/skill-context.mjs" now git
```

Use these values for report metadata, not as a substitute for candidate identity. Resolve repository paths from the actual candidate workspace.

## 1. Verify the Audit Target

On start and resume, read the approved artifact and every referenced document. Verify managed RPIV artifacts' recorded `content_hash` with `node "$RPIV_PLUGIN_ROOT/skills/_shared/validate-artifact.mjs" <absolute-artifact-path> --root <repository-path>` without `--stamp`. Verify referenced plain documents by their hash, without requiring artifact frontmatter on them, and run the shared append-only check against the approved copy; appended evidence and progress pass it, any other change fails it. A failed check, a missing approved copy, or a mismatch is a blocker; validation never repairs an input hash.

Verify the current `candidate_revision`, repository, slice ID, accepted predecessor `base_commit`, and evidence against the shared identity contract. Keep the original integration target separate from that base. Verify the complete candidate representation and current state before and after checks; a branch name or tracked-only diff is insufficient. If there is no verified candidate, report **blocked** with `verdict: fail`, even if the input documents are ready. Missing git context does not justify a file-inspection-only pass.

Read historical plan fences as historical proposals, not implementation truth. Old checkmarks, old reviews, and prior green reports are claims to re-verify against this contract and revision. Limit conclusions to the declared audit scope; list untouched pending or deferred slices separately.

Completion criterion: an approved contract and immutable candidate identity match the actual audit target, or the report names the blocker without claiming validation passed.

## 2. Audit Behavior and Reviews

For each behavior, verify the named test exists, uses the approved seam, and asserts the contract oracle. Check recorded commands and results show the expected red observed before implementation, then green, tied to this slice and contract. Missing red evidence is a failing proof gap, including for pre-TDD work; never invent an exemption because code already exists. Check explicit exemptions against actual project rules.

Verify the separate review/refactor gate followed minimal green. Match every independent review to the current contract identity, candidate revision, and accepted predecessor base through the shared review input. When fresh review is needed, dispatch with `mode=candidate` through the shared dispatcher, not a generic analysis prompt. Verify blockers are resolved and every later edit has fresh tests and reviews; stale reviews cannot approve a changed candidate.

Run the approved automated checks using actual project commands and required runtime proof. Apply project gate rules and the shared **Available Quality Checks**, retaining available test-quality lint, CodeScene, and applicable mutation checks unless an explicit permitted exception is recorded. Absent tools are `unavailable`; invocation or parse failures are `broken` with diagnostics. Optional checks may remain unavailable, but a required gate in either state blocks validation. Required gates cannot be silently waived by this skill or by a general acceptance message.

For mutation runs, report surviving mutants and the observed evidence for a real gap versus an equivalent mutant. Route required fixes back to implement; validate does not strengthen tests or modify source. Re-check candidate identity after all commands. If a check changes the candidate, stop and report the drift; do not restore user files or issue a pass on the stale revision.

Record manual/runtime criteria as verified only with evidence; otherwise show the outstanding work. Required missing proof blocks the applicable validation scope.

## 3. Separate Acceptance and Integration

Report technical validation and human acceptance separately. Passing tests or reviews is not human acceptance. Verify any acceptance refers to the exact contract and candidate revision; if absent, report awaiting acceptance and prevent advancement even if candidate technical validation passes.

For final combined validation, verify separate integration authorization for the accepted candidates and target. Perform integrated-tree validation against all accepted slice contracts and combined project gates, with the resulting tree's exact identity recorded separately from each candidate. A pass for the last slice cannot prove the combined result. Validate never merges or grants consent; missing authorization, an unaccepted included candidate, or missing integrated proof blocks a final pass.

## 4. Write and Finalize the Report

Read `templates/validation.md`. Create a fresh report under `.rpiv/artifacts/validation/<slug>_<topic-kebab>.md`, using the Metadata timestamp/author and the approved artifact as `parent`. Fill every section with observed facts or an explicit unavailable/blocked/not-applicable reason. Preserve old reports; do not append findings into or rewrite their evidence. Record identity, reviews, and decisions as references, not raw dispatch logs.

Keep `status: in-progress | in-review | ready` as document lifecycle and `verdict: pass | fail` as technical proof for the declared scope. `status: ready` means the report is finalized, not that the candidate is accepted or the whole scope shipped. State workflow blockers separately from the verdict so a technically passing candidate can still await human acceptance or integration consent.

Set `verdict: pass` only when the declared scope has a verified candidate, matching approved contract, complete TDD proof or valid exemptions, fresh independent reviews, passing required gates, and no action-required gaps. A final combined pass additionally requires verified acceptance, integration authorization, and integrated results for the full declared scope. All other cases are `verdict: fail`; name whether blocked, broken, or failed, without extending the verdict enum. Optional diagnostics retain their real state even when non-blocking.

Finalize only the new report: run `node "$RPIV_PLUGIN_ROOT/skills/_shared/validate-artifact.mjs" <absolute-report-path> --root <repository-path> --finalizing --stamp`. Correct report-format defects only, then re-run the validator. Verify the final `content_hash` without `--stamp`. Input/source/test defects remain findings for their owning workflow.

Return the report path, scoped verdict and blockers, human acceptance and integration state, and remaining scope. Local fixes return to implement for tests and fresh reviews; intent changes return to revise. No automatic commit or integration next step follows a pass.

