// gen-agent-inputs.mjs — render the four agent-eval prompt files from ground truth.
//
//   node gen-agent-inputs.mjs
//
// EM-1 / EM-2 reproduce the architectural-review Step 2.7 dispatch prompt with REAL
// frozen seeds (metrics.mjs output at the pinned ref) so the entity-mapper is evaled
// exactly as the skill invokes it. IS-1 rebuilds the Step 6.5 dispatch: the verified
// finding rows come from the extracted ground truth (verbatim lines at 96e3553), the
// co-change pairs from the frozen metrics. IS-2 is the hallucination pressure test:
// five real-but-unrelated findings from five different subsystems, no co-change list —
// the only correct answer is the exact no-interaction response.
//
// Each prompt is a headless WRAPPER (spawn the agent verbatim, save its output to
// {OUT}) so the eval measures the agent, not the wrapper's creativity.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, "..", "cases");
const WT_HEAD = "C:/Users/pedro/Documents/GymApp-evals/wt-head";

const gt = JSON.parse(readFileSync(join(CASES, "ground-truth", "ar-lib-generation-96e3553.json"), "utf-8"));
const metricsGen = readFileSync(join(CASES, "ground-truth", "metrics-lib-generation-96e3553.txt"), "utf-8");
const metricsCat = readFileSync(join(CASES, "ground-truth", "metrics-lib-db-catalog-96e3553.txt"), "utf-8");

const block = (txt, name) => {
	const m = txt.match(new RegExp(`---${name}---\\n([\\s\\S]*?)(?=\\n---[a-z-]+---|$)`));
	return (m?.[1] ?? "").trim();
};

const wrapper = (agent, inner) =>
	`Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "${agent}" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
${inner}
</agent-prompt>`;

// ---------- EM-1: real seeds, lib/generation @ 96e3553 ----------
const em1Inner = `Target: \`lib/generation\`. Style: \`auto\` (detect per entity — use event/CQRS/pipeline/hex signal when present; fall back to CRUD). Build the top-down System Model. Seeds — ripple-groups (\`co-change-groups\` rows from metrics):
${block(metricsGen, "co-change-groups")}
Write-site counts (the regex \`write-sites\` rows: table/RPC -> writers=N + files):
${block(metricsGen, "write-sites")}
Type seeds: the db row-type file (\`lib/db/types.ts\`) and the domain contracts under \`lib/domain/\`. Name the canonical entities from the type/contract seeds, attach the ripple-group files, auto-detect the architecture style per entity, place each entity's files across its style-appropriate lifecycle stages, **judge ownership per the style-specific rule** (CRUD: \`writers=1\` -> that module owns; \`writers>=2\` -> \`owner: NONE\`; event-driven: multiple owners by design, EMIT owns schema, each HANDLE owns side effects; CQRS: WRITE aggregate owns invariant, READ is a projection — no independent owner; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports, each ADAPTER owns its impl), and record cross-entity edges. Output L0 (Entity | Style | Outbound edges) + per-entity L1 (name each entity, style, stage placement with style-specific stage names, owner per the style's rule, unguarded/split-brain notes). Cite \`file:line\`; emit the model only, no findings.`;
writeFileSync(join(CASES, "entity-mapper", "EM-1.prompt.md"), wrapper("rpiv:entity-mapper", em1Inner));

// ---------- EM-2: real seeds incl. writers=2 row + parser-noise row, lib/db catalog ----------
const em2Inner = `Target: \`lib/db/provider-exercise-catalog\`. Style: \`auto\` (detect per entity — use event/CQRS/pipeline/hex signal when present; fall back to CRUD). Build the top-down System Model. Seeds — ripple-groups (\`co-change-groups\` rows from metrics):
(none — no co-change group cleared the threshold for this target)
Write-site counts (the regex \`write-sites\` rows: table/RPC -> writers=N + files):
${block(metricsCat, "write-sites")}
Type seeds: the db row-type file (\`lib/db/types.ts\`) and the domain contracts under \`lib/domain/\`. Name the canonical entities from the type/contract seeds, attach files, auto-detect the architecture style per entity, place each entity's files across its style-appropriate lifecycle stages, **judge ownership per the style-specific rule** (CRUD: \`writers=1\` -> that module owns; \`writers>=2\` -> \`owner: NONE\`; event-driven: multiple owners by design; CQRS: WRITE aggregate owns invariant; pipeline: TRANSFORM stage owns; hexagonal: DOMAIN owns ports), and record cross-entity edges. Output L0 (Entity | Style | Outbound edges) + per-entity L1. Cite \`file:line\`; emit the model only, no findings. Do not invent an entity with no type / contract / persistence basis.`;
writeFileSync(join(CASES, "entity-mapper", "EM-2.prompt.md"), wrapper("rpiv:entity-mapper", em2Inner));

// ---------- IS-1: verified rows from ground truth @ 96e3553 ----------
const sevOf = (s) => (/^(high|med|low)/i.test(s) ? s.replace(/\*+/g, "").trim() : "Med");
const rows = gt.findings
	.filter((f) => f.primary?.verbatim)
	.map((f) => `${f.id} | ${f.lens} | ${f.primary.path}:${f.primary.line} | \`${f.primary.verbatim}\` | ${sevOf(f.severity)} | ${f.what.replace(/\|/g, "/").slice(0, 130)}`);
