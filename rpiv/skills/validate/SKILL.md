---
name: validate
description: Verify that an implementation plan was correctly executed by auditing phase completion, success criteria, and working-tree changes. Use after the implement skill completes, when the user asks to "validate the plan", wants a post-implementation proof audit, or needs to confirm a feature is fully shipped per its plan.
argument-hint: "[plan-path]"
allowed-tools: Read, Write, Edit, Bash(git *), Bash(make *), Bash(npm *), Bash(npx *), Bash(node *), Glob, Grep, Agent, mcp__codescene__pre_commit_code_health_safeguard, mcp__codescene__code_health_review
shell-timeout: 10
contract:
  produces:
    kind: produces
    meta:
      artifactKind: validation
    data:
      type: object
      properties:
        status:
          enum: [in-progress, in-review, ready]
        verdict:
          enum: [pass, fail]
  consumes:
    reads:
      plans: {}
    meta:
      world: working-tree
---

# Validate

You are tasked with validating that an implementation plan was correctly executed, verifying all success criteria and identifying any deviations or issues.

## Input

`$ARGUMENTS` — optional path to a plan in `.rpiv/artifacts/plans/`. If omitted, branch on the recent-plans list in the Metadata block.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/now.mjs"
echo
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

4. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Extract each phase's `### Test Contract:` (Behavior/Oracle/Expected-red + TDD-exempt markers) and the plan's `## TDD Evidence (implement)` section — the evidence audit in Step 2 checks one against the other
   - If the plan has no `### Test Contract:` sections at all, note "pre-TDD plan — TDD evidence audit not applicable" for the report and skip the evidence audit (do not fail on this alone; the contract gate lives in implement)
   - Identify key functionality to verify

5. **Gather implementation evidence**:

   **If `in_repo:` in the Metadata block is `no`:**
   - Skip git-based evidence gathering (git log, git diff).
   - Validate via file inspection, the plan's `#### Automated Verification:` commands, and the plan checklist.
   - Note in report: "Git history unavailable — validation based on file inspection only".

   Otherwise:
   - `git log --oneline -n 20` — recent commits for implementation context.
   - `git diff <base>..HEAD` — where `<base>` covers the implementation commits (determine from `git log` above). Scope to specific paths if the diff is large.
   - The plan's own `#### Automated Verification:` commands — read them out of the plan and run them as-written. Do NOT hardcode `make` or any project-specific build tool here; the plan encodes the right commands per project (e.g. `npm run check`, `npm test`, `cargo test`, `pytest`).

6. **Spawn parallel research agents** to verify implementation:

   Spawn the agents below in parallel using the Agent tool. Wait for ALL agents to complete before proceeding.

   **Analyzer agent:**
   - subagent_type: `codebase-analyzer`
   - Prompt: "Analyze {component} and verify it implements {plan requirement} correctly."

   **Pattern finder agent:**
   - subagent_type: `codebase-pattern-finder`
   - Prompt: "Find patterns similar to {new code} and check if conventions are followed."

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for checkmarks in the plan (- [x])
   - Verify the actual code matches claimed completion

2. **Audit TDD evidence** (skip only for pre-TDD plans per Step 1.4):
   - For each contract **Behavior** in the phase, the `## TDD Evidence (implement)` section must show a Red entry whose failure matches the contract's Expected red reason, followed by a Green entry — and the named test must exist in the named file with assertions matching the contract's Oracle values
   - For each **TDD-exempt** marker, the evidence must note the exemption with the contract's reason
   - **Missing or contradicted evidence for any contract Behavior forces `verdict: fail`** — an implementation whose tests were never observed red is unproven, regardless of green criteria
   - Evidence findings go in the report's TDD Evidence Audit section

3. **Run automated verification**:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

4. **Test-theater lint (report-only)**:
   - If the project exposes a test-lint command (e.g. an npm script like `lint:test-theater`) or an ast-grep rule pack (`sgconfig.yml` under `tools/` or the repo root), run it on the test files this implementation added or changed
   - Findings are report-only — they NEVER affect the verdict; record them for the developer to weigh
   - If no pack/tool exists, record `test-lint: unavailable`

