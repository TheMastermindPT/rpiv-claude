# rpiv skill + agent evals (git-anchored, executable)

Real-project evals for `deep-review`, `architectural-review`, and the `entity-mapper` /
`interaction-sweeper` agents. This harness replaced an earlier stub eval set whose
fixtures never existed and whose assertions were prose ("the evals are theater",
handoff 2026-07-08). The design principle: **an assertion either executes or it
doesn't exist**, and **ground truth is something a human validated, not something we
authored to be found**.

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
    run-eval.mjs              worktree isolation + headless `claude -p` + timing + grading
  cases/
    deep-review/        DR-1..3 (.json specs + patches/)
    architectural-review/ AR-1..2
    entity-mapper/      EM-1..2 (.json + rendered .prompt.md)
    interaction-sweeper/ IS-1..2
    ground-truth/       extracted JSON + frozen metrics.mjs seeds (provenance)
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

The runner wipes prior review artifacts from the worktree, invokes `claude -p` there
(model `fable` by default, `--output-format json`, **`--dangerously-skip-permissions`**
— the run is confined to a throwaway worktree), captures timing/tokens/cost, locates
the produced artifact, and runs the grader. Cost tiers: agent cases are cheap
(single-agent), DR cases moderate (bounded diffs), AR cases expensive (full skill on a
~27-file module) — don't re-run AR on every tweak; agent evals are the fast loop.

## Contamination controls

- `.rpiv/artifacts` is gitignored in GymApp -> pinned worktrees contain NO past review
  artifacts (the ground truth answers never exist inside an eval worktree).
- Worktree paths differ from the real project path, so context-mode's per-project
  knowledge base from the user's real sessions does not attach.
- Eval prompts describe intent like a real user would; they never name the expected
  findings. The non-interactive rider ("pick the recommended option at checkpoints")
  is harness scaffolding applied identically to every version being compared.
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
response, over-flag ceilings.

Semantic (grader model, second stage): does the matched finding actually describe the
known defect; does an IS-1 compound reproduce the IX-1/IX-5-shaped groupings. Semantic
grades never override mechanical fails.

## Refreshing ground truth

If GymApp history moves on, re-run:

```bash
node evals/harness/extract-ground-truth.mjs --artifact <past-review.md> \
  --repo C:/Users/pedro/Documents/GymApp --ref <sha> --target <paths> --out cases/ground-truth/<name>.json
node evals/harness/gen-agent-inputs.mjs
```

and re-curate the recall/absence lists in the case specs (curation is deliberate —
extractor output is signals, not assertions).
