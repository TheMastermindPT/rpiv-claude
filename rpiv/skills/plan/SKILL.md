---
name: plan
description: Sequence an EXISTING design artifact (.rpiv/artifacts/designs/*.md) into a phased, implement-ready plan — parallelized atomic phases with per-phase test contracts and success criteria — written to .rpiv/artifacts/plans/. Use when the user already has a finished design and wants it turned into build order, execution steps, or implementation phases to hand to implement — e.g. 'turn my design into phases', 'sequence the design into atomic steps', 'make an execution plan from the design doc'. Requires a design artifact as input. Prefer plan over blueprint for a straightforward phased breakdown when the design already exists. NOT for creating the architecture from scratch (design), a research-to-plan one-pass (blueprint), or understanding existing code (research).
argument-hint: "[design artifact path]"
shell-timeout: 10
---

# Plan

You are tasked with creating phased implementation plans from design artifacts. The design artifact contains all architectural decisions, full implementation code, and ordering constraints. Your job is to decompose that design into parallelized atomic phases with success criteria that implement can execute.

## Input

`$ARGUMENTS` — path to a design artifact (`.rpiv/artifacts/designs/*.md`).

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/skill-context.mjs" now git
```

- `now.mjs` (line 1) — `<iso>\t<slug>` tab-separated.

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Input → 2. Inherit phase boundaries from design's `## Slices` (1:1) → 3. Write plan (code from Architecture, Success Criteria pass through from `## Slices`) → 4. Independent Plan Review (code-reviewer + coverage-reviewer in parallel) → 5. Triage merged findings → 6. Follow-ups

The final artifact is implement-ready.

## Steps

### Step 1: Read Design Artifact

When this command is invoked:

1. **Determine input mode**:

   **Design artifact provided** (path to a `.md` file in `.rpiv/artifacts/designs/`):
   - Read the design artifact FULLY using the Read tool WITHOUT limit/offset
   - Extract: Architecture (the code changes), **`## Slices` (slice boundaries + per-slice Test Contracts + Success Criteria — authored by `/rpiv:design` Step 6.1, verified by slice-verifier at 6.2)**, File Map, Ordering Constraints, Verification Notes, Performance Considerations, Scope
   - These are the inputs for phasing. `## Slices` is the phase contract: each `### Slice N: {name}` becomes `## Phase N: {name}` with the same `**Files**:` list, the same Test Contract, and the same Success Criteria. No reauthoring.
   - Design decisions are settled — do not re-evaluate them
   - If the design has unresolved questions OR the `## Slices` section is missing/empty, STOP — tell the developer to return to design
   - If a behavior-changing slice lacks a `#### Test Contract:` (pre-TDD design), STOP — tell the developer to return to `/rpiv:design` (or retrofit via `/rpiv:revise` once a plan exists); do not author contracts here

   **No arguments provided**:
   ```
   I'll create an implementation plan from a design artifact. Please provide the path:

   `/rpiv:plan .rpiv/artifacts/designs/2025-01-20_09-30-00_feature.md`

   Run `/rpiv:design` first to produce the design artifact. There is no standalone path.
   ```
   Then wait for input.

2. **Read any additional files mentioned** in the design's References — research documents, tickets. Read them FULLY for context.

### Step 2: Inherit Phase Boundaries from `## Slices`

**Slice ≡ phase, 1:1.** Each `### Slice N: {name}` in the design's `## Slices` section becomes `## Phase N: {name}` in the plan. No recomposition: do not merge two slices into one phase, do not split a slice into multiple phases, do not reorder. The slice-verifier (design Step 6.2) already verified each slice's atomicity and cross-slice consistency with code + Success Criteria; recomposing here would discard that guarantee.

The design's Ordering Constraints and File Map are reference material — the slice ordering in `## Slices` already encodes them. Parallelism annotations (e.g., "Phases 2 and 3 can run in parallel after Phase 1") carry forward from the design's Ordering Constraints when slices have no inter-dependency.

Present the inherited phase structure as confirmation only (no recomposition options):

```
Inheriting {N} slices from `{design path}` as {N} phases (1:1):

## Implementation Phases:
1. {Slice 1 name} - {what it delivers} ({N} files)
2. {Slice 2 name} - {what it delivers} ({N} files)
3. {Slice 3 name} - {what it delivers} ({N} files)

Parallelism per design's Ordering Constraints: {e.g., "Phases 2 and 3 independent after Phase 1"}.
Total: {N} files across {M} phases. Test Contracts + Success Criteria pass through from design's `## Slices` unchanged.

Proceeding to write the plan artifact.
```

No developer question — boundary changes are out of scope for plan. If the developer wants different boundaries, they revisit `/rpiv:design` and re-decompose. (This guarantees blueprint-equivalent slice-verified atomicity throughout.)

### Step 3: Write Plan

Write the plan **incrementally** — skeleton first, then fill each phase. Code comes from the design's `## Architecture` (file-grouped); Test Contracts and Success Criteria come from the design's `## Slices` section **unchanged** — no reauthoring, no re-derivation from Verification Notes.

1. **Write the plan skeleton** to `.rpiv/artifacts/plans/<slug>_<description>.md` (use `<slug>` from the Metadata block's `now.mjs` line 1; copy `<iso>` verbatim into frontmatter `date:` and `last_updated:`).
   - Format: `<slug>_<description>.md` where:
     - `<slug>` comes from `now.mjs` (second tab-separated field on line 1)
     - description is a brief kebab-case description (may include ticket number)
   - Examples:
     - With ticket: `2025-01-08_14-30-00_ENG-1478-parent-child-tracking.md`
     - Without ticket: `2025-01-08_14-30-00_improve-error-handling.md`
   - The skeleton includes everything EXCEPT large code blocks: frontmatter, Overview, Desired End State, What We're NOT Doing, full phase structure (Overview, Changes Required with file paths and change summaries, **Test Contract and Success Criteria copied verbatim from design's `## Slices`**, parallelism annotations), Testing Strategy, Performance Considerations, References. Phase boundaries are inherited 1:1 from `## Slices` — no recomposition.

2. **Fill code blocks using Edit** — one phase at a time:
   - For each phase, Edit to insert the code blocks from the design's `## Architecture` section into the Changes Required subsections. Use the slice's `**Files**:` list (from the design's `## Slices`) to know which Architecture entries belong to which phase.
   - Test Contracts and Success Criteria for each phase are **already populated in the skeleton** from the design's matching `### Slice N` subsection — do not re-author. If the design's contract or criteria look wrong, that's a design defect; do not patch here.

3. **Use this template structure**:

```markdown
---
date: {Current date and time with timezone in ISO format}
author: {`author:` from Metadata block}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "{Feature/Task Name}"
tags: [plan, relevant-component-names]
status: in-progress
parent: "{path to design artifact}"
last_updated: {Same ISO timestamp as `date:` above}
last_updated_by: {`author:` from Metadata block}
---

# {Feature/Task Name} Implementation Plan

## Overview

{Brief description of what we're implementing and why. Reference design artifact.}

## Desired End State

{From design artifact's Desired End State / Summary — what "done" looks like and how to verify it}

## What We're NOT Doing

{From design artifact's Scope → Not Building}

## Phase 1: {Descriptive Name}

### Overview
{What this phase accomplishes}

### Changes Required:

#### 1. {Component/File Group}
**File**: `path/to/file.ext`
**Changes**: {Summary of changes}

```{language}
// Code from design artifact's Architecture section
```

### Test Contract:

{Copied verbatim from design's `### Slice N` → `#### Test Contract:` — the Behavior/Oracle/Expected-red entries (and TDD-exempt markers) slice-verifier already validated. Do NOT re-author here. `implement` transcribes each Behavior's Oracle into a failing test at red time; `validate` audits red->green evidence against it.}

- **Behavior**: {from design}
  - Test: `{test name}` -> `path/to/test-file.ext`
  - Oracle: {exact input -> expected-output values}
  - Expected red: {why it fails before this phase lands}
- **TDD-exempt**: `{item}` — {reason}

### Success Criteria:

{Copied verbatim from design's `### Slice N` subsection — same `- [ ]` bullets that slice-verifier (design 6.2) already validated against the slice's code. Do NOT re-author here.}

#### Automated Verification:
- [ ] {From design's `## Slices` → `### Slice N` → `#### Automated Verification:`}

#### Manual Verification:
- [ ] {From design's `## Slices` → `### Slice N` → `#### Manual Verification:`}

---

## Phase 2: {Descriptive Name}

{Similar structure with both automated and manual success criteria...}

---

## Testing Strategy

{Informational only — the load-bearing test spec is each phase's `### Test Contract:` (what implement executes red->green) and `### Success Criteria:` (what implement checks off and validate runs).}

### Automated:
- {Standard project checks from success criteria}

### Manual Testing Steps:
1. {From design's Verification Notes — listed as manual testing steps for reference; not load-bearing for verification since design's `## Slices` Success Criteria already encode the per-phase manual checks}
2. {Another reference step}

## Performance Considerations

{From design artifact — copied directly}

## Migration Notes

{From design artifact — copied directly. If applicable: schema changes, data migration, rollback strategy, backwards compatibility. Empty if not applicable.}

## Developer Context

{Empty at skeleton write; Step 4.4 fallback notes and any post-write developer interactions land here.}

## References

- Design: `.rpiv/artifacts/designs/{file}.md`
- Research: `.rpiv/artifacts/research/{file}.md`
- Original ticket: `thoughts/me/tickets/{file}.md`
```

### Step 4: Independent Plan Review

After Step 3 finalizes the artifact, dispatch two independent review subagents in parallel — one to walk every Phase code fence, one to walk every verification intent — both against the live codebase at HEAD. This is the single post-finalization quality gate for the entire `design → plan` pipeline: code review was deliberately deferred from design to here, where code + Success Criteria + phasing are all visible in one artifact for joint review (blueprint-equivalent topology). The reviewers surface findings once; applying them is Step 5's developer-triaged work. Re-dispatch the pair only if Step 5 triage applied fixes so substantial that the reviewed artifact no longer resembles what the reviewers saw (at most 2 re-dispatches).

#### 4.0. Flip status to in-review

Before dispatching the reviewers, Edit frontmatter `status: in-progress` → `status: in-review` (Step 5 flips to `ready` after triage — keeps consumers off an artifact still being edited).

#### 4.1–4.4. Dispatch, persist, tally, failure handling

Run the shared reviewer-dispatch protocol in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/artifact-review-dispatch.md` (identical for plan and blueprint). Substitute: **write-step = Step 3** (reuse that `Write` `file_path`), **review-step = Step 4** (heading `## Plan Review (Step 4)`), **triage-step = Step 5**. It covers the parallel `artifact-code-reviewer` + `artifact-coverage-reviewer` dispatch, the merged `## Plan Review` table format + sort rules, the severity tally, and per-agent failure handling. Do NOT auto-apply any finding — triage is the developer's call at Step 5.

### Step 5: Review & Iterate

1. **Triage Step 4 reviewer findings first** (skip if Step 4 returned no findings):

   Present the Plan Review table from Step 4 to the developer with severity-grouped framing:

   ```
   Plan-reviewer findings: {B} blockers, {C} concerns, {S} suggestions

   Triage each row before the freeform review below:
   - applied — change made; I'll Edit per the recommendation target (Phase code fence for code findings, `### Success Criteria:` block for coverage findings) and fill the row's resolution as `applied: {one-line summary}`
   - deferred — noted but not fixing now; resolution cites why (e.g., "out of scope for this plan", "follow-up commit")
   - dismissed — not a real issue; resolution explains why the reviewer was wrong (e.g., "X is intentional because Y")
   ```

   Use `ask_user_question` with options "applied / deferred / dismissed":
   - **applied**: Edit per the recommendation target — if the recommendation names a `## Phase N` code fence, Edit that fence; if it names a `### Success Criteria:` bullet, Edit that block; if it names both, Edit both. Routing follows the recommendation text, not the `source` column. Fill `resolution`.
   - **deferred** / **dismissed**: fill `resolution` with the reason.

   **Code finding caveat**: when a code finding's root cause is in the design's Architecture (not just plan transcription), the patch belongs upstream. Either (a) Edit the design artifact and re-run `/rpiv:plan`, or (b) apply the fix to the plan's Phase code fence and annotate the resolution with `applied (plan-local; design follow-up: <design path>)`. Option (a) is cleaner; option (b) is acceptable for tactical fixes.

   **Order and batching**: blockers sequentially (resolution may invalidate later rows). Concerns and suggestions: batch up to 4 independent rows per `ask_user_question` call. Independent = different files / different intents AND neither recommendation references the other's location; otherwise sequential.

2. **Lint, then flip status to ready**: once every row has a `resolution` (or the table is empty per Step 4's no-findings / failure-fallback path):
   - **Finalization lint**: run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <the plan artifact path> --finalizing --stamp`. If it exits non-zero, FIX the errors and re-run — never flip on a failing lint. On success it stamps `content_hash:` (last body-affecting action). (Plan passes design's decisions through unchanged, so it does not promote standing decisions — design already did at its finalization.)
   - **Flip**: Edit frontmatter `status: in-review` → `status: ready`. Artifact is now implement-ready.

3. **Present the plan location** (after triage is complete):
   ```
   Implementation plan written to:
   `.rpiv/artifacts/plans/{filename}.md`

   {N} phases, {M} total file changes. {T} reviewer findings triaged at Step 5 ({A} applied, {D} deferred, {DD} dismissed). If either reviewer hit Step 4.4's per-agent failure-fallback, render this line as `Step 4 {code|coverage|both} review unavailable — proceeded with available findings.`

   Please review:
   - Are the phases properly scoped for worktree execution?
   - Are the success criteria specific enough?
   - Any phase that should be split or merged?

   ---

   💬 Follow-up: describe the change in chat to append a timestamped Follow-up section to this artifact, or use `/rpiv:revise <plan-path>` for surgical phase edits. Re-run `/rpiv:plan` for a fresh artifact.

   **Next step:** `/rpiv:implement .rpiv/artifacts/plans/{filename}.md Phase 1` — start execution at Phase 1 (omit `Phase 1` to run all phases sequentially).

   > 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
   ```

### Step 6: Handle Follow-ups

- **Edit in-place.** Use the Edit tool to update the plan artifact directly. Phase numbering stays stable when possible — renumber only when a phase is split or merged.
- **Bump frontmatter.** Update `last_updated` + `last_updated_by`; set `last_updated_note: "<one-line summary>"`.
- **Phase-level moves.** Split large phases, merge small phases, adjust success criteria, reorder phases — all in-place. Continue refining until the developer is satisfied.
- **When to re-invoke instead.** For surgical edits driven by review findings, prefer `/rpiv:revise <plan-path>`. Re-run `/rpiv:plan` only when the underlying design changed materially. The previous block's `Next step:` stays valid for the existing plan.

## Guidelines

1. **Trust the Design**:
   - Design decisions are fixed — do not re-evaluate architectural choices
   - Test Contracts and Success Criteria are also fixed — pass them through verbatim from design's `## Slices`; do not re-author, re-derive, or "improve" them. Slice-verifier already validated them against the slice's code at design 6.2
   - Phase boundaries are fixed — inherit 1:1 from design's `## Slices`; do not recompose
   - If something in the design seems wrong, flag it to the developer; do not silently patch in plan
   - The design is the source of truth for what to build

2. **Pass-Through, Not Author**:
   - Plan transforms a design artifact into phased shape; it does not invent content
   - Code blocks in `## Phase N` come from the design's `## Architecture` entries
   - Test Contracts and Success Criteria come from the design's `## Slices` `### Slice N` subsections, unchanged
   - The only place plan exercises judgment is Step 5 triage of reviewer findings — and even there, design-root-cause findings should route back to `/rpiv:design`

3. **Be Practical**:
   - Focus on incremental, testable changes
   - Each phase should leave the codebase in a working state
   - Think about what can be verified independently
   - Include "what we're NOT doing" from the design's scope

4. **Phase for Worktrees**:
   - Each phase should be implementable in an isolated worktree
   - No phase should depend on another phase's uncommitted changes
   - The design already encoded worktree-sized slices via its decomposition + slice-verifier; trust it
   - Do not split or merge phase boundaries inside plan

5. **Track Progress**:
   - Use a todo list to track planning tasks
   - Mark planning tasks complete when done

6. **No Open Questions in Final Plan**:
   - If you encounter open questions during planning, STOP
   - If the design artifact has unresolved questions OR a missing `## Slices` section, send the developer back to design
   - Do NOT write the plan with unresolved questions
   - The implementation plan must be complete and actionable

## Success Criteria — Format Reference

Success Criteria are **authored upstream in `/rpiv:design` Step 6.1** and verified by slice-verifier at design 6.2. Plan copies them through from the design's `## Slices` section into each phase's `### Success Criteria:` block **unchanged**. The reference below is for understanding the expected shape, not for authoring inside plan.

**Two categories, same shape design produces:**

1. **Automated Verification** (run by execution agents): commands like `make test` / `npm run lint`; file-existence checks; type checking; test suites.
2. **Manual Verification** (requires human): UI/UX, real-conditions performance, hard-to-automate edge cases, UAT.

**Format example:**
```markdown
### Success Criteria:

#### Automated Verification:
- [ ] Database migration runs successfully: `make migrate`
- [ ] All unit tests pass: `go test ./...`
- [ ] No linting errors: `golangci-lint run`
- [ ] API endpoint returns 200: `curl localhost:8080/api/new-endpoint`

#### Manual Verification:
- [ ] New feature appears correctly in the UI
- [ ] Performance is acceptable with 1000+ items
- [ ] Error messages are user-friendly
- [ ] Feature works correctly on mobile devices
```

If the design's criteria don't match this shape, the defect lives upstream — return to `/rpiv:design` to fix, do not patch in plan.

## Test Contract — Format Reference

Test Contracts are **authored upstream in `/rpiv:design` Step 6.1** (per slice) and verified by slice-verifier at design 6.2 against the standing TDD decision. Plan copies them through into each phase's `### Test Contract:` block **unchanged**. The reference below is for understanding the expected shape, not for authoring inside plan.

```markdown
### Test Contract:
- **Behavior**: {the behavior this phase must prove, one sentence}
  - Test: `{test name}` -> `path/to/test-file.ext`
  - Oracle: {exact input -> expected-output values — strongest checkable; concrete values, not shapes}
  - Expected red: {why this test fails before this phase's code lands}
- **TDD-exempt**: `{item}` — {reason}
```

Downstream consumption: `implement` transcribes each Behavior's Oracle into a failing test (red), observes the Expected red reason, implements to green, and records evidence; `validate` audits that evidence. If a contract is missing or oracle-less, the defect lives upstream — return to `/rpiv:design`, do not patch in plan.

## Subagent Usage

| Context | Agents Spawned |
|---|---|
| Step 4 post-finalization code review (mandatory) | artifact-code-reviewer |
| Step 4 post-finalization coverage review (mandatory) | artifact-coverage-reviewer |

Both reviewers dispatch in parallel against the final artifact (code + Success Criteria + phasing all visible). This is the single quality gate for the entire `design → plan` pipeline — design owns no post-finalization review.

## Important Notes

- NEVER edit source files — this skill produces a plan document, not implementation
- Always read the design artifact FULLY before inheriting phase boundaries
- The plan template must be compatible with implement — preserve the phase/success criteria structure
- If the design artifact has unresolved questions OR is missing its `## Slices` section, STOP — send the developer back to design
- **Slice ≡ phase, 1:1**: NEVER recompose slice boundaries into different phase boundaries; NEVER reauthor Test Contracts or Success Criteria (both pass through from design's `## Slices`); slice-verifier in design Step 6.2 already guaranteed per-slice atomicity and contract/criteria/code alignment, and recomposing here would discard that guarantee
- **Contract-less designs STOP**: a behavior-changing slice without a `#### Test Contract:` is a pre-TDD design — send the developer back to `/rpiv:design`; plan never authors contracts (pass-through constitution)
- ALWAYS dispatch artifact-code-reviewer AND artifact-coverage-reviewer in parallel at Step 4 after Step 3 finalize, BEFORE the developer review at Step 5
- NEVER auto-apply a Step 4 reviewer finding; triage is the developer's call at Step 5
- ALWAYS hold `status: in-review` from Step 4.0 through Step 5; flip to `ready` only after every row has a `resolution` (or the table is empty)
- Code in the plan comes from the design artifact's Architecture section — do not invent new code
- **Frontmatter consistency**: Always include frontmatter, use snake_case for multi-word fields, keep tags relevant
