# Decision-ledger protocol

Shared by `discover` and `design`. Run this at finalization, after the artifact's
`## Decisions` section is settled and before flipping `status` to its terminal value.
`architectural-review` reuses Steps 2-3 when the developer records a rejected finding as a
standing decision (`skills/architectural-review/references/standing-decisions.md`); Step 1's
tag scan does not apply there.

A **standing decision** outlives the feature that produced it and constrains future work (e.g. a
testing standard, a boundary rule, a technology choice). Feature-local decisions stay in the
artifact's `## Decisions` and are NOT promoted. Promotion is **opt-in by tag** — never auto-prompt.

## Step 1 — find the standing decisions

Scan the artifact's `## Decisions` for entries that carry a `scope: standing` line, then:

- **One or more tagged** — continue to Step 2 for each.
- **None tagged, but feature-local decisions exist** — print exactly ONE non-blocking line so the
  opt-in stays visible, then continue finalization:
  `Standing decisions: N recorded feature-local, none promoted. If any must bind future work, tag it (scope: standing + key: + rule:) before the status flip.`
  Do NOT ask a question and do NOT block — promotion is opt-in, never auto-prompted.
- **No decisions at all** — do nothing and continue.

The standing TDD decision that `design` includes verbatim (`### TDD Standard (standing)`)
is enforced structurally by the pipeline — slice-verifier's commitments audit flags per-slice
violations — and is deliberately NOT promoted to the ledger. Do NOT tag, promote, or re-write it.
Only tag genuinely new standing decisions.

Each `scope: standing` entry MUST also carry:

- `key:` — a kebab-case identifier, unique per topic (e.g. `zod-http-boundary`). The key is the
  ledger filename and the latest-wins unit: writing the same key again supersedes the prior entry.
- `rule:` — one sentence, the injected one-liner (this is what lands in CLAUDE.md).

If a `scope: standing` entry is missing `key` or `rule`, STOP and ask the developer to supply them
(one question) — do not invent them silently.

## Step 2 — upsert `.rpiv/decisions/<key>.md`

For each standing decision, resolve the repo root (git toplevel) and target `<root>/.rpiv/decisions/<key>.md`.

**If the file does not exist** — create it:

```markdown
---
key: <key>
status: accepted
scope: <standing | a glob like lib/generation/** | global>
rule: "<the one-line rule, quoted>"
decided: <today, YYYY-MM-DD>
updated: <today, YYYY-MM-DD>
author: <developer>
source: <this artifact's repo-relative path>
---

# Decision: <title>

## Context
<why this decision exists — from the entry's Question / the ambiguity it resolved>

## Decision
<the decision itself — from Chosen>

## Consequences
<what it constrains going forward — from Rationale + implications>

## History
- <today> accepted — <one line>. source: <this artifact's path>
```

**If the file already exists** (keyed latest-wins) — amend it, do not overwrite:

- Update `rule:` and the body only if the decision actually changed; otherwise leave as-is.
- Bump `updated:` to today.
- Append one `## History` line: `- <today> amended — <what changed>. source: <this artifact's path>`.
  Never delete prior History.
- Surface the supersession to the developer: "this updates standing decision `<key>` from
  `<old decided/updated date>`" so they can veto. Latest-wins is the default, not a silent one.

Set `status: retired` (instead of amending) only when a decision is being reversed with no
replacement; a retired entry stays on disk for history but drops out of the injected index.

## Step 3 — regenerate the injected index

After writing/amending, refresh the CLAUDE.md `Standing Decisions` block:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/regen-decisions-index.mjs"
```

The block is generated from `status: accepted` entries only. `regen-decisions-index.mjs --check`
is the sibling gate the finalization lint runs to confirm CLAUDE.md and the ledger agree.

## Note on committing

`.rpiv/decisions/**` and the CLAUDE.md `Standing Decisions` block are a pinned change group — the
`commit` skill always includes them with the work that produced them. Do not leave them uncommitted.
