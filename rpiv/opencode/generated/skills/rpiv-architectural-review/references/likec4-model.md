# LikeC4 Model Emission (Step 4.5 — current state; Step 11 — end state)

The System Model (Step 2.7) and the polish plan (Step 11) are translated into a LikeC4 architecture-as-code project so the developer can SEE the reviewed architecture — and the aimed-at end state — as interactive diagrams. The emission is **additive and non-blocking**: it never gates the review, never adds a checkpoint, and degrades to a one-line note when the `likec4` CLI is unavailable.

Two gated passes read this file:
- **Step 4.5** (right after the skeleton) — emit the **current-state** model. Gate: a System Model exists (Step 2.7 not gate-skipped).
- **Step 11** (after the phase plan is approved, before the citation gate) — append **fate tags + end-state/per-phase views**. Gate: Step 4.5 emitted a model.

If the `likec4-dsl` skill is available in this session, defer to it for any style/predicate token not shown verbatim below — the fallback contract here deliberately uses only the tokens it spells out. The validate loop is the arbiter either way.

## Where the model lives (project isolation — load-bearing)

Write a sibling DIRECTORY of the artifact, never loose `.c4` files:

```
.rpiv/artifacts/architecture-reviews/<slug>_<target-kebab>-model/
  likec4.config.json
  spec.c4
  model.c4
  views.c4
```

`likec4.config.json` (write FIRST):

```json
{
  "$schema": "https://likec4.dev/schemas/config.json",
  "name": "arch-review-<slug>",
  "title": "Arch Review — <target>"
}
```

The config makes this directory its **own LikeC4 project**: LikeC4 scopes files to the nearest config in the directory hierarchy, so the review's model can NEVER merge into a LikeC4 project the target repo already has (top-level blocks merge across all files of one project — without this config, a repo with its own `.c4` files would swallow ours). `name` uses the run `<slug>`, so successive reviews of the same target coexist as distinct projects. Never write `.c4` files into the target source tree — the artifact directory is the only destination (same rule as every other review output).

## Identifier sanitization

LikeC4 identifiers allow letters, digits, hyphens, underscores — **no dots** (dots are FQN separators), no leading digit. Derive every identifier from the System Model name: lowercase, replace every other character run with `-`, prefix with `e-` if it would start with a digit (`WeeklyPlan` → `weekly-plan`, `adaptive-context.ts` → `adaptive-context-ts`). On collision append `-2`, `-3`. Keep a name→identifier table in working memory — Step 11 extends these elements by FQN and a re-derived mismatch breaks the `extend`.

## spec.c4 (Step 4.5)

```likec4
specification {
  element entity {
    style { shape rectangle }
  }
  element stage {
    style { color muted; size small }
  }
  tag ownerless
  tag planned
  tag to-remove
  tag to-refactor
}
```

Declared once; phase tags are appended at Step 11. Do not invent further kinds — `entity` + `stage` is the whole vocabulary (layers are views, not elements).

## model.c4 (Step 4.5) — translation contract

One top-level `entity` element per System Model entity; its lifecycle stages as nested `stage` children; cross-entity edges as top-level relationships.

| System Model | LikeC4 |
|---|---|
| Entity | top-level `<id> = entity '<Name>'` |
| Architecture style (CRUD/CQRS/event-driven/pipeline/hex) | `technology '<style>'` on the entity |
| Lifecycle stage | nested `<stage-id> = stage '<STAGE NAME>'` |
| Stage's `file:line` cites | `metadata { sources '<path>; <path>' }` — **repo-relative from the repository root**, the same path discipline as every artifact cite |
| Owner (single) | `metadata { owner '<path>' }` on the entity |
| `owner: NONE` | `metadata { owner 'NONE' }` **plus tag `#ownerless`** on the entity |
| Cross-entity edge | top-level `<a> -> <b> '<verb from the model>'` |
| Pipeline stage order | sibling edges `<stage-a> -> <stage-b>` (pipeline-style entities only) |

Rules: tags come first in an element body, then properties, then nested elements. Parent→child relationships are forbidden in LikeC4 — containment IS the nesting; never emit `entity -> its-own-stage`. Cross-file/full references use FQNs (`weekly-plan.read`).

Example shape:

```likec4
model {
  weekly-plan = entity 'WeeklyPlan' {
    #ownerless
    technology 'CRUD'
    metadata {
      owner 'NONE — writes in lib/admin/coverage.ts + lib/system/generation-persistence.ts'
    }
    wp-read = stage 'READ' {
      metadata { sources 'lib/db/weekly-plans.ts' }
    }
    wp-write = stage 'WRITE' {
      metadata { sources 'lib/admin/coverage.ts; lib/system/generation-persistence.ts' }
    }
  }
  weekly-plan -> exercise-catalog 'consumes'
}
```

## views.c4 (Step 4.5) — current state

```likec4
views {
  view index {
    title 'Current architecture — <target>'
    include *
    exclude * where tag is #planned
    autoLayout TopBottom
  }
  view entity-<id> of <id> {
    title '<Name> — lifecycle'
    include *
    exclude * where tag is #planned
    autoLayout LeftRight
  }
}
```

