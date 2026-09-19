# Dimension Sweep + Developer Checkpoint — shared ambiguity-resolution protocol

Shared ambiguity assessment for design and blueprint. Read
`$RPIV_PLUGIN_ROOT/skills/_shared/candidate-workflow.md` first. Resolve
decisions that constrain the next slice or an irreversible commitment; retain
later questions under Deferred Work with the condition that unlocks them.
The sweep is a reasoning checklist, not a requirement to write six sections or
ask six questions on every task.

## Step 3 — Dimension Sweep

Walk current findings, inherited decisions, and open questions through the
applicable dimensions. Add migration when persisted schema changes; explicitly
identify rollback or irreversible effects before authorizing that work.

- **Data model** — types, schemas, entities
- **API surface** — signatures, exports, routes
- **Integration wiring** — mount points, DI, events, config
- **Scope** — in / explicitly deferred
- **Verification** — for each risk-bearing behavior:
  1. List boundaries (thresholds, ranges, null/empty states)
  2. List invariants (what must always be true)
  3. List error surfaces (what can go wrong)
  4. Flag as high test-risk if 3+ boundaries or 2+ invariants → queue
     as testing-strategy question for Step 4
- **Performance** — load paths, caching, N+1 risks

For each dimension, classify findings as **simple decisions** (one valid option, obvious from codebase — record in Decisions with `file:line` evidence, do not ask) or **genuine ambiguities** (multiple valid options, conflicting patterns, scope questions, novel choices — queue for Step 4). Inherited research Q/As land as simple; Open Questions filter by dimension — architectural survives, implementation-detail defers.

**Pre-validate every option** against current source and accepted constraints.
Eliminate or caveat contradictory choices. Preserve every material risk as an
applicable decision, next-slice question, or explicitly deferred obligation;
reading a file does not require inventing a decision about it.

## Step 4 — Developer Checkpoint

Use the grounded-questions-one-at-a-time pattern. Use a **❓ Question:** prefix so the developer knows their input is needed. Each question must:
- Reference real findings with `file:line` evidence
- Present concrete options (not abstract choices)
- Pull a DECISION from the developer, not confirm what you already found

**Question patterns by ambiguity type:**

- **Pattern conflict**: "Found 2 patterns for {X}: {pattern A} at `file:line` and {pattern B} at `file:line`. They differ in {specific way}. Which should the new {feature} follow?"
- **Missing pattern**: "No existing {pattern type} in the codebase. Options: (A) {approach} modeled after {external reference}, (B) {approach} extending {existing code at file:line}. Which fits the project's direction?"
- **Scope boundary**: "The {research/description} mentions both {feature A} and {feature B}. Should this design cover both, or just {feature A} with {feature B} deferred?"
- **Integration choice**: "{Feature} can wire into {point A} at `file:line` or {point B} at `file:line`. {Point A} matches the {existing pattern} pattern. Agree, or prefer {point B}?"
- **Novel approach**: "No existing {X} in the project. Options: (A) {library/pattern} — {evidence/rationale}, (B) {library/pattern} — {evidence/rationale}. Which fits?"

- **Testing strategy** (when the Verification sweep flagged high
   test-risk behaviors). The agent derives the contract from approved intent.
  Only you know whether the contract describes the right thing. A
  contract that is structurally sound but behaviorally wrong produces
  tests that pass green and ship bugs — mutation can't catch
  correctness errors.

  1. Describe what you understand the code should do, in plain
     English. No Oracle, no syntax — just "when X happens, Y should
     result." If you're wrong about the behavior, the developer
     corrects you before a single line of contract is written.
  2. Ask: "Is this understanding correct, and which of these should
     the Test Contract prove first?" The selections determine which
     behaviors anchor foundation slices vs. build on them later.
  3. Corrections become the canonical behavior list. Approvals become
     the contract's starting point.

**Critical rules:**
- Ask ONE question at a time. Wait for the answer before asking the next.
- Lead with the most architecturally significant ambiguity.
- Record each answer with its rationale. If new implementation evidence conflicts
  with it, surface that evidence and ask to reopen the decision; never silently
  change intended behavior to match the code.

**Choosing question format:**

- **`question` tool** — when your question has 2-4 concrete options from code analysis (pattern conflicts, integration choices, scope boundaries, priority overrides). The user can always pick "Other" for free-text. Example:

  > Use the `question` tool with the following question: "Found 2 mapping approaches — which should new code follow?". Header: "Pattern". Options: "Manual mapping (Recommended)" (Used in OrderService (src/services/OrderService.ts:45) — 8 occurrences); "AutoMapper" (Used in UserService (src/services/UserService.ts:12) — 2 occurrences).

- **Free-text with ❓ Question: prefix** — when the question is open-ended and options can't be predicted (discovery, "what am I missing?", corrections). Example:
  "❓ Question: The integration surface shows no background job registration for this area. Is that expected, or is there async processing I'm not seeing?"

**Batching**: When you have 2-4 independent questions (answers don't depend on each other), you MAY batch them in a single `question` call. Keep dependent questions sequential.

**Classify each response:**

**Decision** (e.g., "use pattern A", "yes, follow that approach"):
- Record in Developer Context. Fix in Decisions section.

**Correction** (e.g., "no, there's a third option you missed", "check the events module"):
- Spawn targeted rescan: **codebase-analyzer** on the new area (max 1-2 agents).
- Merge results. Update ambiguity assessment.

**Scope adjustment** (e.g., "skip the UI, backend only", "include tests"):
- Record in Developer Context. Adjust scope.

**After next-slice blockers are resolved**, present a brief summary (under 15
lines), including remaining deferred questions rather than implying all future
work is decided:

```
Design: {feature name}
Approach: {1-2 sentence summary of chosen architecture}

Decisions:
- {Decision 1}: {choice} — modeled after `file:line`
- {Decision 2}: {choice}
- {Decision 3}: {choice}

Scope: {what's in} | Not building: {what's out}
Files: {N} new, {M} modified
```

Use `question` when approval is not already explicit. Ask whether to
accept the stated intent, adjust a decision, or change scope. This checkpoint
approves document content only. Build authorization is a separate decision with
the workspace and permitted effects named by the candidate workflow.
