# Current Intent Review Eval Protocol

This file instructs the parent wrapper, not the reviewer being measured. Read
the current candidate-workflow contract and the named agent registration first.
This is a read-only intent review, not permission to build or accept a candidate.

## Parent Preparation

1. Resolve the actual repository root and `b460257^{commit}` using read-only Git.
   Confirm HEAD equals that full SHA. Never manufacture a SHA or use `HEAD` as the
   packet's identity. Inspect status including untracked files. Require the two
   scoped source files below to match the resolved baseline, with no local edits.
   Seeded eval documents are intent inputs, not source or accepted predecessors.
2. Read the selected brief and `clamp-audit-contract.md` in
   `.rpiv/eval-fixture/`. Resolve all normative references/sections and behavior
   IDs `CA-OVER`, `CA-NOOP`. Hash the complete raw bytes of both files plus
   `lib/generation/load-cap.ts` and
   `lib/generation/adaptive-context/validation.ts` with SHA-256. The contract hash
   includes Scope And Decisions and Verification Criteria; it has no external
   normative dependencies. Do not substitute frontmatter or timestamps for hashes.
3. Record read-only commands, Git output, scoped status, and the initial hashes
   in `{OUT}.evidence.md`. Run only read-only Git and local file/hash inspection;
   do not inspect environment values, secrets, services, or unrelated worktrees.
4. Dispatch the specified `rpiv:` reviewer once with `mode=intent`, absolute
   `repository_path`, repo-relative `artifact_path`, `slice_id: audit-entry`, the
   resolved `base_commit`, the four input identities, canonical contract sections
   and IDs, and `evidence_paths: [{OUT}.evidence.md]`. Omit `candidate_revision`.
   Give it the output instructions below. Do not send case JSON, expected findings,
   alternate fixtures, historical code fences, or a copied source implementation.

## Reviewer Output Instructions

Inspect the actual source, scoped brief, canonical contract, and relevant callers
using your registered read-only tools. Audit according to your current role. Report
the following plain, un-fenced, un-bulleted fields once before your normal output:

- `mode: intent`
- `repository_path: <absolute actual repository>`
- `artifact_path: <repo-relative selected brief>`
- `slice_id: audit-entry`
- `base_commit: <resolved full SHA from parent evidence>`
- `input_sha256: <repo-relative path> <64 lowercase hex digest>` for each of the
  four supplied input identities, after inspecting the referenced content.
- `inspection: completed` only after inspecting all required inputs; otherwise
  `unavailable`, `broken`, `pending`, `stale`, or `incomplete`, with a diagnostic.
- `outcome: passed` for completed clean review, `failed` for identified findings,
  or the appropriate non-complete state. Failed findings are not a tool crash.

Do not emit `identity_check`; the parent owns the post-review comparison. Do not
claim tests ran or certify implementation correctness. For slice-verifier, retain
working notes and end with exactly Decisions / Cross-slice / Research. For the
artifact reviewers, end with the exact six-column findings table; coverage review
also needs its per-obligation working notes. An empty two-line table is valid only
after completed inspection. Do not invent a finding or a success to fill a format.

## Parent Completion

Repeat the baseline/status and all four raw-byte hash checks after the agent
returns. Append the observed comparison to `{OUT}.evidence.md`, never to the pinned
brief/contract. Prepend exactly one parent line `identity_check: unchanged` to the
agent's complete verbatim output only if all comparisons match. Otherwise prepend
`identity_check: stale`, `unavailable`, or `broken`, and record the diagnostic in
the evidence file. Never repair, suppress, or turn the agent's incomplete review
into clean output. Save this combined report to `{OUT}`; do not add a trailing
parent summary after the role's final rows/table.

If preparation or dispatch fails, write a non-clean diagnostic report to `{OUT}`
and stop; no empty clean table. Only these two output files may be written. Do not
change fixtures, source, contracts, branches, permissions, commits, merges, or
external state. No real model run is authorized merely by editing this protocol.
