---
name: implement
description: Execute an approved implementation plan from .rpiv/artifacts/plans/ phase by phase, applying changes with TDD where behavior changes are involved, and verifying each phase against automated tests, success criteria, and runtime proof requirements before moving on. Use when the user invokes /implement, asks to "implement this plan", or wants an existing phased plan executed. Pair with revise to update plans mid-flight and validate to confirm completion.
argument-hint: "[plan-path] [Phase N]"
allowed-tools: Read, Edit, Write, Bash(*), Glob, Grep, mcp__codescene__code_health_review
disable-model-invocation: true
---

# Implement

You are tasked with implementing an approved technical plan from `.rpiv/artifacts/plans/`. These plans contain phases with specific changes and success criteria.

## Input

$ARGUMENTS

The input above is `<plan-path> [phase]`:
- First token is the plan path under `.rpiv/artifacts/plans/`.
- Anything after it (e.g. "Phase 2") names a single phase to scope to.

Rules:
- If a phase is named, implement ONLY that phase. Stop and print the closing block as soon as its success criteria pass. Do not read, edit, or check off other phases' sections.
- If no phase is named, implement every phase in the plan sequentially.
- If the input is empty or the plan path is missing/literal, ask the user for the plan path before proceeding.

## Getting Started

With a plan path in hand:
- Read the plan completely and check for any existing checkmarks (- [x])
- Extract each phase's `### Test Contract:` (Behavior/Oracle/Expected-red entries + TDD-exempt markers) and `### Success Criteria:`
- **Contract gate**: if any in-scope behavior-changing phase has no `### Test Contract:` (or an empty one), STOP before editing any file and print:

  ```
  This plan has no Test Contract for Phase {N} ({name}) — pre-TDD plan.
  TDD is the standard workflow: implement does not execute behavior-changing
  phases without a contract.

  Retrofit contracts first:
  /rpiv:revise {plan-path} "Retrofit Test Contracts onto each behavior-changing phase"

  Then re-run /rpiv:implement.
  ```

  A phase whose contract is a single whole-phase `TDD-exempt` marker passes the gate — that's an explicit exemption, not a missing contract.
- Read the original ticket and all files mentioned in the plan
- **Read files fully** - never use limit/offset parameters, you need complete context
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing if you understand what needs to be done

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each in-scope phase fully before starting the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

When things don't match the plan exactly, think about why and communicate clearly. The plan is your guide, but your judgment matters too.

