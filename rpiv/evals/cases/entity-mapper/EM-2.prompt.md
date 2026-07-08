Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:entity-mapper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Target: `lib/db/provider-exercise-catalog`. Style: `auto` (detect per entity — use event/CQRS/pipeline/hex signal when present; fall back to CRUD). Build the top-down System Model. Seeds — ripple-groups (`co-change-groups` rows from metrics):
(none — no co-change group cleared the threshold for this target)
Write-site counts (the regex `write-sites` rows: table/RPC -> writers=N + files):
table:exercise_source_normalizations	writers=2	files=lib/db/provider-exercise-catalog/derivation-upsert.ts, lib/db/provider-exercise-catalog/entities.ts
rpc:apply_provider_catalog_review_workflow_atomic	writers=1	files=lib/db/provider-exercise-catalog/atomic-workflow.ts
rpc:approve_exercise_source_rebind_proposal_atomic	writers=1	files=lib/db/provider-exercise-catalog/rebind.ts
table:arrayBuffer	writers=1	files=lib/db/provider-exercise-catalog/media.ts
table:exercise_media_assets	writers=1	files=lib/db/provider-exercise-catalog/media.ts
table:exercise_planner_profiles	writers=1	files=lib/db/provider-exercise-catalog/derivation-upsert.ts
table:exercise_presentation_profiles	writers=1	files=lib/db/provider-exercise-catalog/derivation-upsert.ts
table:exercise_publish_runs	writers=1	files=lib/db/provider-exercise-catalog/publish.ts
table:exercise_rebind_proposals	writers=1	files=lib/db/provider-exercise-catalog/rebind.ts
table:exercise_review_events	writers=1	files=lib/db/provider-exercise-catalog/internal/utils.ts
table:exercise_source_snapshots	writers=1	files=lib/db/provider-exercise-catalog/snapshots.ts
table:exercises	writers=1	files=lib/db/provider-exercise-catalog/entities.ts
Type seeds: the db row-type file (`lib/db/types.ts`) and the domain contracts under `lib/domain/`. Name the canonical entities from the type/contract seeds, attach files, auto-detect the architecture style per entity, place each entity's files across its style-appropriate lifecycle stages, **judge ownership per the style-specific rule** (CRUD: `writers=1` -> that module owns; `writers>=2` -> `owner: NONE`; event-driven: multiple owners by design; CQRS: WRITE aggregate owns invariant; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports), and record cross-entity edges. Output L0 (Entity | Style | Outbound edges) + per-entity L1. Cite `file:line`; emit the model only, no findings. Do not invent an entity with no type / contract / persistence basis.
</agent-prompt>