const is1Ids = gt.findings.filter((f) => f.primary?.verbatim).map((f) => f.id);

const layerTable = `L0 — Generation core (policies + barrels, 37 loose generation/*.ts)
L1 — Plan orchestration (plan-generation/ + deterministic-plan/, 14 files)
L2 — Adaptive sub-pipeline (adaptive-context/ + adaptive-application/, 26 files)
L3 — Prescriptions / ranking / substitution / patterns (26 files)
L4 — Validator / rationale / goal-rules / planner-types (19 files)`;

const is1Inner = `Target: lib/generation   Layers:
${layerTable}

Verified finding set (each: id | lens | file:line | \`verbatim line\` | severity | one-line what-it-is):
${rows.join("\n")}

Co-change pairs (hidden coupling, no import edge):
${block(metricsGen, "co-change-candidates")}

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 \`file:line\` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.`;
writeFileSync(join(CASES, "interaction-sweeper", "IS-1.prompt.md"), wrapper("rpiv:interaction-sweeper", is1Inner));
console.log("IS-1 finding ids:", JSON.stringify(is1Ids));

// ---------- IS-2: five real-but-unrelated findings @ HEAD, no co-change ----------
function firstFile(dir, ext, minLines = 25) {
	const walk = (d) => {
		for (const e of readdirSync(d).sort()) {
			if (e === "node_modules" || e.startsWith(".")) continue;
			const p = join(d, e);
			if (statSync(p).isDirectory()) {
				const r = walk(p);
				if (r) return r;
			} else if (e.endsWith(ext) && readFileSync(p, "utf-8").split("\n").length >= minLines) return p;
		}
		return null;
	};
	return walk(join(WT_HEAD, dir))?.slice(WT_HEAD.length + 1).replaceAll("\\", "/") ?? null;
}
function realLine(rel, wantLine) {
	const ls = readFileSync(join(WT_HEAD, rel), "utf-8").split("\n");
	let n = wantLine;
	while (n < ls.length && ls[n - 1].trim().length < 8) n++;
	return { line: n, text: ls[n - 1].trim() };
}
// v3 curation. v1 failed its premise (test file + mutation tooling meta-relate to
// everything; two rows shared the unit-system domain). v2 fixed those but left two
// SELF-INCONSISTENT rows: X1 said "logging interleaved with dispatch" while citing
// proxy.ts's route-MATCHER line, and X2 (auth actions) shares route vocabulary with
// proxy.ts — the sweeper re-reads cited code, privileged the code over the label, and
// grounded a real route-triplication compound. v3 rule: the cited line must SUPPORT the
// stated defect, and no two rows may touch the same domain noun (domains in play:
// body-metrics db, shared UI primitives, provider adapter, prescriptions migration,
// workout adherence).
const picks = [
	{ id: "X1", lens: "Lc", rel: "lib/db/body-metrics.ts", at: 14, what: "mutation-input assembly mixed with dedup-key derivation in one module" },
	{ id: "X2", lens: "C", rel: firstFile("components/shared", ".tsx"), at: 12, what: "presentation copy hard-coded in a shared primitive" },
	{ id: "X3", lens: "A", rel: "lib/external/exercise-providers/exercisedb-oss.ts", at: 25, what: "exported mapper has a single internal caller (speculative export)" },
	{ id: "X4", lens: "D", rel: "supabase/migrations/20260617114300_clear_structured_prescription_on_exercise_change.sql", at: 5, what: "trigger intent restated in a schema comment" },
	{ id: "X5", lens: "G", rel: "lib/workout/adherence.ts", at: 12, what: "file accretes unrelated calculations" },
].filter((p) => p.rel && existsSync(join(WT_HEAD, p.rel)));
const is2Rows = picks.map((p) => {
	const { line, text } = realLine(p.rel, p.at);
	return `${p.id} | ${p.lens} | ${p.rel}:${line} | \`${text}\` | Med | ${p.what}`;
});

const is2Inner = `Target: the GymApp application (cross-cutting sample)   Layers:
L0 — app/ routes and pages
L1 — components/ UI
L2 — lib/ domain + db access
L3 — supabase/ schema + migrations
L4 — tests/ + tools/

Verified finding set (each: id | lens | file:line | \`verbatim line\` | severity | one-line what-it-is):
${is2Rows.join("\n")}

Co-change pairs (hidden coupling, no import edge):
(none — no pair cleared the threshold)

Group by shared module / concept / boundary / data-flow / co-change pair — NOT by lens. Per group, re-READ the cited code and emit only compounds grounded in >= 2 \`file:line\` facts from DIFFERENT files. Name the single architectural decision (the root cause) behind each. Promote the aggregate severity when the interaction itself is the defect. No new atomic findings, no remediation.`;
writeFileSync(join(CASES, "interaction-sweeper", "IS-2.prompt.md"), wrapper("rpiv:interaction-sweeper", is2Inner));
console.log("IS-2 rows:");
for (const r of is2Rows) console.log("  " + r);
console.log("prompts written: EM-1, EM-2, IS-1, IS-2");
