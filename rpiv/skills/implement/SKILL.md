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

**Code Health safeguard (tool-gated, advisory)** (after a phase's implementation files are written or changed): if the `mcp__codescene__code_health_review` tool is available to you (CodeScene MCP connected), run it on each changed source file's absolute path. A drop into Yellow (score < 9.0) or a NEW code smell versus the pre-change file is a refactor prompt — fix in small steps and re-review (the `safeguarding-ai-generated-code` skill, steps 1-2). This is ADVISORY: never block or reopen a phase solely on Code Health, and never install anything. If the tool is unavailable, record `code-health: unavailable` and proceed.

**Evidence** — append a `## TDD Evidence (implement)` section at the end of the plan file (create it on first use; append per phase, never rewrite prior entries). This is the audit trail `/rpiv:validate` checks:

```markdown
## TDD Evidence (implement)

### Phase {N}: {name}
- Behavior: {behavior} — Test: `{test name}` (`path/to/test-file.ext`)
  - Red: `{command}` -> {one-line failure output proving the Expected red reason}
  - Green: `{command}` -> pass
- TDD-exempt: `{item}` — {reason from the contract}
- Test-lint: {clean | {K} warnings fixed, {J} hints justified | unavailable}
- Code Health: {clean | `{file}`: {score} ({smell}) refactored | unavailable}
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