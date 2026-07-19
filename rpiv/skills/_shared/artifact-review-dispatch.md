# Independent Artifact Review — reviewer dispatch, persist, tally, failure

Shared post-finalization review protocol for `plan` and `blueprint`. Both dispatch the same reviewer pair against the finalized artifact at HEAD and persist an identical `## Plan Review` table, then hand the findings to a developer triage step. The two skills differ only in which numbered step does the Write, the review, and the triage — so the calling skill supplies three references when it runs this protocol:

- **write-step** — where the skill wrote the artifact (plan: Step 3; blueprint: Step 5). Reuse that exact `Write` `file_path` verbatim — the runtime already resolved it for this platform; do not rebuild from `pwd`.
- **review-step** — this review step (plan: Step 4; blueprint: Step 8). Names the `## Plan Review (<review-step>)` heading and the failure notes.
- **triage-step** — where findings are triaged (plan: Step 5; blueprint: Step 9). The `resolution` column is filled there.

Substitute those three values wherever this file writes `<write-step>` / `<review-step>` / `<triage-step>`.

## 1. Dispatch the reviewer pair (parallel)

`ls` the write-step `file_path` to verify it still exists; abort dispatch on miss. Send both Agent calls in a single assistant message so they run in parallel:

```
Agent({
  subagent_type: "artifact-code-reviewer",
  description: "post-finalization plan code review",
  prompt: `Plan artifact: {<write-step> Write file_path, ls-verified}

Review the finalized plan against the live codebase at HEAD. Walk every Phase code fence, audit against code-quality / codebase-fit / actionability, emit one severity-tagged row per finding.`
})

Agent({
  subagent_type: "artifact-coverage-reviewer",
  description: "post-finalization plan coverage review",
  prompt: `Plan artifact: {<write-step> Write file_path, ls-verified}

Review the finalized plan's verification-intent coverage. Walk every ## Verification Notes and ## Precedents & Lessons entry; for each, verify it lands in either a phase's ### Success Criteria: bullet or as a visible code mirror. Emit one severity-tagged row per uncovered entry.`
})
```

## 2. Persist the merged review table

Each agent returns a markdown table with columns `plan-loc | codebase-loc | severity | dimension | finding | recommendation`. Merge both tables into one section, prepending a `source` column (`code` for artifact-code-reviewer rows, `coverage` for artifact-coverage-reviewer rows) and appending a `resolution` column (initially blank, filled progressively at the triage-step):

```markdown
## Plan Review (<review-step>)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at <triage-step>._

| source   | plan-loc          | codebase-loc                | severity   | dimension             | finding   | recommendation   | resolution                  |
| -------- | ----------------- | --------------------------- | ---------- | --------------------- | --------- | ---------------- | --------------------------- |
| code     | {plan-loc}        | {codebase-loc}              | {severity} | {dimension}           | {finding} | {recommendation} | (filled at <triage-step>)   |
| coverage | {plan-loc}        | <n/a>                       | {severity} | verification-coverage | {finding} | {recommendation} | (filled at <triage-step>)   |
| ...      |                   |                             |            |                       |           |                  |                             |
```

Sort merged rows by severity first (blocker → concern → suggestion), then by source (`code` before `coverage` for stable ordering within a severity). Within a `(severity, source)` bucket, preserve each agent's own emitted order — do not re-sort across source spaces (the two agents key on different artifact loci: `Phase N §M` for code, `## Verification Notes §K` for coverage).

If both agents emit zero rows, still emit the section with a single line: `_No findings — both reviewers cleared the artifact._`. Persistence is mandatory regardless of finding count — the section is the durable audit trail.

## 3. Tally findings for the triage-step's prompt

Count merged rows by severity. Store the counts in main context for the triage-step's developer prompt:

```
{B} blockers, {C} concerns, {S} suggestions
```

Do NOT auto-apply any finding. The orchestrator never makes the apply / defer / dismiss judgment alone — that lives with the developer at the triage-step. The reviewers' role is to surface; the developer's role is to triage.

## 4. Failure handling

Per-agent: if one reviewer errors out (subprocess crash, malformed output, timeout) and the other succeeds, persist the successful agent's rows and append a one-line failure note for the missing source. If both fail, append the failure note alone.

- Successful side: persist its rows as in section 2.
- Failed side: append `_<review-step> {code|coverage} review failed: {one-line cause}._` under the `## Plan Review (<review-step>)` heading.
- Record any failure in `## Developer Context`: `<review-step> {code|coverage} review unavailable; proceeded to developer review without {agent-name} findings.`
- Proceed to the triage-step regardless.

The 8-column header is retained when only one source returns; only rows from the failing agent are absent. The triage-step iterates whatever rows are present.
