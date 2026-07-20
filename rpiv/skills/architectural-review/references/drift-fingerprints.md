<!-- SUPERSEDED (Slice 5, findings-store next layer). Step 8 no longer reads this file:
     drift now runs via `store diff` (skills/_shared/store.mjs), which matches current vs
     prior on the stored `fp` each finding already carries from `store add` — the 8a-8d
     fingerprint.mjs recompute and the `path#symbol@lens` fallback documented below are
     retired. Kept only as historical reference for the pre-store mechanics. See AR
     SKILL.md Step 8 and the store's `diffReview`. -->

# Drift Delta — content-hash fingerprint mechanics (Steps 8a–8d) — SUPERSEDED by `store diff`

#### 8a. Compute fingerprints for the current run

For each accepted/deferred finding, compute a fingerprint via the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/fingerprint.mjs"
```

Feed it one JSON line per finding:
```json
{"id": "L0-01", "lens": "G", "quotedLines": ["export class GodFile {"], "symbol": "GodFile"}
```

The `quotedLines` field is the verbatim evidence line(s) from the finding. The helper normalises whitespace, strips comments, and produces a deterministic SHA-256 prefix. Two findings with the same lens class, same normalised code, and same symbol produce the same fingerprint regardless of file path or line numbers.

The helper emits **exactly one stdout line per input finding**. A well-formed finding yields `{id, fp, lens, symbol}`; a malformed one yields `{id, fp: null, error}` (surfaced, never silently dropped). The run summary (`N ok, M invalid`) goes to stderr only, so it never pollutes the fingerprint stream.

**Assertion (two checks, both must hold before matching):**
1. **Count:** stdout line count == number of input findings. A mismatch means the helper itself misbehaved — abort and report.
2. **No nulls:** no stdout line has `fp: null`. Any such line is a malformed finding — abort, print its `error`, and fix the input before proceeding.

Then collect fingerprint → finding ID mappings from the `fp`-bearing lines for all accepted/deferred findings.

#### 8b. Compute fingerprints for the prior review

Read the prior review artifact. For each finding (by its ID), extract `lens`, the verbatim evidence line(s), and the symbol name. Pipe through the same helper to get prior-finding fingerprints.

#### 8c. Match by fingerprint

Match `{prior_fp → prior_id}` against `{current_fp → current_id}`. The orchestrator computes this inline — no agent dispatch needed. For each match:

- **Fingerprint match** → `Still-open`. The finding moved (possibly renamed file, shifted line numbers) but the code is the same.
- **Prior fingerprint has NO current match** → check if the evidence is genuinely gone. Read the cited code at HEAD via the `claim-verifier`:
  - Evidence genuinely absent → `Resolved` (VERIFY — do not trust path alone; a renamed file with the same bug must not read as Resolved)
  - Evidence still present but fingerprint changed (partial fix, body edited) → `Regressed` (the bug evolved but wasn't fixed)
- **Current fingerprint has NO prior match** → `NEW` (net-new slop since last review)

Fallback: if the fingerprint helper is unavailable (missing node, etc.), degrade to `path#symbol@lens` matching and note "fingerprint unavailable — path-based matching" in the Drift Delta section.

#### 8d. Write the Drift Delta

Write the **Drift Delta** section + scorecard `Resolved R · Regressed Rg · Still-open S · NEW N · Net Δ`. Update frontmatter `drift`. Headline the Regressed and NEW rows — they are the net-new slop the review exists to surface. Note when a Still-open match involves a renamed file (the fingerprint matched but the path didn't).