One scoped `view entity-<id> of <id>` per entity. The `#planned` exclude is baked in NOW (it matches nothing yet) so Step 11 stays append-only.

## Validate loop (deterministic gate, non-blocking)

After writing (and again after every Step 11 append):

```bash
npx likec4 validate --json --no-layout --file spec.c4 --file model.c4 --file views.c4 "<model-dir>"
```

Parse the JSON: `filteredErrors` must be 0 — fix each reported `file`/`line` and re-run (never `likec4 check`/`lint`; `--file` repeats once per source file). **Degradation:** if `npx`/`likec4` is unavailable, errors out, or exceeds ~90s (first run downloads the package), write the model files anyway, note `LikeC4 model: emitted, validation unavailable` in the artifact, and continue — no checkpoint, the review never pauses for this.

## Artifact linkage (Step 4.5, after validation)

1. Frontmatter: set `likec4_model:` to the model directory repo-relative (the template carries the field; `none` when emission was skipped).
2. Under the `## System Model` heading, add one line:
   `> Interactive model: <model-dir> — preview with npx likec4 start "<model-dir>"`

## Step 11 — fate tags and end-state views (append-only)

After the phase plan is confirmed, translate finding outcomes into fates. Never rewrite the Step 4.5 blocks — every Step 11 change is an appended block (top-level blocks merge within the project).

1. **Append phase tags** to `spec.c4` (new block at end of file):

   ```likec4
   specification {
     tag phase-1
     tag phase-2
   }
   ```

   One tag per phase in the approved plan.

2. **Append fates** to `model.c4` (one `extend` per touched element, matched via the identifier table):
   - Accepted finding touches an entity/stage → `extend <fqn> { #to-refactor #phase-<n> }`
   - Accepted deletion (dead abstraction, `to-remove` outcome) → `extend <fqn> { #to-remove #phase-<n> }`
   - G-lens named extractable units and M-lens named abstractions that the plan creates → NEW nested elements under their entity, tagged planned:

   ```likec4
   model {
     extend weekly-plan {
       wp-validation = stage 'validation (planned split)' {
         #planned #phase-1
         metadata { sources 'planned — extracted from lib/generation/plan-generation/service.ts' }
       }
     }
   }
   ```

   Wire planned elements with the edges the plan describes (planned→existing edges are fine).

3. **Append end-state + per-phase views** to `views.c4`:

   ```likec4
   views {
     view end-state {
       title 'End state — after polish plan'
       include *
       exclude * where tag is #to-remove
       autoLayout TopBottom
     }
     view phase-1 {
       title 'Phase 1 — <phase title>'
       include * where tag is #phase-1
       autoLayout TopBottom
     }
   }
   ```

   `end-state` keeps `#planned` elements (they exist after the plan) and drops `#to-remove`; the `index` view keeps showing today's architecture. One `phase-<n>` view per phase.

4. **Re-run the validate loop.** Then Step 12's present block adds:
   `Model:        <model-dir> — npx likec4 start "<model-dir>" (index = current · end-state · phase views)`

## Adoption deliverables (Step 11, gated on Step 2.2 conformance)

Same discipline as the dependency-cruiser deliverable: merge, never replace; the phase body carries the concrete change.

- **Repo HAS a declared model and `C4-` rows were accepted** → add an "Update the declared architecture model" deliverable to the fitting phase (usually Foundation or the phase that fixes the breach). The deliverable body lists, per accepted finding: the relationship to APPEND (a `C4-undoc-` edge the developer accepted as legitimate — the doc was stale), the relationship to RETIRE (a `C4-aspir-` edge with no code behind it), or the code fix (a `C4-undoc-` edge the developer rejected as a breach — the plan fixes the code, the model stays). Always include the mapping annotation: `extend <fqn> { metadata { dir '<path>' } }` for every element the orchestrator had to hand-map — the next review's `--map` becomes free.
- **Repo declares NO model** → offer an "Adopt an architecture model" deliverable: copy the emitted model project (Step 4.5 dir) into the repo (suggest `docs/architecture/` or the repo root) as the starting declared model, with its `likec4.config.json` renamed to a stable project `name` (not the run slug). The developer judges adoption — never copy without the deliverable being accepted in the plan.

## Model drift (Step 8, gated on BOTH reviews having emitted models)

When the prior review's frontmatter `likec4_model:` names a directory that still exists AND this run emitted a model: export both to JSON (`npx -y likec4 export json -o <scratchpad>/c4-prior.json "<prior-dir>"`, same for current) and diff **inline** (orchestrator set-arithmetic, no agent):

- Entity drift: FQN sets of `entity`-kind elements — added / removed.
- Edge drift: `source -> target` pairs from `relations` — added / removed.
- Fate follow-through: prior `#planned` elements that now exist as real stages (the plan was executed) vs prior `#to-remove` elements still present (the deletion never landed — corroborates a `Still-open` or `Regressed` finding row).

Write ONE line into the Drift Delta section: `Model drift: entities +{A}/−{R}, edges +{X}/−{Y}; planned-realized {P}; to-remove-still-present {S}` (name the specific elements in a follow-up sentence when any count is non-zero). Skip silently when either side lacks a model or the prior dir was deleted.
