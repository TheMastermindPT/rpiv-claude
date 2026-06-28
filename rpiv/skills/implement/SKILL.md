---
name: implement
description: Execute an approved implementation plan from .rpiv/artifacts/plans/ phase by phase, applying changes with TDD where behavior changes are involved, and verifying each phase against automated tests, success criteria, and runtime proof requirements before moving on. Use when the user invokes /implement, asks to "implement this plan", or wants an existing phased plan executed. Pair with revise to update plans mid-flight and validate to confirm completion.
argument-hint: "[plan-path] [Phase N]"
allowed-tools: Read, Edit, Write, Bash(*), Glob, Grep
disable-model-invocation: true
---

# Implement

You are tasked with implementing an approved technical plan from `.rpiv/artifacts/plans/`. These plans contain phases with specific changes and success criteria.

For behavior-changing work, implementation must follow the plan's TDD Contract: write or update the failing test first, run it to confirm meaningful failure, implement the smallest change required to pass, refactor, and re-run the relevant tests.

Passing tests are necessary but not always sufficient. For user-facing, API-backed, persistence-backed, job-backed, or integration-heavy behavior, implementation must also perform the Runtime Verification Contract when tooling is available: browser checks, API/network inspection, database verification, logs/jobs, screenshots, or other real-system evidence.

## Input

`$1` is the plan path (empty/literal → ask user); `${@:2}` is the phase scope (empty → all phases sequentially; else scope to that phase only).

## Getting Started

With a plan path in hand:
- Read the plan completely and check for any existing checkmarks (- [x])
- Extract each phase's TDD Contract, Runtime Verification Contract, success criteria, and explicit exemptions
- Read the original ticket and all files mentioned in the plan
- **Read files fully** - never use limit/offset parameters, you need complete context
- Read relevant existing tests, test utilities, fixtures, mocks, and runtime verification helpers before editing source files
- Think deeply about how the pieces fit together
- Create a todo list to track your progress
- Start implementing only after you understand:
  - the behavior being changed,
  - the public interface to test through,
  - the expected red failure,
  - the minimal implementation path,
  - the runtime proof required after tests pass.

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Use test-first implementation for behavior-changing work unless the plan explicitly marks the item as TDD-exempt
- Verify your work makes sense in the broader codebase context
- Prove important behavior through automated tests and, where required, runtime verification
- Update progress checkboxes and implementation evidence in the plan as you complete sections

