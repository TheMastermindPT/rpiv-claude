---
name: discover
description: Interview the developer one question at a time to extract feature intent and requirements, reaching mutual consensus, then synthesize into a Feature Requirements Document at .rpiv/artifacts/discover/. The first question is intent-only and runs before any codebase probe; subsequent questions ground in evidence the probe surfaces. Adapts its language to the developer's fluency and glosses jargon into a shared glossary, offers a just-in-time browser visual companion (with ASCII fallback) for spatial/architecture questions, and ends with a teach-back checkpoint that plays the understanding back in the developer's words so both sides confirm the same model. Use as the canonical entry point of the pipeline before research, or to stress-test a feature idea before codebase discovery. The FRD's Decisions block is consumed by `research` and propagates through Developer Context into `design`.
argument-hint: "[free-text feature description | existing artifact path]"
shell-timeout: 10
---

# Discover

You are tasked with extracting feature intent and requirements through a one-question-at-a-time interview, then writing a Feature Requirements Document (FRD) that downstream skills consume. The deeper goal is **mutual consensus**: by the end, the developer understands the language you used and you understand the idea they want built — both can point at the artifact and agree it is right. Four principles shape the flow: (1) **intent before agents** — the foundational intent question runs before any probe, so stated intent shapes the probe scope; (2) **lazy + confirm** — build the decision tree one layer at a time, and surface evidence-based pre-resolutions for confirmation rather than silently recording them; (3) **adaptive register** — read the developer's own vocabulary and mirror it, glossing any term-of-art the first time so the language is shared, never assumed; (4) **prove the consensus** — before finalizing, play your understanding back in the developer's words (and a visual when it helps) so both sides confirm the same mental model.

## Input

`$ARGUMENTS` — free-text feature description, or path to an existing FRD / ticket / doc for refinement.

## Metadata

```!
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/now.mjs"
echo
node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/git-context.mjs"
```

- `now.mjs` (line 1) — `<iso>\t<slug>` tab-separated.

Copy values verbatim — do not reformat the timezone offset.

## Flow

1. Input → 2. Intent question → 2.5 Register read → 3. Codebase probe → 4. Lazy tree → 5. Interview loop → 5.5 Teach-back consensus → 6. Synthesize FRD → 7. Write artifact → 8. Follow-ups

The final artifact is research-compatible — its Decisions block is translated into research's Developer Context and inherited by design. Steps 2.5, the in-loop communication behaviors, and 5.5 are the two-way-understanding layer; they add no agents and never gate the pipeline contract.

## Steps

### Step 1: Input Handling

1. **No argument provided**:
   ```
   I'll capture feature intent into an FRD. Provide one of:

   `/rpiv:discover [free-text feature description]`     — fresh interview, write a new FRD
   `/rpiv:discover [existing artifact path]`            — refine an existing FRD/ticket/doc via fresh interview
   ```
   Then wait for input.

2. **Detect input shape** — parse the input:
   - If the argument is an existing file path (resolves to a readable `.md` under `.rpiv/artifacts/`, or any path the user mentions for refinement context), read it FULLY using the Read tool WITHOUT limit/offset. Treat its content as baseline context — the interview surfaces gaps, missing requirements, and unstated assumptions relative to what's already documented.
   - Otherwise → fresh-feature mode: the entire argument is the free-text feature description.

3. **Read any other files mentioned** in the prompt (tickets, docs, related artifacts, explicit `path:line` references) FULLY before proceeding.

**No agent dispatch in Step 1.** Only `Read` on user-named paths. Agent grounding starts in Step 3, after stated intent has shaped the probe scope.

Each invocation always writes a NEW timestamp-distinct artifact (Step 7) — there is no in-place stress-test append mode. To iterate on a prior FRD, either re-invoke discover (produces a fresh artifact) or manually Edit the prior artifact.

### Step 2: Foundational Intent Question

