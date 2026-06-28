---
name: validate
description: Verify that an implementation plan was correctly executed by auditing phase completion, Behavior Contract coverage, TDD evidence, Runtime Verification evidence, success criteria, and working-tree changes. Use after the implement skill completes, when the user asks to "validate the plan", wants a post-implementation proof audit, or needs to confirm a feature is fully shipped per its plan.
argument-hint: "[plan-path]"
allowed-tools: Read, Bash(git *), Bash(make *), Glob, Grep, Agent
shell-timeout: 10
---

# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

Validation is a proof audit, not just a test run. For behavior-changing work, validate must check whether the implementation satisfies the plan's Behavior Contract, User-Perspective Behavior Contract, TDD Contracts, Runtime Verification Contracts, Phase Evidence, and success criteria.

Passing automated tests is necessary but not always sufficient. For user-facing, API-backed, persistence-backed, job-backed, or integration-heavy changes, validate must also audit runtime evidence: browser behavior, API/network results, database state, logs/jobs, screenshots, or other real-system proof recorded during implementation.

Validate does not fix code and does not revise the plan. It reports whether the implementation is complete, partially complete, or needs changes.

## Input

`$ARGUMENTS` — optional path to a plan in `.rpiv/artifacts/plans/`. If omitted, branch on the recent-plans list in the Metadata block.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/git-context.mjs"
echo
echo "### recent (read only in case of empty user input)"
echo "recent plans:"
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/list-recent.mjs" .rpiv/artifacts/plans 10
```

## Steps

### Step 1: Input Handling and Context Discovery

When invoked:

1. **Determine context** — fresh or existing conversation?
   - If existing: review what was implemented in this session, then proceed to Step 2.
   - If fresh: continue with the substeps below.

2. **Locate the plan**:
   - If plan path provided, use it.
   - Otherwise, branch on the `recent plans:` listing in the Metadata block:
     - **Empty** — no plans under `.rpiv/artifacts/plans/`; ask the user for a path in prose.
     - **Exactly one entry** — confirm with `ask_user_question`: "Validate this plan?" with options "Validate `<filename>` (Recommended)" and "Pick a different path".
     - **Two or more entries** — present the top 4 filenames as `ask_user_question` options (a free-text "Other" row is appended automatically).

3. **Read the implementation plan** completely

   Extract:
   - Behavior Contract
   - User-Perspective Behavior Contract
   - Proof Map
   - phase list
   - Behavior Obligations per phase
   - TDD Contracts per phase
   - Runtime Verification Contracts per phase
   - Changes Required per phase
   - Success Criteria per phase
   - Phase Evidence sections
   - Testing Strategy
   - Runtime Verification Strategy
   - Performance Considerations
   - Migration Notes
   - References

   If behavior-changing phases lack TDD Contracts or explicit TDD exemptions, record this as a validation issue.

   If user-facing, API-backed, persistence-backed, job-backed, or integration-heavy phases lack Runtime Verification Contracts or explicit runtime-proof exemptions, record this as a validation issue.

4. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria: TDD, automated, runtime, manual/human, and evidence
   - Identify key functionality to verify
   - Map expected behaviors to files, tests, runtime proof, and phase evidence
   - Identify user-facing behavior that should be visible, blocked, allowed, persisted, recovered, or communicated to the user
   - Identify runtime proof obligations: browser/UI, API/network, database/persistence, logs/jobs/external integrations

5. **Gather implementation evidence**:

   **If `in_repo:` in the Metadata block is `no`:**
   - Skip git-based evidence gathering (git log, git diff).
   - Validate via file inspection, the plan's `#### Automated Verification:` commands, and the plan checklist.
   - Note in report: "Git history unavailable — validation based on file inspection only".

   Otherwise:
   - `git log --oneline -n 20` — recent commits for implementation context.
   - `git diff <base>..HEAD` — where `<base>` covers the implementation commits (determine from `git log` above). Scope to specific paths if the diff is large.
   - The plan's own `#### Automated Verification:` commands — read them out of the plan and run them as-written. Do NOT hardcode `make` or any project-specific build tool here; the plan encodes the right commands per project (e.g. `npm run check`, `npm test`, `cargo test`, `pytest`).

