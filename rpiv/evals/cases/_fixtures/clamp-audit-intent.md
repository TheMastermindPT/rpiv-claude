# Clamp Audit Intent Brief

## Intent

Project over-cap load proposals into deterministic entries for a later audit
summary, without changing the current validation result or apply-side behavior.
This eval scenario approves the referenced intent only. Build authorization,
candidate acceptance, and integration authorization are all pending.

## Architecture

The next slice is a pure leaf consumer of the real load-cap owner at
`lib/generation/load-cap.ts:15-31`. Inspect that source and its public consumers.
`lib/generation/adaptive-context/validation.ts:289-318` is a future integration
boundary, not a mutation seam or a fictional accepted slice.
Source bodies and test bodies belong in the repository, not this brief.

## Decisions

The authoritative decisions and behavioral obligations are in
`clamp-audit-contract.md`, sections Scope And Decisions, CA-OVER, CA-NOOP,
Verification Criteria, and Grounding. Review the entire referenced file. Its exact
SHA-256 must be resolved and recorded in the review packet before review; this
fixture contains no invented hash. No additional normative references exist.

## Next Slice

`slice_id: audit-entry`; behavior IDs `CA-OVER`, `CA-NOOP`.
Proposed source: `lib/generation/load-cap-audit/entry.ts`.
Proposed test: `tests/unit/generation/load-cap-audit-entry.test.ts`.
Use the owner's actual exported formula and predicates, not a guessed symbol.
No previous audit module is required. Build approval remains pending.

## Test Contracts

Canonical owner: `clamp-audit-contract.md#ca-over` and
`clamp-audit-contract.md#ca-noop`; verification:
`clamp-audit-contract.md#verification-criteria`. Resolve the exact whole-file
content hash and keep these entries at their owner rather than copying them.

## Deferred Work

- Validation/apply integration: decide which event is observed and the public
  runtime seam after the pure entry projection is accepted.
- Per-generation buffering: decide ownership/concurrency isolation when activating
  integration; there is no shared mutable buffer in the current slice.
- Coach summary and UI: agree wording, exact formatter oracles, and the consuming
  screen before elaboration. A future `ClampSummaryCard` supplies nothing today.
- Persistence and telemetry are excluded; either requires renewed scope approval.

## Verification Notes

Trace every obligation from the contract to its named criterion. Preserve the
private tolerance in `lib/generation/load-cap.ts:11-23` and the existing rejection
semantics in `lib/generation/adaptive-context/validation.ts:314-318`.
No test has run and no candidate exists for this intent-only review.

## Developer Context

Bounded preanswered choices: retain the pure leaf scope, finite validated input,
existing owner, no persistence, and mirrored unit-test directory. Approve intent
and scheduling only within those exact choices. Unknown behavior, changed
contracts, findings requiring a waiver, build/workspace permission, or external
effects require a real answer; leave the corresponding gate pending and stop.

## References

- `clamp-audit-contract.md` is the sole normative contract owner.
- Real source: `lib/generation/load-cap.ts:1-32` and
  `lib/generation/adaptive-context/validation.ts:289-318`.
