---
name: validate
description: Audit a candidate revision or an integrated tree against approved behavioral contracts, TDD evidence, independent reviews, and human decisions. Use for a slice checkpoint or final combined validation.
argument-hint: "[brief-design-slice-or-plan-path] [candidate or integrated scope]"
allowed-tools: Read, Write, Bash(*), Glob, Grep, Agent, ask_user_question, mcp__codescene__pre_commit_code_health_safeguard, mcp__codescene__code_health_review
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: validation
    data:
      type: object
      properties:
        status:
          enum: [in-progress, in-review, ready]
        verdict:
          enum: [pass, fail]
  consumes:
    reads:
      plans: {}
      designs: {}
    meta:
      world: working-tree
---

# Validate

## Read First

READ `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before validation or resume. It owns the brief/test contract, workspace preservation, candidate and contract identity, exact review input and dispatch, project gates, human acceptance, and integration consent. Audit those rules rather than inventing a second workflow.

Validate is read-only for source, tests, plans, approval records, and existing evidence. Its only authored document is a fresh validation report and that report's hash stamp; the re-prove helper's log and JUnit report under the git dir are scratch output, not documents. Run checks in a way that preserves the candidate; report fixes for implement instead of editing tests or source, including during mutation analysis. Reviewers are read-only too.

## Input and Metadata

`$ARGUMENTS` names a brief, design, slice, or plan plus the candidate or integrated scope to audit. A full plan is not required. If input or scope is ambiguous, ask which approved contract and exact revision to validate; session history does not establish identity.

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git
```

Use these values for report metadata, not as a substitute for candidate identity. Resolve repository paths from the actual candidate workspace.

## 1. Verify the Audit Target

On start and resume, read the approved artifact and every referenced document. Verify managed RPIV artifacts' recorded `content_hash` with `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <absolute-artifact-path> --root <repository-path>` without `--stamp`. Verify referenced plain documents by their hash, without requiring artifact frontmatter on them, and run the shared append-only check against the approved copy. A failed check, a missing approved copy, or a mismatch is a blocker; validation never repairs an input hash.

Verify the current `candidate_revision`, repository, slice ID, accepted predecessor `base_commit`, and evidence against the shared identity contract. Keep the original integration target separate from that base. Verify the complete candidate representation and current state before and after checks; a branch name or tracked-only diff is insufficient. If there is no verified candidate, report **blocked** with `verdict: fail`, even if the input documents are ready. Missing git context does not justify a file-inspection-only pass.

Read historical plan fences as historical proposals, not implementation truth. Old checkmarks, old reviews, and prior green reports are claims to re-verify against this contract and revision. Limit conclusions to the declared audit scope; list untouched pending or deferred slices separately.

Completion criterion: an approved contract and immutable candidate identity match the actual audit target, or the report names the blocker without claiming validation passed.

## 2. Audit Behavior and Reviews

For each behavior, verify its test exists (named by the contract, or titled with the behavior ID) and asserts the approved example. Check recorded commands and results show the expected red observed before implementation, then green, tied to this slice and contract. Missing red evidence is a failing proof gap, including for pre-TDD work; never invent an exemption because code already exists. Check explicit exemptions against actual project rules.

