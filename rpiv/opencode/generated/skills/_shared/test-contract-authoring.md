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
slices. The contract holds intent only: each Behavior has a stable ID, a
plain-language expectation, and one exact example (input -> expected outcome),
which is what the human approves. For example:

```markdown
### Test Contract:
- **Behavior B1**: At the agreed limit, another item is rejected without changing the collection.
  - Example: capacity 2, existing [A, B], add C -> capacity failure; collection remains [A, B].
```

Implementation detail stays out of the approved text: seams, test paths, Expected
red reasons, bindings, mutation scopes, commands, run order and cross-references.
Each behavior's test starts its title with the behavior ID (`B1: rejects an item
at capacity`), so the slice preflight finds it in the test files the slice
changed. A Python test is a function titled `test_<id>_<what>`
(`test_b1_rejects_empty_item`), which the preflight finds by its `def`; its
Expected red is a pytest outcome: an `AssertionError`, or an
`ImportError`/`AttributeError` that names the new symbol the slice adds, never xfail.
A raises behavior may also red as `Failed: DID NOT RAISE <X>`, only when `<X>`
is the exception the test expects (`with pytest.raises(FixtureError)` first
fails as `Failed: DID NOT RAISE FixtureError`). A behavior that maps one
exception to another may red with the input exception escaping unmapped, only
when the expected red reason named that type before the first run and it
differs from the target exception ("a missing file becomes `FixtureError`"
first fails with the named `FileNotFoundError` escaping). An escaping exception
the reason did not name, a `DID NOT RAISE` for another exception, or a generic
setup crash (a `TypeError` from a typo, a `NameError`) never qualifies.
The implementer writes the expected red reason into the TDD evidence
before the first run.

What reopens approval: adding, removing or changing a behavior or its example.
Work done to reach an approved outcome (tuning values, extra tests, fixtures) is
evidence, never a new behavior.

The `Test:` and `Expected red:` lines below stay valid and optional. Use them
for a pin (a test that must already pass, whose file the slice does not change)
and keep them in existing contracts.

### Test line grammar

A `Test:` line (or each item under a `Tests:` line) is one or more clauses
separated by `; `. Each clause takes exactly one of four forms; a code span is
text in backticks:

| Form | Example | What the slice preflight checks at the candidate |
| --- | --- | --- |
| `` `T` -> `P` `` (more titles joined by `and`) | `` `rejects an item` -> `src/a.test.ts` `` | each title is in the file |
| `` `T` in `P` `` then any prose | `` `rejects an item` in `src/a.test.ts`, one row per code `` | the title is in the file |
| `` rewrite in `P` (`T`) `` | `` rewrite in `src/a.test.ts` (`rejects an item`) `` | the title is in the file |
| `` `P` `` (more paths after `,` or `and`) then any prose | `` `src/a.test.ts` (new), one row per class `` | whole file: it exists, and the slice changed it unless the behavior is a pin |

`P` is a file path with an extension, written from the repository root or from
the plugin folder the brief belongs to; a bare file name works when only one
file has that name. Prose after the leading code spans is not checked, so name a
title (the first three forms) whenever one exists; the whole-file form proves
only that the slice wrote the file. Any other wording is unreadable: the preflight
lists it as `unchecked`, and `validate-artifact.mjs --finalizing` rejects it in
the sections being approved: those its `--slice <id>` options name, or without
them every section no approved copy already holds word for word. Other sections
only warn, so approved text is never edited to pass.
In a `.py` file a title is a test function's name, with its classes before it
(`TestCart::test_b1_x`) and an optional `[case]` id; the preflight checks its
`def` and `class` lines, never a string.
`test-contract.mjs` is the one reader of this grammar.

Use the strongest checkable oracle. Justify any genuinely nondeterministic
expected value; do not weaken exact behavior to shape/presence assertions.
Check the current source so Expected red is plausible. If behavior already
exists, record that fact and refine the missing behavior instead of inventing red.
A test that must already pass before its slice (a pin guarding kept behavior)
states `Expected red: none — pin`; validate does not re-prove it.
Name an `it.each` test by its title as written, placeholders included
(`adds (%s)`), so validate can match its cases. A revision's Expected red names
the revision it was observed at (`at <sha>`), so validate re-proves it there
when that revision is not the slice's parent.
List automated commands and observable manual criteria separately under
`### Success Criteria:`. A success-criteria reference is not evidence of a pass.

A genuinely non-behavioral item uses `- **TDD-exempt**: item - reason`.
Configuration changes and refactors may affect behavior; labels alone do not
qualify them. Repository-required TDD cannot be waived by an artifact marker.
