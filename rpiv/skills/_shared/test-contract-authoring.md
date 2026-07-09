# Test Contract Authoring — think like a tester

Shared authoring standard for the Step 6.1 Test Contract in `design` and `blueprint`. Read this before generating a slice/phase's `#### Test Contract:` (design) / `### Test Contract:` (blueprint). The heading level and the slice-vs-phase noun belong to the calling skill; the discipline below is identical for both, and lives here so the two skills cannot drift.

**Before writing, think like a tester.** A Test Contract that only
asserts the happy path with a single fixture value will produce
survivors at mutation time — the same gaps you'd catch now at design
time, where they cost one sentence instead of a test rewrite plus a
3-minute mutation re-run. You are not listing tests. You are proving
to yourself that the code actually does what the contract claims.

1. Boundaries. Every conditional and range check has edges. If
   `if (remaining > 0)` has three values that matter (-1, 0, 5)
   but the Oracle only tests 5, you haven't proven the function
   handles the boundary. The Oracle should pin the edge.
2. Invariants. What must always be true? If remainingSets can never
   go negative but the Oracle never asserts non-negative, a sign
   flip at mutation time survives undetected. Assert the invariant.
3. Error paths. A function that validates and throws on bad input
   needs an Oracle that asserts the throw. If you only test valid
   input, every error-path mutant survives. Cover each error surface.
4. Branch exhaustiveness. Count the decision points the slice's code
   makes. Count the Behaviors in the contract. If code has more
   branches than the contract has Behaviors, some path is untested.
   Either add a Behavior or tag it TDD-exempt with a reason.

The **Format** of the contract block (heading level, `Behavior` / `Oracle` / `Expected red` / `TDD-exempt` shape) stays in each skill's Step 6.1 — it differs by nesting (design nests the contract one level deeper than blueprint). This file owns only the authoring *discipline* above.
