# Test Contract Authoring — think like a tester

Read this before authoring or changing a slice's Test Contract. Keep the contract
once in its authoritative brief; scheduling views link to its section and hash.
This file owns the authoring format and discipline across design,
plan, and revise. Execution and review use `candidate-workflow.md`.

**Before writing, think like a tester.** A Test Contract that only
asserts the happy path with a single fixture value will produce
survivors at mutation time — the same gaps you'd catch now at design
time, where they cost one sentence instead of a test rewrite plus a
mutation re-run. Describe approved behavior before choosing implementation;
the contract is an obligation, not proof that unbuilt code works.

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
4. Branch coverage. Enumerate meaningful alternatives in the approved behavior.
   During candidate review, inspect reachable implementation paths for missing
   scenarios. Several branches can implement one behavior; branch counts alone
   do not prove coverage. Add independently justified scenarios for real gaps,
   not TDD-exempt labels for untested behavior.

## Format

Use `### Test Contract:` for executable phases, or one level deeper for design
slices. Each Behavior has a stable ID, plain-language expectation, public seam,
named test location, exact Oracle, and Expected red reason. For example:

```markdown
### Test Contract:
- **Behavior B1**: At the agreed limit, another item is rejected without changing the collection.
  - Seam: the collection's public add operation.
  - Test: `rejects an item at capacity` -> `path/to/collection.test.ext`
  - Oracle: capacity 2, existing [A, B], add C -> capacity failure; collection remains [A, B].
  - Expected red: the current operation accepts C and changes the collection to [A, B, C].
```

Use the strongest checkable oracle. Justify any genuinely nondeterministic
expected value; do not weaken exact behavior to shape/presence assertions.
Check the current source so Expected red is plausible. If behavior already
exists, record that fact and refine the missing behavior instead of inventing red.
List automated commands and observable manual criteria separately under
`### Success Criteria:`. A success-criteria reference is not evidence of a pass.

A genuinely non-behavioral item uses `- **TDD-exempt**: item - reason`.
Configuration changes and refactors may affect behavior; labels alone do not
qualify them. Repository-required TDD cannot be waived by an artifact marker.
