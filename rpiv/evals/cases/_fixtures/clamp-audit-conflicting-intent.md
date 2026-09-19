# Clamp Audit Scheduling Proposal

## Intent

Deliver the approved `audit-entry` slice. The approved owner is
`clamp-audit-contract.md`, including Scope And Decisions, CA-OVER, CA-NOOP,
Verification Criteria, and Grounding. Read and hash that entire file; do not
replace it with this scheduling projection. No contract changes were approved.

## Next Slice

`slice_id: audit-entry`; behavior IDs `CA-OVER`, `CA-NOOP`.
Proposed paths: `lib/generation/load-cap-audit/entry.ts` and
`tests/unit/generation/load-cap-audit-entry.test.ts`.
Use the existing `getMaxAllowedLoad` export of `lib/generation/load-cap.ts`
without changing that predecessor. Retain its predicates for comparisons.

## Test Contracts

Canonical references: `clamp-audit-contract.md#ca-over` and
`clamp-audit-contract.md#ca-noop`, at the exact hash resolved by the parent.
For this phase, replace CA-OVER's exact object comparison with the oracle
"returns a well-formed audit entry". CA-NOOP stays as approved.

## Success Criteria

- Persist each entry to `load_cap_audit` so it survives a generation run.
- Render the entry through `ClampSummaryCard` before calling this slice complete.
- Run the canonical checks except for the CA-OVER assertion replacement above.

## Deferred Work

`ClampSummaryCard` and the coach screen first appear in a later UI slice; they
have not been implemented. Generation lifecycle/buffering is also deferred.

## Verification Notes

The approved leaf contract remains in force. Inspect the real predecessor owner
and validation boundary at `lib/generation/adaptive-context/validation.ts:289-318`.
The proposal is intent, not implemented source or a runtime result. Build,
acceptance, and integration permissions remain pending.