Re-prove red for each slice commit in the audit scope, in every lane: in the candidate workspace, from the test runner's root (the folder its report's test paths are relative to), run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/reprove-red.mjs" --commit <slice-commit> --test <path>::<name>... [--link <dependency-folder>]... -- <test-runner> <args>` with `{tests}` and `{junit}` in the runner's arguments (for vitest: `node node_modules/vitest/vitest.mjs run --reporter=junit --outputFile={junit} {tests}`; for pytest: `.venv/bin/python -m pytest --junitxml={junit} {tests}`, or `.venv/Scripts/python.exe` on Windows, with `--link .venv`, never with `-I` or `-S`, which stop Python from loading the helper's import guard). It writes the slice's changed test and fixture files over the slice's parent commit (a Python run copies every file the slice changed under the test tree) in a scratch copy, runs the runner there, and never touches the candidate. The scratch copy is a short folder in the system's temporary folder, outside the repository, and a git work tree checked out at the base, so a test that runs git there (`git check-ignore`) sees the base's repository. The slice preflight's `reprove:` lines end in the runner it found (`--link .venv -- <venv python> -m pytest ...` or `--link node_modules -- node node_modules/vitest/vitest.mjs ...`). It runs from the nearest folder above the tests holding a project manifest (`package.json`, `pyproject.toml` and the like), else the repository root, and finds the runner there or in a folder above it; a project in a subfolder gets `--in <folder>`, which runs the command from that folder whatever the caller's folder, with the links and the runner written from it. A `--test` path may be written from the repository root, as the contract writes it, or from the run folder; the helper matches the report either way; when it found none, a `diagnostic: reprove lines need a runner` line says so and each line still needs `-- <runner>` with `{junit}` and `{tests}` appended. Pass the runner as an executable with arguments, not a shell string, and link the untracked dependency folders the tests need (for example `node_modules`). Pass one `--test <path>::<name>` per contract test; skip a test whose contract says `Expected red: none — pin`, since it must already pass. Pass an `it.each` test by its title as written in the test file, placeholders included (`%s`, `$name`); the helper matches its cases. When a behavior's Expected red names a revision other than the slice's parent (a revision note's `at <sha>`, often an amended-away candidate), re-prove that behavior's tests in a separate call with `--base <revision>`, one call per such revision, and leave those tests out of the call on the slice's parent. When the slice spans several commits (the slice, then its fix commits), pass `--commit <its last commit> --base <the commit the slice started from>` instead of re-proving on the last commit's parent, so the tests every slice commit changed are applied; the slice preflight's `reprove:` lines already carry that `--base`, and a line without `--test` re-proves a whole-file test. A named revision that no longer resolves is reported as `not re-provable: red at <rev>, revision missing`. The helper sorts each named test from the runner's JUnit report into `failed`, `failed-import`, `passed`, `skipped`, `mixed`, `failed-to-load`, `not-found` or `unavailable`, with the failure's first line as its reason (for a `.py` test that fails to load, its last pytest `E` line, such as the `ImportError`). The `result:` line is the whole run's: when it is `result: red` while a named test is `passed` or `skipped`, a `diagnostic: result: red is the whole run's` line names those tests, and they are not re-proved red (their bucket decides, never the run line). Copy each bucket and reason into the TDD audit beside the behavior's Expected red; validate does not judge whether a failure reason matches the Expected red, and leaves that reading to the human. Re-proved red never fails validation on its own, and a `failed` or `failed-import` bucket needs no question. Every other outcome — a bucket other than `failed`, `result: no-tests`, a `result: broken: <why>` run line, a missing or broken report, a `reprove-red: broken:` call, or a revision that is not re-provable — is reported under its own name, never as red and never as a pass, and becomes one developer question per slice via `ask_user_question`: accept it with a recorded reason, or send the slice back to implement. Record the answer and its reason in the TDD audit. In a project with an editable install (uv installs the project editable by default), the import guard sets aside the install's path to the checkout, so a module the base lacks fails to load (`failed-to-load`, `ModuleNotFoundError`) instead of reaching the checkout's copy; an install the guard cannot set aside still re-proves as `result: broken: imported from the checkout: <path>`, which joins the developer question like any other broken run line. A test file that fails to load stops pytest's whole run (exit 2), and so does a `conftest.py` that fails to import (exit 4, with no report). Each such load failure prints a `load-error:` line saying whether it is an import of a module or a name the slice adds (a module file at the slice commit and none at the base, or a name in the module's file at the slice commit and not at the base). When every load failure is, the run line is `result: red (import)` and each named test that failed to load reads `failed-import` with the import error as its reason (every named test, when a conftest stopped the run): that is the slice's expected red the test contract allows (an `ImportError` naming the new symbol), and the human still compares the reason with each behavior's Expected red. Any other load failure (a missing dependency, a syntax error, a module the base already has) keeps `result: broken: exit 2 (pytest: collection error or interrupted)` or `result: broken: exit 4 (pytest: usage error)`. Either way the other named tests read `unavailable`: re-prove them in a separate call. In a call that names tests, `{tests}` expands to only those tests: their pytest node ids (`<path>::<name>`) in a Python run, their files in any other, so the run and its report cover what was named; each call that names tests keeps its own log and report (the name carries a short hash of the named tests), so split calls never overwrite each other. Deep-review fix commits are not re-proved; record that as known risk. A slice that ended as a frozen snapshot has no commit to pass: report it as `not re-proved: no slice commit`, never skipping it; it joins the developer question like any other non-`failed` outcome.

Verify the separate review/refactor gate followed minimal green. Match every independent review to the current contract identity, candidate revision, and accepted predecessor base through the shared review input; a contract change that passes the shared append-only check keeps a review valid only as **Candidate Identity** allows. When fresh review is needed, dispatch with `mode=candidate` through the shared dispatcher, not a generic analysis prompt. Verify blockers are resolved and every later edit has fresh tests and reviews; stale reviews cannot approve a changed candidate.