5. **Mutation testing (mandatory where testing is not exempt)**:
   - **When it is mandatory**: run mutation testing whenever BOTH hold — (a) the project exposes a mutation-testing command, AND (b) the plan is not *wholly* TDD-exempt (it has at least one non-`TDD-exempt` contract Behavior). A plan whose every phase is a whole-phase `TDD-exempt` marker introduces no new behavioral assertions to strengthen, so mutation is `not applicable` there.
   - **Which command**: PREFER a plan-scoped command — an npm script like `mutate:plan` that takes the plan path and mutates exactly the plan's changed source (e.g. `npm run mutate:plan -- <plan-path>`). Only if none exists, fall back to a generic `mutation` command (e.g. Stryker `stryker run`) scoped BY HAND to the modules this implementation changed — never run it unscoped (mutation costs minutes per file).
   - **Read the survivors, not just the score**: list every mutant that SURVIVED on the plan's changed source. Triage each as either **killable** (a real test-strength gap) or **justified** (an equivalent mutant, or a file the runner flagged as source-text/Hazard-4 optimistic). Killable survivors are gaps the developer must close in a follow-up test-improvement pass, then re-validate.
   - **Offer to auto-fix killable survivors** (opt-in): if triage leaves one or more *killable* survivors, ASK the developer with a single `ask_user_question` — "Mutation left {N} killable survivor(s) on the plan's changed source. Auto-fix them now by strengthening the tests, or leave them as gaps for a follow-up pass?" Header: "Mutation". Options: "Auto-fix (Recommended)" (strengthen the tests to kill them and re-run); "Leave as gaps" (record them; verdict stays fail).
     - **Auto-fix chosen**: for each killable survivor, strengthen the test that should have caught it — add or tighten an assertion that pins the exact behavior the mutant breaks (e.g. a `<`→`<=` boundary survivor needs a boundary-value assertion; a removed-call survivor needs an assertion on that call's effect). Edit ONLY the test files this implementation added or changed — never edit source to hide the mutant. Then **re-run the same plan-scoped mutation command** (use incremental mode — omit `--force` — so re-runs only re-test the strengthened assertions against the previously-surviving mutants, not the entire suite from scratch). **Guard: if no cache from a prior mutation run exists** (e.g., the implement phase skipped mutation testing entirely, leaving no `.stryker-tmp/` or equivalent), incremental mode is a no-op — the re-run falls back to full-scope, which is correct but slower. If the cache is stale (the source changed between runs), the runner will auto-detect and recompile — also correct but slower. In either case, confirm each targeted mutant is now KILLED. Loop until the killable survivors are killed, or one proves to be an equivalent mutant on closer inspection (re-triage it as *justified*). Record what was fixed in the report's mutation subsection. The test edits are a normal code change — commit them separately from the validation artifact (they are NOT part of the `.rpiv` decision-ledger group).
     - **Leave as gaps chosen**: the killable survivors stay un-triaged killable and force `verdict: fail` in Step 3.2, exactly as before.
     - **Verdict follows the post-fix state**: because this runs in Step 2, before the report is written once in Step 3, Step 3.2 computes the verdict on the final results. So when killable survivors were the ONLY action-required item, killing them yields `verdict: pass`; if any other blocker remains (a failing phase or command, missing TDD evidence, an action-required Deviation / Potential Issue), the verdict stays `fail` even after the mutants are killed.
   - **Skipping is a gap**: when mandatory, running it is required. Record `mutation: skipped ({reason})` ONLY for a genuine blocker (the command errored, or a single scoped file would blow a hard time budget) — an unexplained skip on a non-exempt plan is itself a validation gap.
   - **When not applicable**: record `mutation: not applicable ({no mutation command | wholly TDD-exempt plan})` — no verdict impact. This keeps the skill portable: projects without a mutation command are never blocked.

6. **Code Health safeguard (tool-gated, advisory gate — mirrors the mutation gate)**:
   - **When it runs**: if the `mcp__codescene__pre_commit_code_health_safeguard` tool is available to you (CodeScene MCP connected), run it on the repository root. It reviews the working tree's modified/staged files and returns `quality_gates` plus per-file `findings`.
   - **Read the deltas, not just the gate**: note any file whose Code Health DEGRADED on the plan's changed source, and any failed quality gate. For a degraded file, drill in with `mcp__codescene__code_health_review` on that file's absolute path to name the specific smell.
   - **Altitude (mirrors mutation)**: the Code Health SCORE is advisory; an un-accepted Code Health REGRESSION on the plan's changed source is action-required -> route it into `#### Potential Issues:`. It does NOT silently flip the verdict — Step 3.2 computes the verdict on the final results. A regression the developer explicitly accepts stays advisory (record the acceptance); a low score on code this plan did not change is advisory too.
   - **When not applicable**: if the tool is unavailable, record `code-health: not applicable (CodeScene MCP absent)` — no verdict impact. This keeps the skill portable: repos without CodeScene are never blocked.

7. **Assess manual criteria**:
   - List what needs manual testing
   - Provide clear steps for user verification

8. **Think deeply about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

### Step 3: Write the Validation Report

1. **Determine metadata** (from the Metadata block at the top of this skill):
   - Filename: `.rpiv/artifacts/validation/<slug>_<plan-topic-kebab>.md` — `<slug>` is the second tab-separated field on line 1 of the Metadata block above; `<plan-topic-kebab>` is the plan's `topic:` frontmatter value lowercased and hyphen-joined.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels.
   - `date:` / `last_updated:` ← `<iso>` (first tab-separated field on line 1 of the Metadata block above, offset verbatim).
   - `author:` / `last_updated_by:` ← matching label (fallback: `unknown`).
   - `parent:` ← the plan path resolved in Step 1.
   - `tags:` ← `[validation, ...]` plus any tags carried from the plan's frontmatter.
   - `topic:` ← `"Validation of <plan topic>"`.

2. **Determine verdict** (`status` is always `ready` — written once):
   - `verdict: pass` — every phase marked `- [x]` in the plan is verified against the code, every automated command passes, TDD evidence is complete for every contract Behavior (or the plan is pre-TDD), the mutation gate is satisfied (run where mandatory per Step 2.5, with no un-triaged killable survivors on changed source), no un-accepted Code Health regression lands on the plan's changed source, and no Deviations from Plan and no Potential Issues require action.
   - `verdict: fail` — any phase fails verification, any automated command fails, TDD evidence is missing or contradicted for any contract Behavior, a mandatory mutation run was skipped without a genuine blocker OR left un-triaged killable survivors on the plan's changed source, an un-accepted Code Health regression lands on the plan's changed source, or Deviations / Potential Issues list items that require action.
   - Test-theater lint findings are advisory — they inform the report, never the verdict. The mutation SCORE is advisory too, but the mutation GATE is not: where mutation is mandatory (Step 2.5), an unexplained skip or un-triaged killable survivors on changed source are action-required (route them into `#### Potential Issues:`). Survivors justified as equivalent mutants or Hazard-4-optimistic files stay advisory. Code Health (Step 2.6) is the same shape: the score is advisory, but an un-accepted Code Health regression on the plan's changed source is action-required (route into `#### Potential Issues:`); a degradation the developer accepts, or a low score on code the plan did not change, stays advisory.

3. **Write the artifact** using the Write tool (no Edit — this skill writes once per run). Read `templates/validation.md`, fill every `{placeholder}` with the values determined above and the observations gathered in Step 2, apply the section-omission rules in the template (omit `#### Pattern Conformance:` and `#### Potential Issues:` entirely when empty; keep all other sections and emit `None — …` literals when empty), and Write the result to the target path.

   - **Finalization lint**: after Write, run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <the validation artifact path> --stamp` (the artifact is written `status: ready`, so the finalization checks apply without `--finalizing`). If it exits non-zero, FIX the reported gaps (a leftover `{placeholder}` or an empty fence means Step 3's fill was incomplete) and re-run. On success it stamps `content_hash:`.

**What is NOT emitted to the artifact**: per-agent dispatch logs, raw `git log` output, intermediate reasoning. The Findings subsections capture verified outcomes only — the agent trace stays in the skill run, not the artifact.

### Step 4: Present Summary

```
Validation written to:
`.rpiv/artifacts/validation/{filename}.md`

Verdict: {pass | fail}
```

Follow-up footer:

---

💬 Follow-up: if findings are localized, fix them and re-run `/rpiv:validate`. If findings imply plan-level changes, escalate to `/rpiv:revise <plan-path>` first.

**Next step:** `/rpiv:commit` — group the validated changes into atomic commits (skip if `verdict: fail` — fix the gaps first, then re-run `/rpiv:validate`).

> 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.

## Handle Follow-ups

- **Validate does not edit code or plans.** It produces a report. Fixes happen in implement; plan revisions happen in revise.
- **Localized gaps.** If findings are small and localized, fix them in-place and re-run `/rpiv:validate` for a fresh report.
- **Plan-level gaps.** If findings imply the plan itself is wrong (missing phases, wrong approach, untestable success criteria), escalate to `/rpiv:revise <plan-path>` first, then re-implement, then re-validate.
- **No append mode.** Each validation run produces a fresh report — there is no `## Follow-up` append. The previous block's `Next step:` stays valid only when `verdict: pass`.

## Working with Existing Context

If you were part of the implementation:
- Review the conversation history
- Check your todo list for what was completed
- Focus validation on work done in this session
- Be honest about any shortcuts or incomplete items

## Important Guidelines

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Document everything** - Both successes and issues
4. **Think critically** - Question if the implementation truly solves the problem
5. **Consider maintenance** - Will this be maintainable long-term?

## Validation Checklist

Always verify:
- [ ] All phases marked complete are actually done
- [ ] TDD evidence complete: every contract Behavior has red (matching the Expected red reason) -> green, exemptions justified
- [ ] Contract tests exist as named, with assertions matching the contract's Oracle values
- [ ] Automated tests pass
- [ ] Test-theater lint run on changed test files (report-only) — or recorded unavailable
- [ ] Mutation gate satisfied where mandatory (non-exempt plan + a mutation command exists): run plan-scoped, survivors triaged (killable → action-required, equivalent/Hazard-4 → justified) — or recorded `not applicable`
- [ ] Code Health safeguard run where available: no un-accepted regression on the plan's changed source (regressions routed to Potential Issues) — or recorded `not applicable`
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Documentation updated if needed
- [ ] Manual test steps are clear

## Relationship to Other Skills

Recommended workflow:
1. `/rpiv:implement` - Execute the implementation
2. `/rpiv:validate` - Verify implementation correctness
3. `/rpiv:commit` - Create atomic commits for the validated changes

Validate runs against the working tree (staged or committed), so running it before commit avoids amend churn when fixing a `verdict: fail`.

Remember: Good validation catches issues before they reach production. Be constructive but thorough in identifying gaps or improvements.