If you encounter a mismatch:
- STOP and think deeply about why the plan can't be followed
- Present the issue clearly:
  ```
  Issue in Phase {N}:
  Expected: {what the plan says}
  Found: {actual situation}
  Why this matters: {explanation}

  ```

  Use the `ask_user_question` tool to resolve the mismatch. Question: "{Brief summary of the mismatch}". Header: "Mismatch". Options: "Follow the plan" (Adapt the plan's approach to the current code state); "Skip this change" (Move on without this change — it may not be needed); "Update the plan" (The plan needs to be revised before continuing).

## TDD Execution (per behavior-changing item)

Work each phase's `### Test Contract:` Behavior entries red -> green, one at a time, BEFORE writing the implementation code they prove:

1. **Red** — author the test by transcribing the contract: the contract's Oracle values become the test's assertions verbatim (exact inputs, exact expected outputs — do not weaken to shape/presence checks), in the contract's named test file. Run it. It must fail **for the contract's Expected red reason**. A compile/import error or an unrelated failure is not a valid red — fix the test until the failure matches, and if the contract's expected-red reason turns out to be impossible, that's a plan mismatch (use the mismatch flow above; contract changes go through `/rpiv:revise`).
2. **Green** — write the smallest implementation that passes the test. Run it again; confirm pass.
3. **Refactor** — clean up while keeping the test green.

Items marked `TDD-exempt` in the contract skip the loop — note the exemption in evidence and proceed. Never edit implementation files for a contract Behavior before its failing test exists and has been observed red.

**Test-theater lint** (after a phase's tests are written or changed): if the project exposes a test-lint command (e.g. an npm script like `lint:test-theater`) or an ast-grep rule pack (an `sgconfig.yml` under `tools/` or the repo root), run it on the changed test files. Rule-pack **warnings** on newly written tests: fix before marking the phase complete. **Hints**: fix or record a one-line justification in evidence. If no pack/tool exists, record `test-lint: unavailable` and move on — never fail on absence.

**Code Health safeguard (tool-gated, advisory — runs EVERY phase after implementation files are written).** This runs per-phase, immediately after the phase's source files are written or changed and before mutation testing. The tools are `codescene_code_health_score` (numeric baseline) and `codescene_code_health_review` (detailed smell breakdown). Both require CodeScene MCP to be connected — probe once with `codescene_verify_installation` at phase start; if absent, record `code-health: unavailable` in every phase's evidence and skip. When present:

  1. **Baseline each changed file.** Run `codescene_code_health_score` on each changed source file BEFORE the phase's code is written (immediately after the previous phase completes or HEAD is the baseline). Record the pre-change score.

  2. **After writing, review each file.** Run `codescene_code_health_review` on each file the phase modified. If ALL files score ≥ 9.0 with no new smells vs baseline, record `clean` and proceed to mutation testing.

  3. **For each degraded file** (score < 9.0 OR new smell vs baseline):

     a. **Read the review.** The output names the specific smell (Complex Method, Bumpy Road, Complex Conditional, etc.) and cites the function + line. That IS the diagnosis — you don't need to guess what's wrong.

     b. **Refactor in small steps targeting THAT smell.** One extraction, one guard-clause conversion, one compound-conditional decomposition at a time. Do NOT rewrite the file. The goal is to eliminate the named smell, not to restructure everything. Follow the pattern:
        - Extract one concern into a 3-arg pure function (CodeScene penalizes many tiny functions, rewards a few well-named ones)
        - Replace nested conditionals with early-return guard clauses
        - Break compound conditionals (`a && b && c`) into named predicates
        - Merge redundant checks into a single switch or lookup table

     c. **Re-verify after EACH step.** Run the phase's tests (they must still pass — refactoring preserves behavior). Run `codescene_code_health_score` to confirm the score moved up. Run `codescene_code_health_review` to confirm the named smell shrank or disappeared. If the score dropped further, revert the last step and try a different extraction — you introduced a new problem.

     d. **Stop when the score is ≥ 9.0 AND the named smell is gone.** Partial improvement is acceptable if you reached the score threshold. Record the final score, the smell eliminated, and the steps taken (e.g. "extracted `parseAgentResults` → CC 12→5, score 8.8→9.3").

     e. **Record in evidence.** Under the `### Phase {N}` entry, the `Code Health:` line traces baseline → steps → final score. This is the audit trail `/rpiv:validate` can cross-check against the plan's changed files.

**Mutation testing** (after all in-phase tests are written or changed and test-lint is clean): if the project exposes a plan-scoped mutation command (e.g. an npm script like `mutate:plan`), run it on the plan's changed source — `npm run mutate:plan -- <plan-path>`. Triage each survivor as either **killable** (a real test-strength gap — the code is fresh and you understood it moments ago) or **justified** (an equivalent mutant, e.g. the file was flagged as source-text/Hazard-4 optimistic by the runner). Skip justified survivors — the mutation runner is not grading your tests. For killable survivors, it is telling you what you forgot.

For each survivor, go to the mutated line. The mutator name IS the diagnosis:
  - ConditionalExpression → you only tested one branch. Which input
    reaches the other side?
  - EqualityOperator → you're off by one at a boundary. What's the
    edge value?
  - OptionalChaining → you never tested the null case. What input
    makes this property undefined?
  - BlockStatement → the removed block had a side effect you never
    asserted. What observable state did it write?

Strengthen the assertion, re-run, confirm killed. **The re-run uses the plan-scoped command's default mode** — if the project's `mutate:plan` script defaults to full-scope, the re-run is full-scope (which is correct: you changed the assertions, not the source, so the entire suite regates). If the project script supports incremental mode, it will only re-test against surviving mutants — faster but with no correctness difference. Record the kill in TDD Evidence. Then mark the phase
complete. A test that tolerated a mutant you understood is a test that
will tolerate a regression you didn't. If the project has no mutation
command, record `mutation: unavailable` and move on — never fail on
absence.

**Evidence** — append a `## TDD Evidence (implement)` section at the end of the plan file (create it on first use; append per phase, never rewrite prior entries). This is the audit trail `/rpiv:validate` checks:

```markdown
## TDD Evidence (implement)

### Phase {N}: {name}
- Behavior: {behavior} — Test: `{test name}` (`path/to/test-file.ext`)
  - Red: `{command}` -> {one-line failure output proving the Expected red reason}
  - Green: `{command}` -> pass
- TDD-exempt: `{item}` — {reason from the contract}
- Test-lint: {clean | {K} warnings fixed, {J} hints justified | unavailable}
- Mutation: {clean | {N} survivors killed, re-run clean | unavailable}
- Code Health: {clean | `{file}`: baseline {score} → {steps} → {final score} ({eliminated smell}) | unavailable}
```

## Verification Approach

After implementing a phase:
- Run the success criteria checks (usually `make check test` covers everything)
- Fix any issues before proceeding
- Update your progress in both the plan and your todos
- Check off completed items in the plan file itself using Edit
- If the input scopes you to a single phase, stop immediately after that phase's checks pass — do not advance to other phases

For non-behavioral chores (renames, config, TDD-exempt items), don't let verification interrupt your flow — batch it at natural stopping points. Behavior-changing items are the exception: their red -> green cycle IS the flow and cannot be batched (the red must be observed before the implementation exists).

## If You Get Stuck

When something isn't working as expected:
- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the plan was written
- Present the mismatch clearly and ask for guidance

Use skills sparingly - mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Present and Chain

When the last in-scope phase is complete, print the **completion** closing block:

```
Implementation complete:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
TDD evidence: {B} behaviors red->green, {E} exemptions (recorded in the plan's TDD Evidence section).
Outstanding: none.

Please review the diff and let me know if anything should reopen a phase.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only in-skill follow-up surface. For plan-level changes run `/rpiv:revise <plan-path>`; for session pauses run `/rpiv:create-handoff`.

**Next step:** `/rpiv:validate .rpiv/artifacts/plans/{filename}.md` — verify the implementation against the plan's success criteria before committing.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

If the run was paused mid-plan rather than completed, print the **paused** variant instead:

```
Implementation paused at Phase {N}:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
Outstanding: {list of unchecked items, blockers}.

Please review what landed and let me know if anything needs to change before resuming.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only in-skill follow-up surface. For plan-level changes run `/rpiv:revise <plan-path>` first.

**Next step:** `/rpiv:create-handoff` — capture in-flight state so the next session can resume cleanly via `/rpiv:resume-handoff`.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

## Handle Follow-ups

- **Implement owns checkboxes and TDD evidence, not plan content.** Check off `#### Automated Verification:` items `- [ ]` → `- [x]` as each phase's checks pass, and append to the `## TDD Evidence (implement)` section (append-only — never rewrite prior entries). Everything else — including `### Test Contract:` changes — is revise's: run `/rpiv:revise <plan-path>`; never rewrite plan content from inside implement.
- **For plan-level changes.** Run `/rpiv:revise <plan-path>` first — it appends a timestamped Follow-up section to the plan and preserves history. Then resume implement at the affected phase.
- **For session pauses.** Run `/rpiv:create-handoff` to capture in-flight state, then `/new` and `/rpiv:resume-handoff` in the next session.
- **Mismatch handling stays inline.** When code reality diverges from the plan, use the inline `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan") — that is implement's only follow-up surface; everything else escalates to revise or create-handoff.