Before any codebase probe, ask the foundational intent question. This is purely conversational — no agents, no recommendation, no `file:line` citations.

1. **Ask one open-ended `intent` question** via `ask_user_question`:
   - Frame: "What problem are you solving and who hits it?" / "What does success look like for the person experiencing this today?" — phrase it for the specific feature.
   - **No `(Recommended)` option.** The developer should generate the framing, not pick from a proposal.
   - **No `file:line` citations** — codebase has nothing to say about intent.
   - Options should be open shapes (e.g., "End user / maintainer / operator / Other") that route the answer, not solution shapes.
   - Always offer "Other" so the developer can free-text the real framing.

2. **Capture the answer in the developer's own words.** This text feeds into the FRD's Problem & Intent section verbatim — do not paraphrase into agent prose.

3. **Follow-up intent questions** — ask only when the developer's answer to the first question leaves one of these gaps:

   - **Missing constraints.** They said what should happen, not what
     must stay untouched or what approaches are off-limits. Constraints
     define the solution space — they rule out wrong answers before you
     design anything. A requirement says "do X." A constraint says
     "do X without touching Y and within Z." The second is worth ten
     of the first. Ask whichever the answer left open:

     *What must stay untouched?* Existing behavior, data, workflows
     the feature lives alongside. "What existing behavior or data must
     this leave alone?"

     *What approaches are off-limits?* Patterns, conventions, layer
     boundaries. "Any rules or patterns I must follow — or must not
     break?"

   - **Missing premise.** A term they used could mean two different
     things in this system, or their stated goal contradicts their
     described behavior. Ask: "When you said X, did you mean Y or Z?"
     — two concrete interpretations, not an open "what did you mean?"

     **Record every disambiguated term for the Glossary (Step 6).** The
     resolved meaning (e.g., "'session' = workout session, not browser
     session") is a shared-language entry — add it to the running glossary
     list immediately so Step 6 enumerates it without re-deriving from
     the question log.

   - **Missing urgency.** They described a problem but not what it
     blocks. Ask only when the feature connects to other work — a
     module being refactored, a future feature it enables, a deadline.
     Standalone features with no sequencing context need no urgency
     question.

   No gap → no follow-up. Move to Step 3. No cap on follow-ups — ask
   until the gaps are filled or the developer signals they're done.

### Step 2.5: Register Read (adaptive, silent)

After the intent answer — never before it — read the developer's technical fluency from their input text plus their Step 2 wording. This costs no question and no agent; it sets how you phrase everything downstream.

1. **Classify register** into one of three levels, held internally:
   - **`plain`** — the developer describes the idea in everyday terms and analogies, few or no terms of art (e.g., "a thing where the coach taps record and the client hears it later"). Lead with plain words; keep any technical term in parentheses; lean toward visuals for structure.
   - **`mixed`** — some domain/dev vocabulary, some gaps (the common case). Use the term but gloss it once.
   - **`technical`** — precise, fluent vocabulary (e.g., "async upload to object storage with a signed URL"). Match discover's full density; still log a one-line glossary entry the first time a non-obvious term appears, for the shared record.

2. **Mirror, don't impose.** Adopt the developer's own nouns for the feature's concepts (their word for the entity, the action, the actor). When you must introduce your own term, that is a glossary event (see Step 5 communication behaviors).

3. **Re-assess continuously.** Register is a running estimate, not a one-shot label — if later answers are markedly more or less fluent than Step 2 suggested, shift the level and adjust phrasing from that point. Record the final level in the FRD frontmatter `register:` field (Step 6).

**Register never contaminates intent.** It only changes *how you say things*, never *what you ask* — the Step 2 intent question stays first, open, and recommendation-free regardless of register.

### Step 3: Lightweight Codebase Probe (parallel agents, intent-shaped)

Goal: ground the upcoming interview in concrete codebase evidence, with the probe slice shaped by the developer's stated intent from Step 2 — not by the raw input text.

1. **Pick the agent set.** Dispatch `codebase-locator`, `codebase-analyzer`, or both — nothing else. Cap: 2 agents per Step 3 invocation.

2. **Spawn the chosen agent(s) in parallel using the Agent tool.** Draft each prompt yourself from the developer's stated intent — keep the slice narrow (one component, one seam) and avoid breadth phrasing like "everything related to X". Shape per call:
   ```
   Agent({
     subagent_type: "codebase-locator",   // or "codebase-analyzer"
     description: "<3-5 word task>",
     prompt: "<your narrow-slice prompt, scoped to stated intent>"
   })
   ```
   The agent description on each subagent is the contract for what it expects in the prompt body.

3. **Wait for ALL agents to complete before proceeding to Step 4.**

4. **Read any clearly-relevant files** surfaced by the agents (≤5 files in main context, files <300 lines fully, larger files first 150 lines). Carry the agent reports and these files into Step 4 as evidence.

5. **Empty results are not fatal.** If the probe returns thin/empty results (greenfield, no precedent), record "no codebase precedent" as evidence — `scope` interview questions still work (they don't need `file:line`), and `shape` questions will shift to ungrounded "pick A or B by convention" mode.

### Step 4: Lazy Tree Setup + Pre-Resolution Confirmation

Synthesize the **next layer** of questions internally before asking anything. Lazy expansion — build only root + immediate children at this stage, not the full tree. Each subsequent layer is built after its parent resolves.

1. **Build root + immediate children**:
   - **Root** — the developer's already-stated problem from Step 2.
   - **Immediate children** — the foundational unresolved branches: Goals/Non-Goals · Functional Requirements · Non-Functional Requirements (perf/security/UX/reliability) · Constraints · Acceptance Criteria · Recommended Approach.
   - Order branches by dependency (root → goals → constraints → solution shape → details). **This order drives the interview, not the FRD section order** — Step 6 redistributes answers into FRD sections.

2. **Mark evidence-based pre-resolutions** from Step 3 with `file:line` citations. Do NOT silently record them as Decisions yet.

3. **Batch-confirm pre-resolutions in a single `ask_user_question` call** before entering the interview loop. Frame each as: "From the probe I inferred — `<observed behavior>` (`file:line`). Keep this for the feature, or change it as part of the work?" The developer's confirm/correct is the actual Decision.

   - **Confirm** → record as Decision, rationale `evidence: file:line + confirmed`.
   - **Correct** → flip the Decision direction, schedule a Correction probe at Step 5 (≤1 additional agent on the new seam).

4. The lazy tree stays internal — do NOT present the tree to the developer unless asked.

### Step 5: Interview Loop

Walk the lazy tree depth-first, parent before child. Expand the next layer (build a node's children) only after the node resolves. For each unresolved node:

1. **Classify the question by tier**:
   - **`intent`** — already done in Step 2. Do not re-ask intent in this loop.
   - **`scope`** (goals · non-goals · functional reqs · non-functional reqs · constraints) — recommendation grounded in stated intent. `file:line` citations only when an option references existing code; otherwise state "no codebase precedent" in the option description.
   - **`shape`** (architectural choice — which seam, which pattern, which integration point) — frame **dialectically**: name the tradeoff axis, not a winner. Each option's `description` MUST state what it optimizes for AND what it sacrifices, in the form "optimizes <X>, loses <Y>" (or "optimizes <X>, costs <Y>"). The lead option still carries `(Recommended)` with a one-line rationale, but the framing forces the developer to pick a side of an explicit tension rather than rubber-stamp a winner. Generate at least 2 candidate options before scoring — never present a single option masquerading as a choice. `file:line` citations required on every option that references existing code. Mirrors the `packages/rpiv-pi/skills/research/SKILL.md:103-142` checkpoint pattern. If no precedent exists, switch to ungrounded mode and label options as "convention A / convention B" with explicit "no codebase precedent" — the dialectic framing (X vs Y tradeoff) still applies.

     **Anti-rescoping**: if the probe finds something that could substitute for the requested build (e.g., feature already exists but isn't wired up), surface as an `intent` question with `file:line` — never silently redirect. Offer both "use what's there" and "build as asked".
   - **`detail`** (acceptance criteria · routine sub-decisions inside any branch) — batchable when 2-4 sibling leaves are independent.

2. **Recommended answer** (`scope` / `shape` / `detail`): derive from intent + Step 3 evidence + project conventions. Every non-intent question carries a recommendation labeled `(Recommended)`.

3. **Ask via `ask_user_question`.** Lead with the recommended option. The "Other" option is automatic and handles open-ended answers.

3.5 **Communication behaviors — apply to every question in this loop (the two-way-understanding layer):**
   - **Gloss jargon inline + record it.** The first time you must use a term of art (seam, idempotent, non-functional requirement, debounce, RLS, …), define it in one clause in the developer's register, and add it to the running Glossary (Step 6). `plain` register: prefer the everyday word, keep the term in parentheses. `technical`: use the term directly but still log it once. The Glossary is how the developer ends up understanding your language — never skip the log.
   - **Signal your own confidence.** When you are genuinely unsure what the developer meant, say so in the question instead of guessing — lead with "I'm ~60% you mean X rather than Y" and make X and Y the options. Low confidence is a reason to ask, never to silently pick a side.
   - **Offer a visual just-in-time.** When a question is about architecture / seam / layout / flow / spatial structure and would be clearer shown than told, offer the visual companion — ONCE, as its own message (see the Visual Companion section). If the developer declines or it is unavailable, render an ASCII diagram inline so they still see the structure. Keep `scope` / `detail` / conceptual questions in the terminal — a UI *topic* is not automatically a visual *question*.
   - **Speak in the current register.** Phrase options and the `(Recommended)` rationale at the level set in Step 2.5, re-assessing as answers reveal more fluency or less.

4. **Critical rules**:
   - Ask ONE question at a time. Wait for the answer before asking the next.
   - If a new evidence-based node surfaces mid-loop, batch-confirm it the way Step 4 does — never silently auto-record.

5. **Classify each response**:
   - **Decision** ("yes, that recommendation is right" / "use option B"): Record in Decisions. Resolve the node. Expand its children if any. Continue.
   - **Correction** ("no, the real intent is X" / "you missed Y"): Re-run targeted Step 3 grep on the new area; spawn at most **1 additional narrow agent per correction event** if the correction reveals a seam not yet probed. Adjust the affected subtree. Re-ask any descendants that depend on the corrected node.
   - **Misunderstanding you detect (the reverse of a Correction)**: if the developer's stated rationale contradicts the option they picked (they chose B but described A's behavior, or their reason matches a different option), do NOT record it. Surface the mismatch in one short question — "you picked B but described X, which is what A does — which did you mean?" — and resolve before recording. A Correction is the developer fixing your model; this is you catching a probable slip in either direction before it becomes a silent wrong Decision.
   - **Scope adjustment** ("skip the UI part" / "include retries"): Update the tree — prune pruned branches, add new branches if needed. Record in Decisions. **Scope-creep**: every Decision must trace to a branch under the Step 2 request. Related-but-unrequested observations ("X is also broken") go to **Suggested Follow-ups** or trigger a one-shot expand-scope? question — never silently into Decisions.
   - **Cross-cutting answer** ("we also need audit / rate limiting / X" — affects multiple branches): Mark the new node as cross-cutting and **re-queue** it. When the walk reaches each affected parent (functional / non-functional / constraints), the cross-cutter fires under that parent's context. Same node, multiple parents resolved sequentially.
   - **Defer** ("not sure, leave for later"): Add to Open Questions. Resolve the node by deferral. Continue.

6. **Batching**: When 2-4 sibling `detail` leaves are independent (answers don't depend on each other), you MAY batch them in a single `ask_user_question` call. Keep dependent questions sequential. Do not batch `scope` or `shape` questions.

7. **Termination — depth check, not bucket-fill**: stop the loop when:
   - (a) every branch has a Decision or a Deferral, AND
   - (b) the developer's own words appear in Problem/Goals (not paraphrased agent prose), AND
   - (c) no Decision is `Recommendation accepted` without at least one Rationale clause beyond `agreed`.

   Do not invent questions to pad the interview. Do NOT ask a final "looks good / want to adjust" rubber-stamp question — chain forward to research is automatic at Step 7.

**Total agent budget across the skill**: 2 (Step 3 initial probe) + N×1 (Step 5 corrections, typically 0-2) = 2-4 agent dispatches per FRD. The communication behaviors (Step 5 / 3.5), the visual companion, and the teach-back (Step 5.5) add **zero** agents.

### Step 5.5: Teach-Back Consensus Checkpoint

Once the interview loop terminates (every branch has a Decision or a Deferral), prove the consensus before writing anything. This is the one place discover plays its *own* understanding back to the developer — the mechanism that makes the FRD a shared agreement instead of a one-sided capture.

1. **Play back your model — in the developer's words.** Present a compact restatement of the settled feature: the problem (in their framing from Step 2), the goals/non-goals, the shape you'll recommend, and the key decisions — phrased at the current register, using their nouns, with glossed terms where you introduced any. When the model has structure that is clearer shown than told (a flow, a seam, a layout), accompany it with a visual (companion if active, else an ASCII diagram).

2. **Name your residual uncertainty explicitly.** List the points where your confidence is still below certain ("I'm assuming the coach, not the client, initiates this — correct?"). Surfacing your own doubt is the honest half of mutual consensus; do not paper over it to look finished.

3. **Invite correction on specifics, via `ask_user_question`.** Frame: "Here's the feature as I understand it. Correct anything that's off, or confirm each part." Offer targeted options for the uncertain points plus an always-present "It's right as stated" and "Other" for free-text fixes. The developer's confirmations and corrections are recorded into the **Shared Understanding** section (Step 6).

4. **Loop on correction, not on silence.** If the developer corrects a point, fold it back (re-running a narrow Step 3 probe or re-asking a dependent node only when the correction warrants it), then re-play only the changed part. Stop when the developer confirms the model matches — that confirmation is the consensus marker (`consensus: confirmed` in frontmatter).

**This is NOT the banned rubber-stamp.** The forbidden question is the contentless "looks good / want to adjust?" at the very end. The teach-back is the opposite: it carries the full restated model, names your own uncertainty, and asks for correction on concrete points. A rubber-stamp proves nothing; a teach-back proves you understood and gives the developer the artifact in language they can check. Never replace the teach-back with "all good?", and never skip it because the feature "seems clear".

### Step 6: Synthesize FRD Body

Read `templates/frd.md` (relative to this skill folder) at runtime to confirm the section list and frontmatter shape — do not inline it from memory.

Compile interview output into the FRD. The interview's logical order (problem → goals → constraints → solution → details) is decoupled from the FRD's section order — redistribute answers into the template buckets here:

- **Summary** — 2-3 sentences capturing the settled feature concept.
- **Problem & Intent** — the developer's framing from Step 2, in their own words. Verbatim where possible.
- **Goals / Non-Goals** — explicit in/out lists from the interview.
- **Functional Requirements** — numbered, each independently testable.
- **Non-Functional Requirements** — perf, security, UX, accessibility, reliability constraints.
- **Constraints & Assumptions** — environmental, technical, schedule, organizational.
- **Acceptance Criteria** — observable pass conditions a reviewer can check. Each MUST name a concrete command, output, or visible behavior (e.g., "running `npm test` exits 0", "`/rpiv:X` writes `path/to/Y`"). Reject vague phrasing like "feature works correctly" or "UX is acceptable".
- **Recommended Approach** — 1-2 sentences naming the architectural shape implied by the decisions (e.g., "new command in `packages/rpiv-pi/extensions/`, output to stdout, no persistence"). This text is what `research` passes to `scope-tracer` as the topic for breadth grounding.
- **Decisions** — full Q/A log per decision: `### [title]` + `**Question**:` (text as asked, or "Pre-resolved from codebase evidence — confirmed in Step 4") + `**Recommended**:` (or "n/a — `intent` question") + `**Chosen**:` (developer's pick or evidence-derived answer) + `**Rationale**:` (1 line — why, or `evidence: path/to/file.ext:line + confirmed` for codebase-derived). This block is the inheritance hook into research's Developer Context.
- **Open Questions** — only items the developer explicitly deferred.
- **Suggested Follow-ups** — related-but-out-of-scope items surfaced during the probe or interview that the developer did NOT add to scope (per the Step 5 scope-creep guardrail). One line per item: what was observed and where (`file:line` when applicable). Omit the section entirely if empty.
- **Glossary** — every term of art you introduced, paired with the one-line plain-language meaning in the developer's register (from the Step 5 gloss-and-record behavior). Also includes any developer term disambiguated during Step 2 (e.g., "'session' = workout session, not browser session"). This is the shared-language record; it lets the developer re-read the FRD without re-learning your vocabulary. Omit only if no term was ever introduced (rare).
- **Shared Understanding** — the teach-back outcome from Step 5.5: a short restatement of the agreed model in the developer's words, the points they corrected during teach-back (what changed), and any residual uncertainty they confirmed as acceptable. This section is the consensus proof — it shows both sides agreed, not just that the developer answered questions.
- **Visual Artifacts** — when the visual companion was used, a one-line reference to each saved mockup/diagram (path under `.superpowers/brainstorm/`). Omit if the session was text-only.
- **References** — input files, mentioned tickets, related artifacts.

Frontmatter additions for template_version 2: `register:` (`plain` / `mixed` / `technical` — the final level from Step 2.5) and `consensus:` (`confirmed` once the Step 5.5 teach-back is accepted; `partial` if the developer deferred on residual uncertainty).

### Step 7: Write Artifact, Present, Chain

1. **Determine metadata** (from the Metadata block above):
   - Filename: `.rpiv/artifacts/discover/<slug>_<topic>.md` — `<slug>` is the second tab-separated field on `now.mjs` line 1; `<topic>` is a kebab-case slug from the settled feature concept.
   - `repository:` ← `repo:` label; `branch:` / `commit:` ← matching labels.
   - `date:` / `last_updated:` ← `<iso>` (first tab-separated field on `now.mjs` line 1, offset verbatim).
   - Interviewer: `author:` from the Metadata block (fallback: `unknown`).

2. **Write the FRD** using the Write tool. Frontmatter `status: complete`. All template sections present and filled. The Write tool creates parent directories automatically — no `mkdir -p` needed in the skill.

   - **Promote standing decisions**: apply the decision-ledger protocol (`${CLAUDE_PLUGIN_ROOT}/skills/_shared/decision-ledger.md`) for any `## Decisions` entry tagged `scope: standing`, then regenerate the CLAUDE.md Standing Decisions block. Skip when nothing is tagged (the common case for early intent capture).
   - **Finalization lint**: run `node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <the FRD path> --finalizing --stamp`. If it exits non-zero, FIX the reported errors (Edit the FRD) and re-run — the FRD is not final until the lint passes. On success it stamps `content_hash:` (must be the last body-affecting action).

3. **Present and chain**:
   ```
   Intent captured to:
   `.rpiv/artifacts/discover/<YYYY-MM-DD_HH-MM-SS>_<topic>.md`

   {N} requirements, {M} decisions, {K} open questions.

   The FRD's Decisions block is translated into research's Developer Context and inherited by design.

   ---

   💬 Follow-up: discover writes a fresh FRD per call — re-invoke `/rpiv:discover` to iterate (the prior FRD stays unchanged on disk).

   **Next step:** `/rpiv:research .rpiv/artifacts/discover/<YYYY-MM-DD_HH-MM-SS>_<topic>.md` — ground the intent in codebase reality.

   > 🆕 Tip: start a fresh session with `/new` first — chained skills work best with a clean context window.
   ```

### Step 8: Handle Follow-ups

- **Fresh artifact per call, no in-place append.** Discover deliberately writes a NEW timestamp-distinct FRD on every invocation — there is no `## Follow-up` append mode. The prior FRD stays unchanged on disk.
- **Iterate by re-invoking.** Re-run `/rpiv:discover [path-to-prior-FRD]` (or `/rpiv:discover <free-text>`) to produce a fresh FRD informed by the prior one.
- **No rubber-stamp question.** NEVER ask a final "looks good / want to adjust" question — chain forward to research is automatic at Step 7.
- **Manual edits are allowed.** If the developer wants a one-off correction without re-running the full interview, they can Edit the FRD directly — the skill does not own follow-up surface area beyond fresh-artifact-per-call.

## Visual Companion

A browser-based companion for showing mockups, diagrams, and side-by-side options during the interview. It is a **just-in-time tool, not a mode** — most of discover stays in the terminal.

**The per-question test:** *would the developer understand this better by seeing it than reading it?* Use the browser only for content that IS visual — layouts, wireframes, architecture/flow diagrams, spatial relationships, side-by-side design comparisons. Keep `scope` / `detail` / conceptual / tradeoff questions in the terminal. A question *about* a UI topic is not automatically a visual question.

**Offering it (just-in-time, once):** Do NOT offer it upfront. The first time a `shape`/layout/flow question would be genuinely clearer shown than told, offer it then, as its own message:
> "This next part might be clearer if I show you — I can put mockups/diagrams in a browser tab as we go. Want me to open it? (Otherwise I'll sketch it in the terminal.)"

Wait for the answer. If accepted, read `${CLAUDE_PLUGIN_ROOT}/skills/discover/visual-companion.md` for the full protocol and start the server with `${CLAUDE_PLUGIN_ROOT}/skills/discover/scripts/start-server.sh --project-dir <repo-root> --open`. If declined, render an **ASCII diagram inline** instead and don't offer again unless the developer raises it — text-only developers still get the visual aid.

**Windows caveat (this environment):** the server must survive across turns. On Windows the start script switches to foreground, so launch it with `run_in_background: true` on the Bash call, then read `$STATE_DIR/server-info` next turn for the URL. Working files live under `.superpowers/brainstorm/` (gitignored scratch) — remind the developer to add `.superpowers/` to `.gitignore`. The visual companion adds no agents and is fully optional; if it fails to start, fall back to ASCII and continue.

## Important Notes

These reinforce the critical rules from the steps above — listed here so they don't get lost in step-body detail.

- **Always interview-first, intent-first**: Never write the FRD without running the interview loop. The `intent` question (Step 2) always precedes any agent dispatch — let stated intent shape the probe, not the other way around.
- **Always one question at a time**: Even with 2-4 batched independent `detail` leaves, that's still one `ask_user_question` call — wait for answers before asking the next round.
- **`intent` generates, `scope`/`shape`/`detail` reviews**: Intent is the developer's framing — they generate it. Scope, shape, and detail are proposals — they review them. The "developer reviews a proposal" model does not apply at the intent layer.
- **Adaptive register shapes HOW, never WHAT**: Step 2.5 sets the level (`plain`/`mixed`/`technical`) from the developer's own words and only changes phrasing. It never reshapes, reorders, or skips a question, and it never precedes the intent question.
- **Glossary is mandatory, not decorative**: every term of art you introduce gets a one-line plain-language entry the first time. This is the concrete mechanism for "the developer understands the language you used" — an FRD they cannot re-read without you is not consensus.
- **Teach-back proves consensus; it is not the banned rubber-stamp**: Step 5.5 restates your full model in the developer's words (+ a visual when useful), names your residual uncertainty, and asks for correction on specifics. The forbidden question is the contentless final "looks good / want to adjust?" — the teach-back is its opposite and is required.
- **Confidence and misunderstanding are surfaced, never swallowed**: when unsure of intent, say "~60% you mean X" and ask; when the developer's rationale contradicts their pick, flag it before recording. Silence on either is how a wrong Decision slips in.
- **Visuals are just-in-time and optional**: offered only when a question is clearer shown than told, once, with an ASCII fallback. Never a mode; never forced; never upfront.
- **`file:line` is tier-conditional**: `intent` — never. `scope` — only when an option references existing code, otherwise label "no codebase precedent". `shape` — required on every option that references existing code; if no precedent exists, switch to ungrounded "convention A / convention B" mode. `detail` — same rule as `scope`.
- **Lazy tree, no full-tree pre-build**: Build only root + immediate children in Step 4. Expand each node's children only after the node resolves. Premature full-tree construction biases the dialogue.
- **Pre-resolutions confirm, never silently record**: Evidence-based nodes are batch-confirmed in Step 4 (or mid-loop if newly surfaced). The developer's confirm/correct is the actual Decision.
- **Cross-cutting answers re-queue, don't duplicate or drop**: When an answer affects multiple branches, mark the node cross-cutting and fire it under each affected parent during the walk.
- **Interview order ≠ FRD section order**: Walk the tree in dependency order (problem → goals → constraints → solution → details). Step 6 redistributes answers into FRD sections.
- **Light fan-out only**: Step 3 ≤2 agents (`codebase-locator` + optionally `codebase-analyzer`). Step 5 Corrections ≤1 additional agent per correction event. Breadth discovery (`scope-tracer`, broad sweeps, `integration-scanner`) belongs to `research` — chain forward instead of expanding scope here.
- **Never write or edit source files**: This skill produces an artifact only. Source-file changes are `implement`'s job, far downstream.
- **Fresh artifact every invocation**: Each `/rpiv:discover` call writes a NEW timestamp-distinct file. To iterate on a prior FRD, re-invoke or manually Edit the prior file.
- **Critical ordering** — follow the numbered steps exactly:
  - ALWAYS read mentioned files before any agent dispatch (Step 1 → Step 2)
  - ALWAYS ask the `intent` question before probing (Step 2 → Step 3)
  - ALWAYS read the register AFTER the intent answer, never before — it shapes phrasing only (Step 2.5)
  - ALWAYS gloss and log a term of art the first time you use it (Step 5 / Glossary)
  - ALWAYS run the teach-back before synthesis and re-play only the parts the developer corrects (Step 5.5)
  - ALWAYS shape the probe by stated intent, not the raw input text (Step 3)
  - ALWAYS batch-confirm pre-resolutions instead of silent auto-record (Step 4)
  - ALWAYS expand the tree lazily during the interview (Step 5)
  - ALWAYS re-queue cross-cutting answers under each affected parent (Step 5)
  - ALWAYS terminate on depth signal, not bucket-fill (Step 5)
  - ALWAYS synthesize from the interview log, never from memory of the conversation (Step 6)
  - NEVER skip the developer-facing interview — it's the entire point of this skill
  - NEVER ask a final contentless "looks good / want to adjust" rubber-stamp question (anti-pattern per `a93e591`) — the Step 5.5 teach-back, which restates the full model and asks for specific corrections, is the allowed and required alternative; do not conflate the two
  - NEVER skip the teach-back because the feature "seems clear", and never collapse it into a bare "all good?"
  - NEVER let the register change WHAT you ask — only HOW you phrase it — and never read the register before the intent answer
  - NEVER dispatch agents before Step 2's `intent` question is answered
