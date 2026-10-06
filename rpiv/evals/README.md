# rpiv skill + agent evals (git-anchored, executable)

Real-project evals for review skills/agents and document-only design
and plan cases. This harness replaced an earlier stub eval set whose
fixtures never existed and whose assertions were prose ("the evals are theater",
handoff 2026-07-08). The design principle: **an assertion either executes or it
doesn't exist**. Historical defect ground truth comes from human-validated fixes.
The current intent cases instead use explicitly authored approved-intent scenarios
on real source; these are contract probes, not previously observed candidate defects.

## Why git-anchored instead of synthetic fixtures

- A hand-built 5-file "god module" fixture is a toy: any skill version aces it, so it
  never discriminates. The hard part of a review skill is precision at realistic scale.
- GymApp's history contains **human-validated ground truth**: the 2026-06-29
  lib-generation architecture review's findings were subsequently fixed in implemented
  phases (`load-cap.ts`, unified clamp fork, shared snapshot projection). A worktree
  pinned at `96e3553` (pre-fix) is a recall fixture; HEAD (`b460257`) is an absence
  fixture (don't re-report the fixed).
- Planted defects sit on top of real code: DR-1 re-introduces the repo's #1 failure
  class (producer/consumer contract divergence — an operator-precedence bug in an
  inlined load-cap formula), DR-3 adds an enum-ish variant wired everywhere except one
  non-exhaustive consumer (`default:` swallows it).

## Layout

```
evals/
  README.md                 <- this file
  harness/
    extract-ground-truth.mjs  parse a past review artifact -> ground-truth JSON (git show verbatims, fixed-at-HEAD signals)
    gen-agent-inputs.mjs      render EM-*/IS-* prompts from frozen seeds + ground truth
    grade-artifact.mjs        the mechanical grader (all executable checks)
    grade-artifact.test.mjs   golden tests for the grader (node grade-artifact.test.mjs)
    run-eval.mjs              worktree fixture setup + headless `claude -p` + timing + grading
  cases/
    deep-review/        DR-1..3 (.json specs + patches/)
    architectural-review/ AR-1..2
    entity-mapper/      EM-1..2 (.json + rendered .prompt.md)
    interaction-sweeper/ IS-1..2
    design/             DS-1 (lean design from an approved scenario brief)
    plan/               PL-1 (optional scheduling projection, canonical links)
    slice-verifier/     SV-1..2 (current three-row intent recall/restraint)
    artifact-code-reviewer/ ACR-1..2 (current intent recall/restraint)
    artifact-coverage-reviewer/ ACV-1..2 (current intent coverage/working notes)
    _fixtures/          current lean briefs/contracts plus untouched historical inputs
    ground-truth/       extracted JSON + frozen metrics.mjs seeds (provenance)
  legacy/fence-comparisons/   archived manifests/prompts, NOT an active default suite
```

Worktrees (pinned, detached; created via `git -C <GymApp> worktree add --detach`):
`C:/Users/pedro/Documents/GymApp-evals/wt-96e3553` (pre-fix ref), `wt-head` (b460257),
`wt-dr1`, `wt-dr3` (b460257 + planted uncommitted patch).

Run workspace (outputs, per skill-creator conventions):
`C:/Users/pedro/rpiv-claude/skill-evals/iteration-N/<CASE>/with_skill/`.

## Running

```bash
node evals/harness/run-eval.mjs --case evals/cases/deep-review/DR-1.json \
  --rundir C:/Users/pedro/rpiv-claude/skill-evals/iteration-1/DR-1/with_skill
```

**Do not run model evals merely to validate eval edits.** The standalone grader
test is the safe local check: `node evals/harness/grade-artifact.test.mjs`.

The runner wipes the case's listed output directories, seeds/overwrites fixture
documents, and invokes `claude -p` with **`--dangerously-skip-permissions`**. A
worktree is **not a command sandbox**: Git metadata/refs are shared, and processes
retain host filesystem, credential, network, and database access. Permission
bypass does not confine commands or authorize external effects. Model runs require
separate explicit consent and an appropriately isolated environment with no real
secrets/services, protected user work, and bounded permitted effects. Prompt riders
are behavioral instructions, not enforcement. Do not parallelize cases against a
shared mutable fixture worktree.

The runner captures timing/tokens/cost, locates the produced artifact, and runs
the grader. Cost tiers: agent cases are cheap
(single-agent), DR cases moderate (bounded diffs), AR cases expensive (full skill on a
~27-file module) — don't re-run AR on every tweak; agent evals are the fast loop.

## Contamination controls

- `.rpiv/artifacts` is gitignored in GymApp -> pinned worktrees contain NO past review
  artifacts (the ground truth answers never exist inside an eval worktree).
- Worktree paths differ from the real project path, so context-mode's per-project
  knowledge base from the user's real sessions does not attach.
- Current reviewer wrappers seed only the selected brief, normative contract, and
  parent protocol, not grading answers or the alternative scenario. Do not read old
  outputs or alternate fixtures left by another run. Use fresh isolated fixtures
  for explicitly authorized runs; this unchanged runner is not an isolation guard.
- DS-1/PL-1 provide bounded intent-only answers, never blanket autopilot
  checkpoint/triage approval. New questions or failed/missing reviews stay blocked.
  Legacy checkpoint riders are not current build or integration authorization.
- `node_modules` is junctioned from the main GymApp checkout (arch-review ingests the
  repo's own linters). Dep versions are HEAD's, even in the 96e3553 worktree — a known,
  accepted approximation.

## Design lesson: negative controls in a real codebase

IS-2 originally asserted "exactly zero compounds" over five hand-curated 'independent'
findings. Four curation rounds each produced a set with a REAL (or accidentally
planted) coupling, which the sweeper grounded legitimately — in one cohesive app,
everything genuinely shares something, and a determined re-reader will find it. The
eval was redesigned to measure what actually separates bad from good under pressure:
a hard compound cap, explicit rejection reasoning for non-grouped findings, the
grounded-compound contract, and grader-model admission-test adjudication as the
semantic stage. If you need a true zero-interaction fixture, you must construct
independence synthetically — you cannot curate it out of a living repo.

## Grading model

Mechanical (grade-artifact.mjs, always): citation resolvability + line validity,
verbatim-quote greppability, validate-artifact.mjs pass, recall (file+line-window),
absence (pair+pattern within one finding unit), frontmatter numerics, compound
contracts (>=2 distinct-file cites, constituents subset), exact no-interaction
response, over-flag ceilings, and opt-in current intent-review integrity.

`checks.current_review` is used by every current SV/ACR/ACV case. It declares
`mode: intent`, `format: slice-rows` or `findings-table`, the exact `artifact_path`,
`slice_id`, and all `inputs` (brief, complete normative contract, scoped source).
The case `ref` is the resolved full SHA, not a guessed placeholder. The parent
wrapper independently resolves and checks the real baseline before/after review,
records commands and SHA-256 hashes in a separate evidence file, and supplies
read-only Git evidence to reviewers that cannot run Git themselves. See
`cases/_fixtures/intent-review-protocol.md` for the report fields and ownership.

The grader checks mode, repository/artifact/slice/base binding, input digests against
current raw bytes, recorded unchanged identity and completed inspection, a valid
outcome, and complete role output. SV has exactly Decisions / Cross-slice / Research;
the pair has the six-column findings table. A header alone, missing summary row, or
unavailable/broken/pending/stale/incomplete report fails integrity and cannot earn
restraint, absence, vocabulary, or finding-ceiling credit. Completed inspection with
identified findings (`outcome: failed`) is distinct from broken execution. A genuine
clean review may have the two-line empty table only with the full binding/completion
record. The existing grading JSON schema and non-opt-in check behavior are preserved.

Historical four-row Correctness experiments (including SV-3) and fence-walking
ACR comparisons live under `legacy/fence-comparisons/` for archived-output regrading.
Their prompts/manifests and original frozen inputs are retained, not active defaults.
Do not mix legacy metrics with the current contract or format the frozen inputs.

DS-1 expects lean Intent/Architecture/Next Slice/Test Contracts/Deferred Work headings.
PL-1 projects one active phase from a brief without requiring a
design; contracts stay at their owner, and build approval pending leaves its
unresolved count at one. Its output distinguishes intent readiness from build
authority. No case requires implementation bodies or a 1:1 slice mapping.

Semantic (grader model, second stage): does the matched finding actually describe the
known defect; does an IS-1 compound reproduce the IX-1/IX-5-shaped groupings. Semantic
grades never override mechanical fails.

**Proof limits:** these static/prompt evals provide no real end-to-end workflow
proof. Matching hashes and report fields cannot prove a reviewer actually inspected
every dependency; the grader does not independently replay Git preparation, validate
candidate snapshots, or verify the parent's evidence transcript. Planning checks
recognize links/headings/counters, not all semantic contract equivalence. These
intent cases do not demonstrate real red-green execution, candidate-mode review,
workspace isolation, human acceptance, or integration safety. Those require a
separately authorized runtime journey. No real model eval is needed for grader tests.

## Refreshing ground truth

If GymApp history moves on, re-run:

```bash
node evals/harness/extract-ground-truth.mjs --artifact <past-review.md> \
  --repo C:/Users/pedro/Documents/GymApp --ref <sha> --target <paths> --out cases/ground-truth/<name>.json
node evals/harness/gen-agent-inputs.mjs
```

and re-curate the recall/absence lists in the case specs (curation is deliberate —
extractor output is signals, not assertions).
