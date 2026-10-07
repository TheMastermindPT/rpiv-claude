---
name: pr
description: Open a feature's one pull request with its summary after validation passes — lane and why, slices with their evidence, review and validation outcomes, fix rounds, and cycle metrics — built by a helper and sent only after the developer approves the exact text. Use as the last rpiv stage after validate, or when the user asks to open the PR for a validated feature branch.
argument-hint: "[target-branch] [design=<design-path>] [validation=<report-path>] [review=<review-path>]..."
allowed-tools: Read, Write, Bash(*), Glob, Grep, ask_user_question
shell-timeout: 10
---

# PR

## Read First

READ `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before starting. It owns the **Lanes** stops, integration consent and the rule that every GitHub write is asked first. This skill writes no source, test or artifact; its only file is the PR body under the git dir.

## Input

`$ARGUMENTS` names the target branch (the original integration target the feature started from), the approved design, the validation report, and any deep-review reports of the branch. Ask for anything missing or ambiguous; session history does not establish which report validates which branch. The branch is the one checked out where the skill runs.

## 1. Check the Gate

Read the validation report. If there is no validation report for the branch, or its frontmatter `verdict` is not `pass`, stop: tell the developer which gate is missing or failed and offer no PR. This is a **Lanes** stop, never a warning.

If the report has no `candidate_revision` in its Review input line, stop and say the report names no validated commit: a broken report, not a mismatch. Otherwise resolve it with `git rev-parse --verify <candidate_revision>^0`; the commit the report validated (`candidate_revision`, resolved) must equal what `git rev-parse HEAD` prints; if they differ, stop and name both commits, because the PR would carry code the report never validated. Then, if `git status --porcelain` prints any path, stop and list the uncommitted paths, because they would not reach the PR — except untracked files (`??` lines) under `.rpiv/artifacts/`, such as validate's own report, which never block. These are **Lanes** stops: offer no PR.

## 2. Build the Body

From the repository root, run:

`node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/pr-summary.mjs" --base <target> --design <design-path> --validation <report-path> [--review <review-path>]...`

The helper prints the whole factual body. Exit 2 with `pr-summary: broken: <detail>` is a broken input: report the detail and stop; never write a body by hand instead.

Replace only the two marker lines:

- `<!-- rpiv:agent summary -->` with two to four plain sentences on what the feature changes and why, taken from the design's intent.
- `<!-- rpiv:agent open-decisions -->` with a list of decisions still open for the developer (deferred unlocks, pending manual checks, accepted residual risk named in the design or the reports), or `none`.

Change no other line: the lane, slices, evidence, reviews, validation, fix rounds and cycle metrics are the helper's. Write the filled body to the path `git rev-parse --git-path rpiv/pr-body.md` prints; it lives under the git dir and is never committed. The title is the feature's topic from the design, in the repository's commit-subject style.

## 3. Ask Once, Then Send

Ask one `ask_user_question` that shows the exact body and the exact commands:

- `git push -u origin <branch>`
- `gh pr create --base <target> --head <branch> --title "<title>" --body-file <body-path>`

Options: send (run both commands), edit (change the summary or the open decisions, then ask again), stop. On send, run the two commands in that order; the approval hook asks again for each, and that prompt is the enforced confirmation, so never try to avoid it. A failed push or `gh` call is reported with its output; never retry with other flags, another remote or a force push.

## 4. Close

Report the PR URL from `gh`, the body path, and anything left open. Merging stays with the developer: this skill never merges, never approves the PR, and never deletes anything before the developer approves the exact commands (step 5).

## 5. After the Merge

When the developer says the PR merged, or asks to clean up the feature, run from the main checkout (not the feature's own worktree):

`node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/merge-cleanup.mjs" --branch <branch>`

The helper asks `gh` whether the branch's pull request merged and deletes nothing itself.

- `merged: no (<why>)`: offer nothing; report the state.
- Exit 2 with `merge-cleanup: broken: <detail>`: report the detail and stop; a broken answer is never "not merged", and never a reason to delete anyway.
- `merged: yes` with a `blocked:` line: cleanup runs nothing while a `blocked:` line stands. Report it with its fix and offer to plan again once it is done: for the current-directory block, switch the checkout off the branch (or run from another checkout); for commits that are not in the pull request, push them to a new branch or pull request (a merged pull request's head does not move), or drop them if they are not wanted; for a head or remote tip that is not in the repository, fetch it with `git fetch <remote> <sha>`.
- `merged: yes` with no `blocked:` line: ask one `ask_user_question` that shows the plan's exact `command:` lines plus the archive of the branch's cycle-log lines. Options: clean up (run them), stop. On clean up, run each `command:` line in order, then `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/cycles.mjs" --archive --branch <branch>`. Stop at the first command that fails: report it with its output and what already ran, and never archive after a failure; never retry with `--force` or another remote. The approval hook asks again for the branch delete and the remote delete; that prompt is the enforced confirmation, so never try to avoid it. A declined approval prompt is a stop: run nothing after it, the archive included, and report what already ran.