6. **Extract implementation evidence from the plan**:

   For each phase, inspect the Phase Evidence section and record:

   - TDD evidence:
     - behavior
     - test file
     - test name
     - red command
     - red failure
     - implementation files
     - green command
     - refactor
     - final relevant test command

   - Runtime evidence:
     - verification target
     - command/tool used
     - flow or query performed
     - expected result
     - observed result
     - evidence captured
     - gaps/unverified items

   Missing, vague, or contradictory evidence is a validation issue.

7. **Spawn parallel research agents** to verify implementation:

   Spawn the agents below in parallel using the Agent tool. Wait for ALL agents to complete before proceeding.
   - **general-purpose** agent — Verify implementation details match plan specifications, Behavior Contract, and phase Changes Required (analyzer role)
   - **general-purpose** agent — Verify implementation follows established codebase patterns (pattern-finder role)
   - **general-purpose** agent — Audit tests for behavior coverage, public-interface testing, brittle assertions, over-mocking, and missing edge cases (TDD reviewer role)
   - **general-purpose** agent — Audit runtime verification evidence against user-facing, API, database, job, and integration obligations (runtime-proof reviewer role)

   Example agent prompts:
   - "Analyze {component} and verify it implements {plan requirement} and Behavior Contract item {behavior} correctly."
   - "Find patterns similar to {new code} and check if conventions are followed."
   - "Review tests changed by this implementation. Verify they prove behavior through public interfaces, avoid brittle implementation-detail assertions, and would fail without the implementation."
   - "Review Phase Evidence and Runtime Verification Contract. Verify whether browser/API/database/log/job evidence proves the user-facing or integration behavior claimed by the plan."

   If a dedicated TDD or runtime-proof reviewer agent exists, prefer it for those audits instead of a generic agent.

### Step 2: Systematic Phase Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion
   - Check whether Phase Evidence exists and corresponds to the completed checkboxes
   - Flag checkboxes marked complete without supporting evidence

2. **Validate Behavior Obligations**:
   - Check each behavior obligation against actual code
   - Check each user-facing behavior against UI/API/state/persistence code
   - Verify each behavior maps to tests, runtime proof, or an explicit exemption
   - Flag behaviors implemented differently from the plan

3. **Audit TDD Contract execution**:
   - Verify required tests were added or changed
   - Verify the test names correspond to behavior, not implementation details
   - Verify Phase Evidence includes red command and red failure
   - Verify Phase Evidence includes green command and passing result
   - Verify refactor evidence exists when refactor was required
   - If red/green/refactor evidence is missing, classify as partial or needs_changes depending on severity
   - If TDD was exempted, assess whether the exemption is valid

4. **Run automated verification**:
   - Execute each command from "TDD Verification" and "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

5. **Audit Runtime Verification Contract execution**:
   - Check each Browser/UI verification item
   - Check each API/network verification item
   - Check each Database/Persistence verification item
   - Check each Logs/Jobs/External verification item
   - Compare expected vs observed results in Phase Evidence
   - Re-run runtime verification commands when feasible and safe
   - If runtime verification cannot be performed, verify that the gap is explicitly recorded

6. **Assess manual/human criteria**:
   - List what still needs human testing
   - Provide clear steps for user verification
   - Distinguish human judgment checks from runtime checks the agent could have performed

7. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?
   - Are user recovery paths handled?
   - Are persisted states correct after refresh/retry/navigation?
   - Do tests cover both success and failure paths?
   - Does runtime evidence prove the most important user-facing behavior?

### Step 3: Cross-Phase Proof Audit

After validating individual phases, audit the whole implementation:

1. **Behavior Contract coverage**
   - Every Behavior Contract item is implemented, explicitly preserved, or explicitly deferred.
   - Every behavior maps to at least one changed file, test, or runtime evidence item.
   - No behavior was silently changed from the plan.

