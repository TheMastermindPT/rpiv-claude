---
template_version: 4
date: {Current date and time with timezone in ISO format}
author: {`author:` from Metadata block}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "Validation of {plan topic}"
status: ready
verdict: {pass | fail}
parent: "{plan path}"
tags: [validation, {inherit relevant tags from the plan's frontmatter}]
last_updated: {Same ISO timestamp as date: above}
last_updated_by: {`author:` from Metadata block}
---

## Validation Report: {Plan topic}

### Implementation Status

- ✓ Phase 1: {name} — {Fully implemented | Partially implemented (see Findings) | Not implemented}
- ✓ Phase 2: {name} — {…}
- ⚠️ Phase 3: {name} — {Partial — see Findings}

### TDD Evidence Audit

{One line per contract Behavior, checked against the plan's `## TDD Evidence (implement)` section. For pre-TDD plans emit the single line: "Pre-TDD plan (no Test Contracts) — evidence audit not applicable."}

- ✓ Phase {N} — {behavior}: red (`{expected-red reason observed}`) -> green; test `{name}` asserts the contract's Oracle values
- ✗ Phase {N} — {behavior}: {missing red | red for the wrong reason | test asserts weaker oracle than contract} — **forces verdict: fail**
- ✓ Phase {N} — TDD-exempt: `{item}` — {reason recorded}

### Automated Verification Results

- ✓ {1-line label}: `{command from plan}` — {brief outcome, e.g., "368 files, no errors"}
- ✓ {1-line label}: `{command from plan}` — {brief outcome}
- ✗ {1-line label}: `{command from plan}` — {failure summary}
- ✓ No regressions detected

### Test Quality

- Test-theater lint (advisory — never affects the verdict): {clean | {K} warnings / {J} hints on changed test files — listed below | unavailable}
  - {rule-id}: `{file}:{line}` — {one-line finding}
- Mutation gate: {not applicable ({no mutation command | wholly TDD-exempt plan}) | {score}% on the plan's changed source (`{command}`)}
  - {Per surviving mutant on changed source: `{file}:{line}` {mutator} — killable (test-strength gap → action required, listed under Potential Issues) | justified: equivalent mutant / Hazard-4-optimistic file}
  - {When mandatory and clean:} No survivors on changed source — gate passed.
- Code Health safeguard (advisory — mirrors the mutation gate): {not applicable (CodeScene MCP absent) | passed — no regression on the plan's changed source | regression on changed source, listed below}
  - {Per degraded file on changed source: `{file}` {before} -> {after} ({smell}) — {accepted by developer, advisory | action required, listed under Potential Issues}}

### Code Review Findings

#### Matches Plan:

- {file:line — what matches plan specification}
- {…}

#### Deviations from Plan:

- {file:line — what diverged and why (improvement vs gap)}
- {or:} None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

_Optional subsection — include when codebase-pattern-finder surfaced observations worth recording. Omit the whole `#### Pattern Conformance:` block when there is nothing to say._

- ✓ {Imports / test structure / naming / mock patterns / etc.} follow established codebase conventions
- Minor observation: {non-blocking variation worth flagging — explicitly tag as "acceptable variation, not a deviation"}

#### Potential Issues:

_Optional subsection — include when risks not covered by the plan surface (missing indexes, rollback gaps, perf concerns). Omit the whole `#### Potential Issues:` block when there are none._

- {file:line — risk not covered by the plan}

### Manual Testing Required:

{Bulleted checklist when manual criteria exist:}

1. {area}:
   - [ ] {verifiable step}
   - [ ] {verifiable step}

{Or, when the plan has no manual criteria:}

None — {one-line reason, e.g., "the plan explicitly requires no functional changes, only documentation and tests."}

### Recommendations:

- {Actionable bullet — e.g., "Address linting warnings before merge"}
- {…}
- {Or, when `verdict: pass`:} Ready to commit — implementation is complete and validated.