Do not treat "code compiles" as implementation complete. A phase is complete only when:
- required red/green/refactor steps are done or validly exempted,
- relevant automated tests pass,
- phase success criteria pass,
- runtime verification is performed or explicitly marked unavailable with a reason,
- evidence is recorded clearly enough for validate to audit.

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

  Use the `ask_user_question` tool to resolve the mismatch. Question: "{Brief summary of the mismatch}". Header: "Mismatch". Options: "Follow the plan" (Adapt the plan's approach to the current code state while preserving required behavior/proof); "Skip this change" (Move on without this change — it may not be needed); "Update the plan" (The plan needs to be revised before continuing); "Mark proof unavailable" (Only for runtime verification that cannot be performed in this environment; record the gap clearly).

## TDD Execution Approach

For each behavior-changing item in a phase, follow this loop:

### 1. Behavior

- Identify the exact behavior from the plan.
- Identify the public interface to test through.
- Read nearby tests and follow existing project conventions.
- Avoid testing private implementation details unless no public seam exists and the plan explicitly allows it.

### 2. Red

- Write the smallest test that proves the behavior is missing or broken.
- Run the narrowest relevant test command.
- Confirm the test fails for the expected reason.

If the test passes before implementation:
- Check whether the behavior already exists.
- If the behavior already exists, record that no source change is needed for that behavior.
- If the test is weak, strengthen the test until it meaningfully proves the missing behavior.
- Do not proceed to implementation until the red phase is meaningful or the item is explicitly marked as already satisfied.

### 3. Green

- Implement the smallest source change required to pass the failing test.
- Re-run the same narrow test command.
- Fix failures until the test passes for the right reason.

### 4. Refactor

- Improve names, structure, duplication, boundaries, and clarity without changing behavior.
- Re-run the narrow test command after refactoring.
- Run broader tests at the phase boundary.

### 5. Evidence

Record TDD evidence for each behavior:

```md
TDD Evidence:
- Behavior:
- Test file:
- Test name:
- Red command:
- Red failure:
- Implementation files:
- Green command:
- Refactor:
- Final relevant test command:
```

Do not batch source implementation ahead of tests unless the phase or item is explicitly marked `TDD Exempt` with a reason.

## Runtime Verification Approach

After tests pass for behavior that affects users, APIs, persistence, jobs, external integrations, or application state, execute the phase's Runtime Verification Contract when tooling is available.

Runtime verification may include:
- opening the app in a browser and exercising the user flow,
- inspecting rendered UI states, disabled controls, messages, loading states, and recovery paths,
- checking API requests/responses or network payloads,
- querying the database or inspecting persisted records,
- checking logs, background jobs, queues, cron output, or external integration effects,
- capturing screenshots, terminal output, query results, or observed behavior.

For each runtime verification item, record:

```md
Runtime Evidence:
- Verification target:
- Command/tool used:
- Flow or query performed:
- Expected result:
- Observed result:
- Evidence captured:
- Gaps/unverified items:
```

If runtime verification cannot be performed:
- state why,
- record what remains unverified,
- do not claim the behavior is fully proven.

## Verification Approach

During each phase:
- Run narrow tests immediately after the red, green, and refactor steps.
- Run broader phase-level checks at natural stopping points.

After completing a phase:
- Run the phase success criteria checks.
- Run relevant automated tests.
- Run typecheck/lint/build if listed by the plan.
- Execute runtime verification items listed by the plan when tooling is available.
- Fix any issues before proceeding.
- Update your todos.
- Check off completed progress items in the plan file itself using Edit.
- Record TDD evidence and runtime evidence in the phase completion notes when the plan has a place for evidence.

Do not mark a phase complete if:
- behavior-changing code lacks required tests,
- the red phase was skipped without exemption,
- runtime verification was required but not performed or not marked unavailable with a reason,
- success criteria are failing.

Batch expensive verification at natural stopping points, but never skip the narrow test feedback loop required by TDD.

## If You Get Stuck

When something isn't working as expected:
- First, make sure you've read and understood all the relevant code
- Re-read the relevant tests, fixtures, mocks, runtime verification notes, and integration points
- Consider if the codebase has evolved since the plan was written
- If a test fails unexpectedly, determine whether the test, implementation, or plan assumption is wrong
- If runtime verification fails while tests pass, treat that as a real implementation problem unless evidence proves the runtime check is invalid
- Present the mismatch clearly and ask for guidance

Use skills sparingly - mainly for targeted debugging or exploring unfamiliar territory.

## Implementation Rules

- Do not edit implementation files before writing or identifying the relevant failing test unless the item is explicitly TDD-exempt.
- Do not claim TDD was followed unless red, green, and refactor evidence exists.
- Do not test private implementation details when public behavior can be tested.
- Do not over-mock internal collaborators; mock external boundaries when needed.
- Do not mark user-facing work complete only because tests pass.
- Do not skip runtime verification when the plan requires it and tooling is available.
- Do not silently change expected user behavior to make implementation easier.
- Do not broaden the phase scope without using the mismatch flow.
- Prefer the narrowest useful test command during red/green/refactor.
- Prefer broader verification at phase boundaries.
- Treat runtime verification failure as a real failure even if automated tests pass.

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off, if local code has changed, or if required TDD/runtime evidence is missing for the phase you are about to depend on

When resuming in the middle of a phase, identify the last completed TDD step:
- red written but not green,
- green passing but not refactored,
- refactored but phase checks not run,
- tests passing but runtime verification not performed,
- runtime verification complete but evidence not recorded.

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Phase Evidence Summary

At the end of each phase, produce a concise evidence summary:

```md
Phase {N} Evidence:

TDD:
- Behavior(s):
- Red:
- Green:
- Refactor:
- Tests:

Runtime:
- Browser/UI:
- API/network:
- Database/persistence:
- Logs/jobs/external:
- Unverified:

Success Criteria:
- {criterion}: pass/fail
```

Use this summary to decide whether the phase can be checked off.

## Present and Chain

When the last in-scope phase is complete, print the **completion** closing block:

```
Implementation complete:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
TDD: {R} red checks confirmed, {G} green checks confirmed, {F} refactor checks confirmed.
Runtime proof: {V} verification items completed, {U} unavailable/not applicable.
Outstanding: none.

Please review the diff, test evidence, and runtime evidence. Let me know if anything should reopen a phase.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan / Mark proof unavailable") — that is implement's only in-skill follow-up surface. For plan-level changes run `/rpiv:revise <plan-path>`; for session pauses run `/rpiv:create-handoff`.

**Next step:** `/rpiv:validate .rpiv/artifacts/plans/{filename}.md` — verify the implementation against the plan's success criteria before committing.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

If the run was paused mid-plan rather than completed, print the **paused** variant instead:

```
Implementation paused at Phase {N}:
`.rpiv/artifacts/plans/{filename}.md`

{P} phases completed, {M} files changed, {T} tests passing.
TDD: {R} red checks confirmed, {G} green checks confirmed, {F} refactor checks confirmed.
Runtime proof: {V} verification items completed, {U} unavailable/not applicable.
Outstanding: {list of unchecked items, blockers}.

Please review what landed, what was proven, and what remains unverified before resuming.

---

💬 Follow-up: surface code/plan mismatches inline via the `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan / Mark proof unavailable") — that is implement's only in-skill follow-up surface. For plan-level changes run `/rpiv:revise <plan-path>` first.

**Next step:** `/rpiv:create-handoff` — capture in-flight state so the next session can resume cleanly via `/rpiv:resume-handoff`.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

## Handle Follow-ups

- **Implement does not own plan design.** Source-file edits happen in implement. Implement may update progress checkboxes and implementation evidence in the plan, but must not change phase scope, architecture, success criteria, TDD contracts, or runtime verification contracts. For plan-level changes, use revise.
- **For plan-level changes.** Run `/rpiv:revise <plan-path>` first — it appends a timestamped Follow-up section to the plan and preserves history. Then resume implement at the affected phase.
- **For session pauses.** Run `/rpiv:create-handoff` to capture in-flight state, then `/new` and `/rpiv:resume-handoff` in the next session.
- **Mismatch handling stays inline.** When code reality diverges from the plan, use the inline `ask_user_question` flow ("Follow the plan / Skip this change / Update the plan / Mark proof unavailable") — that is implement's only follow-up surface; everything else escalates to revise or create-handoff.