Run the approved automated checks using actual project commands and required runtime proof. Apply project gate rules and the shared **Available Quality Checks**, retaining available test-quality lint, CodeScene, and applicable mutation checks unless an explicit permitted exception is recorded. Absent tools are `unavailable`; invocation or parse failures are `broken` with diagnostics. Optional checks may remain unavailable, but a required gate in either state blocks validation. Required gates cannot be silently waived by this skill or by a general acceptance message.

Mutation runs once, on the final candidate after the last review round's fixes or after the developer ends reviews; a run on an earlier candidate never counts for a later one. Validate reuses a recorded mutation run only when it ran on the revision being validated; otherwise it runs mutation once on that revision. For mutation runs, report surviving mutants and the observed evidence for a real gap versus an equivalent mutant. Route required fixes back to implement; validate does not strengthen tests or modify source. Re-check candidate identity after all commands. If a check changes the candidate, stop and report the drift; do not restore user files or issue a pass on the stale revision.

Record manual/runtime criteria as verified only with evidence; otherwise show the outstanding work. Required missing proof blocks the applicable validation scope.

## 3. Separate Acceptance and Integration

Report technical validation and human acceptance separately. Passing tests or reviews is not human acceptance. Verify any acceptance refers to the exact contract and candidate revision; if the acceptance the slice's lane requires is absent, report awaiting acceptance and prevent advancement even if candidate technical validation passes. Acceptance follows the slice's lane (shared **Lanes**): a normal slice without its own acceptance blocks advancement; in fast, slices chain on passing gates and the human accepts the combined result once before integration.

For final combined validation, verify separate integration authorization for the accepted candidates and target. Perform integrated-tree validation against all accepted slice contracts and combined project gates, with the resulting tree's exact identity recorded separately from each candidate. A pass for the last slice cannot prove the combined result. Validate never merges or grants consent; missing authorization, an included normal slice without its acceptance, a combined result without its acceptance (which covers the included fast slices), or missing integrated proof blocks a final pass.

## 4. Write and Finalize the Report

Read `templates/validation.md`. Create a fresh report under `.rpiv/artifacts/validation/<slug>_<topic-kebab>.md`, using the Metadata timestamp/author and the approved artifact as `parent`. Fill every section with observed facts or an explicit unavailable/blocked/not-applicable reason. Preserve old reports; do not append findings into or rewrite their evidence. Record identity, reviews, and decisions as references, not raw dispatch logs.

Keep `status: in-progress | in-review | ready` as document lifecycle and `verdict: pass | fail` as technical proof for the declared scope. `status: ready` means the report is finalized, not that the candidate is accepted or the whole scope shipped. State workflow blockers separately from the verdict so a technically passing candidate can still await human acceptance or integration consent.

Set `verdict: pass` only when the declared scope has a verified candidate, matching approved contract, complete TDD proof or valid exemptions, fresh reviews the lane requires, passing required gates, and no action-required gaps. A final combined pass additionally requires verified acceptance, integration authorization, and integrated results for the full declared scope. All other cases are `verdict: fail`; name whether blocked, broken, or failed, without extending the verdict enum. Optional diagnostics retain their real state even when non-blocking.

Finalize only the new report: run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <absolute-report-path> --root <repository-path> --finalizing --stamp`. Correct report-format defects only, then re-run the validator. Verify the final `content_hash` without `--stamp`. Input/source/test defects remain findings for their owning workflow.

Return the report path, scoped verdict and blockers, human acceptance and integration state, and remaining scope. Local fixes return to implement for tests and fresh reviews; intent changes return to revise. A pass starts no commit or integration by itself.

**Next step:** `/rpiv:pr <target-branch> design=<design-path> validation=<report-path>` — open the feature's one PR with its summary once this report's verdict is `pass`; the push and the PR always need the developer's approval. Deep-review and validate run once over the whole feature's range after its last authorized slice (normal: after that slice's human acceptance). Run `/clear` first, then this command, so the next stage starts in a fresh session; stop here instead if a developer decision or any other **Lanes** stop (a failed, broken, or missing gate) is pending.

**Write the handoff (a step, not part of the message):** before printing the closing message, unless a stop is pending, run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/handoff.mjs" write --next "<the next-step command>" [--artifact <path>] [--slice <id>] [--lane <lane>] [--decision "<open decision>"]...`; after `/clear`, Claude Code shows it once.