2. **User-Perspective Behavior Contract coverage**
   - Visible states, allowed/blocked actions, error/success feedback, recovery paths, and persistence behavior are implemented.
   - UI behavior matches the developer decisions recorded upstream.
   - Runtime evidence proves the behavior in the actual app when required.

3. **TDD quality**
   - Tests verify observable behavior through public interfaces.
   - Tests avoid private implementation details where public seams exist.
   - Tests are not over-mocked.
   - Tests would fail without the implementation.
   - Important edge cases are covered or explicitly deferred.

4. **Runtime proof quality**
   - Runtime evidence is specific, not generic.
   - Evidence includes actual observed outcomes, not just intended steps.
   - Browser/API/database/log/job checks match the plan.
   - Any unverified item is explicitly listed as a gap.

5. **Plan drift**
   - Identify implementation deviations from the plan.
   - Classify deviations as:
     - acceptable implementation adaptation,
     - improvement,
     - risky drift,
     - plan violation,
     - unverified behavior.

6. **Regression risk**
   - Check whether nearby existing functionality could be broken.
   - Check whether relevant existing tests were run.
   - Check whether new tests are too narrow to catch likely regressions.

### Step 4: Generate Validation Report

Create comprehensive validation summary:

```markdown
# Validation Report: {Plan Name}

---
status: complete | partial | needs_changes | blocked
plan: `{plan-path}`
validated_at: {ISO timestamp}
---

## Summary

{Short verdict: whether the implementation is complete, what was proven, and what still needs work.}

## Implementation Status
✓ Phase 1: {Name} - Fully implemented
✓ Phase 2: {Name} - Fully implemented
⚠️ Phase 3: {Name} - Partially implemented (see issues)

## Behavior Contract Coverage

### Covered
- ✓ {Behavior} — implemented in `{file:line}`, tested by `{test}`, runtime proof `{evidence}`

### Missing or Weak
- ⚠️ {Behavior} — code present but no runtime proof
- ✗ {Behavior} — not implemented or not test-covered

## TDD Audit

### Phase Evidence
- Phase 1: ✓ red confirmed, green confirmed, refactor confirmed
- Phase 2: ⚠️ tests added but red failure not recorded
- Phase 3: ✗ behavior changed without required test-first evidence

### Test Quality
- ✓ Tests verify public behavior through `{interface/component/API}`
- ⚠️ Potential brittle assertion in `{test-file:line}`
- ✗ Missing edge-case test for `{scenario}`

## Runtime Verification Audit

### Completed
- ✓ Browser/UI: {flow and observed result}
- ✓ API/network: {request/response and observed result}
- ✓ Database/persistence: {query/row and observed result}
- ✓ Logs/jobs/external: {evidence}

### Unverified
- ⚠️ {Runtime proof item} — reason unavailable / missing evidence

## Automated Verification Results
✓ Build passes: `make build`
✓ Tests pass: `make test`
✗ Linting issues: `make lint` (3 warnings)

## Code Review Findings

### Matches Plan
- Database migration correctly adds {table}
- API endpoints implement specified methods
- Error handling follows plan

### Deviations from Plan
- Used different variable names in {file:line}
- Added extra validation in {file:line} (improvement)

### Potential Issues
- Missing index on foreign key could impact performance
- No rollback handling in migration

## Manual/Human Testing Required
1. UI functionality:
   - [ ] Verify {feature} appears correctly
   - [ ] Test error states with invalid input

2. Integration:
   - [ ] Confirm works with existing {component}
   - [ ] Check performance with large datasets

## Recommendations
- Address linting warnings before merge
- Consider adding integration test for {scenario}
- Document new API endpoints

## Final Verdict

Status: `complete | partial | needs_changes | blocked`

### Ready for Commit?
- Yes / No

### Why
- {Reason}

### Required Before Commit
- {Blocking item or "None"}

---

💬 Follow-up: if findings are localized, fix them and re-run `/rpiv:validate`. If findings imply plan-level changes, escalate to `/rpiv:revise <plan-path>` first.

**Next step:** `/rpiv:commit` — group the validated changes into atomic commits only if status is `complete`. If status is `partial`, `needs_changes`, or `blocked`, fix the gaps first and re-run `/rpiv:validate`.

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
```

