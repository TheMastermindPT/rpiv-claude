Run a read-only `mode=intent` review, not a candidate review.
Read `.rpiv/eval-fixture/intent-review-protocol.md` and follow its parent
preparation, dispatch, and post-review identity checks exactly.

- Reviewer: `rpiv:slice-verifier`
- Selected brief: `.rpiv/eval-fixture/clamp-audit-conflicting-intent.md`
- Contract: `.rpiv/eval-fixture/clamp-audit-contract.md`
- Slice: `audit-entry`
- Output path (use for the protocol's output placeholder): `{OUT}`

Return the reviewer's full output with the parent's identity-check line as
specified. No fourth Correctness row, copied candidate code, source writes,
test execution, automatic approval, commits, merges, or external effects.
