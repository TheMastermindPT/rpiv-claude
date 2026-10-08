---
name: issue
description: File or drop the pending rpiv issue drafts — problems an agent found in rpiv itself (a broken helper diagnostic, a false approval prompt, contradicting rules) — after searching rpiv's open issues and showing the developer the exact text. Use when the session start says rpiv issue drafts are pending, or when the user asks to file, review or clear rpiv issue drafts.
argument-hint: "[draft-id]..."
allowed-tools: Read, Edit, Bash(*), ask_user_question
shell-timeout: 10
---

# Issue

## Read First

READ `${CLAUDE_PLUGIN_ROOT}/skills/_shared/candidate-workflow.md` before starting. Its **rpiv Problems** section says when a draft is made; its **Workspace And Authority** section owns the rule that every GitHub write is asked first. This skill writes no source, test or artifact; it reads and closes drafts under the git common dir and runs `gh` only after the developer's answer.

Issues go to rpiv's own repository, the one `show` prints from the plugin manifest — never the project being worked in.

## 1. List the Drafts

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/rpiv-issue.mjs" list`. It prints one `<id> | <trigger> | <title>` line per pending draft, oldest first, then `drafts: <N>`. With `drafts: 0`, say nothing is pending and stop. Exit 2 with `rpiv-issue: broken: <detail>` is a broken queue: report the detail and stop; it is never "nothing pending".

Take the drafts named in `$ARGUMENTS`, or else every pending draft, one at a time, oldest first.

## 2. Read the Draft

Run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/rpiv-issue.mjs" show <id>`. It prints `repo: <owner>/<repo>`, `title: <title>` and `body-file: <path>`; read the body file. Exit 2 is broken: report the detail and stop (a manifest without a GitHub repository URL included).

The helper already replaced project paths, the branch, the project's remote and secret-like values with placeholders. Read the text once more for anything from the project that slipped through — code, a file or product name, a customer or person — and remove it from the body file with Edit before asking. The issue describes rpiv's behavior and a repro outside the project.

## 3. Look for a Duplicate

Search rpiv's open issues read-only with words from the title:

`gh issue list -R <repo> --state open --search '<words>' --json number,title,url`

This is a read; the approval hook stays silent. A failed or missing `gh` is reported by its own reason (not installed, not authenticated, command failed) and the draft stays pending.

## 4. Ask Once

Ask one `ask_user_question` that shows the exact title, body and command, with four options (the tool takes two to four). In every command, single-quote each value the agent writes (a title, search words): single quotes are literal in Bash and PowerShell, so a `$` or a backtick in the text never runs; write a single quote inside a value as `'\''` in Bash or `''` in PowerShell. The body always goes through `--body-file`, never the command line.

- file new: `gh issue create -R <repo> --title '<title>' --body-file <body-file>`
- comment on the best open match from step 3: `gh issue comment <number> -R <repo> --body-file <body-file>`; edit when no match was found: change the text, then ask again
- drop: close the draft without filing
- keep for later: leave it pending

The tool's free-text answer asks for an edit or for a different listed match; do that, then ask again.

## 5. Run and Close

On file or comment, run that one command. The approval hook asks again, and that prompt is the enforced confirmation, so never try to avoid it. A declined approval prompt is a stop: the draft stays pending and nothing is closed. A failed `gh` call is reported with its output and the draft stays pending; never retry with other flags or another repository.

After the command succeeds, or on drop, run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/rpiv-issue.mjs" close <id> --outcome <filed|commented|dropped> [--url <url>]` with the URL `gh` printed (required for `filed` and `commented`). Keep for later runs nothing.

## 6. Close

Report each draft's outcome with its URL, and the drafts still pending.
