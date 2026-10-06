---
name: rpiv-pr
description: "Open a feature's one pull request with its summary after validation passes — lane and why, slices with their evidence, review and validation outcomes, fix rounds, and cycle metrics — built by a helper and sent only after the developer approves the exact text. Use as the last rpiv stage after validate, or when the user asks to open the PR for a validated feature branch."
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

# PR

## Read First

READ `$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` before starting. It owns the **Lanes** stops, integration consent and the rule that every GitHub write is asked first. This skill writes no source, test or artifact; its only file is the PR body under the git dir.

## Input

`$ARGUMENTS` names the target branch (the original integration target the feature started from), the approved design, the validation report, and any deep-review reports of the branch. Ask for anything missing or ambiguous; session history does not establish which report validates which branch. The branch is the one checked out where the skill runs.

## 1. Check the Gate

Read the validation report. If there is no validation report for the branch, or its frontmatter `verdict` is not `pass`, stop: tell the developer which gate is missing or failed and offer no PR. This is a **Lanes** stop, never a warning.

If the report has no `candidate_revision` in its Review input line, stop and say the report names no validated commit: a broken report, not a mismatch. Otherwise resolve it with `git rev-parse --verify <candidate_revision>^0`; the commit the report validated (`candidate_revision`, resolved) must equal what `git rev-parse HEAD` prints; if they differ, stop and name both commits, because the PR would carry code the report never validated. Then, if `git status --porcelain` prints any path, stop and list the uncommitted paths, because they would not reach the PR — except untracked files (`??` lines) under `.rpiv/artifacts/`, such as validate's own report, which never block. These are **Lanes** stops: offer no PR.

## 2. Build the Body

From the repository root, run:

`node "$RPIV_PLUGIN_ROOT/skills/_shared/pr-summary.mjs" --base <target> --design <design-path> --validation <report-path> [--review <review-path>]...`

The helper prints the whole factual body. Exit 2 with `pr-summary: broken: <detail>` is a broken input: report the detail and stop; never write a body by hand instead.

Replace only the two marker lines:

- `<!-- rpiv:agent summary -->` with two to four plain sentences on what the feature changes and why, taken from the design's intent.
- `<!-- rpiv:agent open-decisions -->` with a list of decisions still open for the developer (deferred unlocks, pending manual checks, accepted residual risk named in the design or the reports), or `none`.

Change no other line: the lane, slices, evidence, reviews, validation, fix rounds and cycle metrics are the helper's. Write the filled body to the path `git rev-parse --git-path rpiv/pr-body.md` prints; it lives under the git dir and is never committed. The title is the feature's topic from the design, in the repository's commit-subject style.

## 3. Ask Once, Then Send

Ask one `question` that shows the exact body and the exact commands:

- `git push -u origin <branch>`
- `gh pr create --base <target> --head <branch> --title "<title>" --body-file <body-path>`

Options: send (run both commands), edit (change the summary or the open decisions, then ask again), stop. On send, run the two commands in that order; the approval hook asks again for each, and that prompt is the enforced confirmation, so never try to avoid it. A failed push or `gh` call is reported with its output; never retry with other flags, another remote or a force push.

## 4. Close

Report the PR URL from `gh`, the body path, and anything left open. Merging stays with the developer: this skill never merges, never approves the PR and never deletes a branch.

