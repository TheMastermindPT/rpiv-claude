<!-- Read by architectural-review SKILL.md at Step 2.4 (load), and applied at Step 6 (suppress) and Step 7.4 (record on a durable rejection). Standing decisions are the repo's own "we decided not to" ledger — a review must not keep re-raising what the developer already ruled out. -->

# Standing decisions — load, suppress, record

## Load (Step 2.4)

Resolve the project root the way `_shared/regen-decisions-index.mjs` does (the nearest ancestor of the cwd that owns `.rpiv/`, bounded by the git toplevel) and read every `.rpiv/decisions/*.md`. Keep entries with `status: accepted`; their `key`, `rule`, and `scope` (`standing` / `global` = whole repo, otherwise a path glob) form the suppression set. `proposed` and `retired` entries are history — ignore them.

- No directory, or no accepted entries → record `standing decisions: none` under Tool Coverage → Ground truth ingested, and proceed.
- A file whose frontmatter does not parse, or an accepted entry missing `key` or `rule` → never skipped silently: record `unreadable: <path> — <diagnostic>` in the same line and tell the developer once at the start of Step 7. A broken decision suppresses nothing, so the findings it might cover still surface.

Add one Slop Map row per `references/slop-map.md` so every lens sees the accepted rules.

## Suppress (Step 6, after the verdicts are applied)

A Verified or Weakened candidate is **suppressed** — it does not reach triage — only when BOTH hold: (a) its evidence paths fall inside the decision's `scope`, and (b) the change it proposes is the one the decision's `rule` rejects. Match on the rule's meaning, not shared keywords. When unsure, do not suppress: surface the candidate at triage with "Conflicts with decision `<key>`?" in the question so the developer judges.

Do NOT suppress a candidate whose evidence shows the decision's premise no longer holds (the rule says "single implementation" and the code now has two; the rule exempts a module that has since tripled in size). Raise it at triage with a "Revisit decision `<key>`" option.

Record every suppression in Tool Coverage → Ground truth ingested: `standing decisions: N accepted; M suppressed — <candidate id> → <key>, ...`. A suppressed candidate is neither falsified nor rejected, and is never dropped without that line.

## Record (Step 7.4, on a durable rejection)

When the developer rejects a finding for a reason that should bind future reviews — a deliberate trade-off, a team convention, an accepted boundary — ask via `ask_user_question`: "Record this rejection as a standing decision so future reviews stop raising it?". Header: "Decision". Options: "Keep local to this review (Recommended)"; "Record standing decision". "Not now" or "not worth it yet" is Defer, not a durable rejection — do not offer to record it. Never record without the developer's choice.

On "Record standing decision":

1. Propose `key` (kebab-case, unique per topic), `rule` (one sentence naming what is allowed and why), and `scope` (the narrowest glob covering the finding's evidence paths, or `standing` when the reason is repo-wide). Confirm or correct them in ONE `ask_user_question`.
2. Follow `${CLAUDE_PLUGIN_ROOT}/skills/_shared/decision-ledger.md` Steps 2-3 exactly: upsert `.rpiv/decisions/<key>.md` (`source:` = this artifact's path; Context = the finding ID, headline, and evidence cite; Decision = the developer's reason; Consequences = what future reviews must not raise), surface any supersession of an existing key, then run `regen-decisions-index.mjs`.
3. A non-zero regen exit is reported with its output: the decision file stays written, the index is stated as stale, and nothing claims it was updated.
4. Set the finding's `statusNote` to `rejected — decision <key>`.