## Handle Follow-ups

- **Validate does not edit code or plans.** It writes a validation report only. Fixes happen in implement; plan revisions happen in revise.
- **Localized gaps.** If findings are small and localized, return to `/rpiv:implement <plan-path> Phase N` or fix them in the implementation workflow, then re-run `/rpiv:validate` for a fresh report.
- **Proof gaps.** If TDD evidence or runtime evidence is missing but the implementation may be correct, classify as `partial` unless the missing proof hides a real correctness risk. Ask implement to fill the evidence or perform the missing verification.
- **Behavior gaps.** If expected behavior is not implemented, classify as `needs_changes`.
- **Plan-level gaps.** If findings imply the plan itself is wrong (missing phases, wrong approach, untestable success criteria), escalate to `/rpiv:revise <plan-path>` first, then re-implement, then re-validate.
- **Plan gaps.** If the plan lacks TDD/runtime contracts for behavior-changing work, classify as `blocked` or `partial` and escalate to `/rpiv:revise <plan-path>`.
- **No append mode.** Each validation run produces a fresh report — there is no `## Follow-up` append. The previous block's `Next step:` stays valid only when status is `complete`.

## Working with Existing Context

If you were part of the implementation:
- Review the conversation history
- Check your todo list for what was completed
- Focus validation on work done in this session
- Be honest about any shortcuts or incomplete items
- Be especially honest about missing red-phase evidence, skipped runtime verification, unrun commands, or assumptions you did not verify
- Do not give yourself credit for runtime behavior you did not actually observe

## Important Guidelines

1. **Be thorough but practical** - Focus on proof that matters: behavior, tests, runtime evidence, regressions, and maintainability.
2. **Run all automated checks** - Don't skip verification commands listed in the plan.
3. **Audit TDD honestly** - Missing red-phase evidence is a real validation finding, even if final tests pass.
4. **Audit runtime proof honestly** - Do not treat tests as proof of browser/database/API behavior unless the tests actually cover that behavior.
5. **Document everything** - Both successes and issues. Include what was proven and what remains unverified.
6. **Think critically** - Question if the implementation truly solves the problem from the user's perspective.
7. **Consider maintenance** - Will this be maintainable long-term?
8. **Classify severity clearly** - Separate harmless drift, proof gaps, behavior gaps, and blockers.

## Validation Checklist

Always verify:
- [ ] All phases marked complete are actually done
- [ ] Behavior Contract items are implemented, preserved, or explicitly deferred
- [ ] User-Perspective Behavior Contract items are implemented and proven where required
- [ ] TDD Contracts were followed or validly exempted
- [ ] Red-phase evidence exists for required behavior tests
- [ ] Green-phase evidence exists for required behavior tests
- [ ] Refactor-phase evidence exists where applicable
- [ ] Automated tests pass
- [ ] Tests verify behavior through public interfaces where possible
- [ ] Tests avoid brittle implementation-detail assertions
- [ ] Runtime Verification Contracts were executed or validly marked unavailable
- [ ] Browser/API/database/log/job evidence is specific and matches expected results
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] User recovery paths are handled
- [ ] Persistence behavior is correct after save/refresh/navigation/retry when applicable
- [ ] Documentation updated if needed
- [ ] Manual test steps are clear
- [ ] Final verdict clearly says whether the work is ready for commit

## Relationship to Other Skills

Recommended workflow:
1. `/rpiv:implement` - Execute the implementation
2. `/rpiv:validate` - Verify implementation correctness, TDD evidence, runtime proof, and plan alignment
3. `/rpiv:commit` - Create atomic commits for changes only after validation status is `complete`

Validation can analyze git history when commits exist, but it should also work before commit by inspecting the working tree, plan evidence, diffs, and verification commands. Prefer validating before commit so issues are caught before history is finalized.

Remember: Good validation catches issues before they reach production and before they are committed. Be constructive but strict: distinguish working code from proven behavior, and distinguish passing tests from real-system verification.
