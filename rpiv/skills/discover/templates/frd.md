---
date: {Current date and time with timezone in ISO format}
author: {`author:` from Metadata block}
commit: {Current commit hash}
branch: {Current branch name}
repository: {Repository name}
topic: "{Feature topic}"
tags: [intent, frd, relevant-component-names]
status: complete
register: {plain | mixed | technical — the developer's fluency level the interview adapted to}
consensus: {confirmed | partial — confirmed once the teach-back is accepted; partial if residual uncertainty was deferred}
last_updated: {Same ISO timestamp as `date:` above}
last_updated_by: {`author:` from Metadata block}
---

# FRD: {Feature topic}

## Summary
{2-3 sentences. The settled feature concept after the interview — what we're building, in the developer's framing.}

## Problem & Intent
{What the developer is trying to solve and why. Capture the underlying motivation, not the proposed solution.}

## Goals
- {Explicit goal — what success looks like}
- {Goal 2}

## Non-Goals
- {Explicit exclusion — surfaced during the interview}
- {Likely scope-creep vector the developer ruled out}

## Functional Requirements
1. {Numbered, independently testable. "The system SHALL …"}
2. {Requirement 2}

## Non-Functional Requirements
- **Performance**: {latency / throughput / load expectations, or "no specific constraint"}
- **Security**: {auth, data handling, threat model edges}
- **UX / Accessibility**: {interaction model, a11y constraints}
- **Reliability**: {error handling expectations, retry/recovery semantics}

## Constraints & Assumptions
- {Technical constraint — runtime, dependency, platform}
- {Schedule / organizational constraint}
- {Assumption being made — explicit so research can verify}

## Acceptance Criteria
- [ ] {Observable pass condition a reviewer can check without reading code}
- [ ] {Criterion 2}

## Recommended Approach
{1-2 sentences. The architectural shape implied by the decisions — e.g., "New command in `packages/rpiv-pi/extensions/`, writes JSON to stdout, no persistence layer." The downstream `research` skill validates this against the codebase and passes this text to `scope-tracer` as the topic.}

## Decisions

### {Decision 1 — short title}
**Question**: {Question as asked during the interview, or "Pre-resolved from codebase evidence"}
**Recommended**: {The recommendation that was offered}
**Chosen**: {What the developer picked, or the evidence-derived answer}
**Rationale**: {1 line — why this was chosen, or `evidence: path/to/file.ext:line` for codebase-derived}

### {Decision 2 — short title}
**Question**: …
**Recommended**: …
**Chosen**: …
**Rationale**: …

## Open Questions
{Only items the developer explicitly deferred. Each becomes an Open Question for `research` to answer or carry forward into Developer Context.}

- {Deferred item 1 — what's deferred, why}

## Suggested Follow-ups
{Related-but-out-of-scope items surfaced during the probe or interview that the developer did NOT add to scope. One line per item: what was observed and where. Omit the entire section if empty — do not leave placeholder text.}

- {Observed item — `file:line`}

## Glossary
{Every term of art introduced during the interview, paired with its one-line plain-language meaning in the developer's own register. This is the shared-language record so the developer can re-read this FRD without re-learning the vocabulary. Omit the section only if no term of art was ever introduced.}

| Term | What it means here |
|---|---|
| {term} | {one-line plain-language definition, in the developer's words} |

## Shared Understanding
{The teach-back outcome from the consensus checkpoint. This section is the proof that both sides agreed — not just that questions were answered.}

**Agreed model (in the developer's words):** {short restatement of the settled feature as the developer confirmed it.}

**Corrected during teach-back:** {what the developer changed when the model was played back — one line each; "nothing — model confirmed as first stated" if no corrections.}

**Residual uncertainty (accepted):** {points the developer confirmed are acceptable to leave open or assumed — one line each; omit if none.}

## Visual Artifacts
{Only when the visual companion was used. One line per saved mockup/diagram with its path. Omit the section entirely for text-only sessions.}

- {what it showed — `.superpowers/brainstorm/<session>/content/<file>.html`}

## References
- {Input file or ticket}
- {Related artifact, e.g., `.rpiv/artifacts/research/<YYYY-MM-DD_HH-MM-SS>_<topic>.md`}
