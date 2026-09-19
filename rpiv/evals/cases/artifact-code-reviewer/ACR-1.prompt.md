Run a read-only `mode=intent` review using `rpiv:artifact-code-reviewer`.
Read `.rpiv/eval-fixture/intent-review-protocol.md` and follow its parent
preparation, dispatch, and post-review identity checks exactly.

- Selected brief: `.rpiv/eval-fixture/clamp-audit-conflicting-intent.md`
- Contract: `.rpiv/eval-fixture/clamp-audit-contract.md`
- Slice: `audit-entry`
- Output path (use for the protocol's output placeholder): `{OUT}`

Inspect the real source and canonical contract, not Phase code fences. End with
the role's six-column findings table. Preserve unavailable or broken outcomes;
do not infer tested implementation from a brief. No source writes, tests,
automatic approval, commits, merges, or external effects.
