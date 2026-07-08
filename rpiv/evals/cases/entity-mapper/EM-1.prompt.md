Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:entity-mapper" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Target: `lib/generation`. Style: `auto` (detect per entity — use event/CQRS/pipeline/hex signal when present; fall back to CRUD). Build the top-down System Model. Seeds — ripple-groups (`co-change-groups` rows from metrics):
g1	files=lib/generation/adaptive-application.ts, lib/generation/adaptive-context/validation.ts, lib/generation/limitation-rules.ts, lib/generation/plateau-rules.ts	modules=lib/generation, lib/generation/adaptive-context
g2	files=lib/generation/persist-plan.ts, lib/generation/validator.ts	modules=lib/generation
Write-site counts (the regex `write-sites` rows: table/RPC -> writers=N + files):
table:plan_generation_runs	writers=1	files=lib/generation/plan-generation/run-lifecycle.ts
Type seeds: the db row-type file (`lib/db/types.ts`) and the domain contracts under `lib/domain/`. Name the canonical entities from the type/contract seeds, attach the ripple-group files, auto-detect the architecture style per entity, place each entity's files across its style-appropriate lifecycle stages, **judge ownership per the style-specific rule** (CRUD: `writers=1` -> that module owns; `writers>=2` -> `owner: NONE`; event-driven: multiple owners by design, EMIT owns schema, each HANDLE owns side effects; CQRS: WRITE aggregate owns invariant, READ is a projection — no independent owner; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports, each ADAPTER owns its impl), and record cross-entity edges. Output L0 (Entity | Style | Outbound edges) + per-entity L1 (name each entity, style, stage placement with style-specific stage names, owner per the style's rule, unguarded/split-brain notes). Cite `file:line`; emit the model only, no findings.
</agent-prompt>