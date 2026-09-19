<!-- Read by architectural-review SKILL.md at Step 7.2, at the start of the per-layer loop (once — it applies to every layer). Content moved verbatim from SKILL.md — the ten dimensions and the candidate-list format. Apply as written, do not reword. -->

# Per-layer dimension sweep — the 10 dimensions

- **Boundary** — what the layer owns; leaks up or down.
- **Public surface** — exported names/types/ergonomics; siblings reaching past the facade; per-symbol consumer counts (from integration-scanner).
- **Coherence / SRP** — each file and function does one thing.
- **Granularity** — functions/methods too big/small; god-parameter lists.
- **Programming by intention** — reads top-down as a story; named operations over inline blocks.
- **DRY** — duplicated patterns within the layer or across siblings (hand any cross-file duplication to the D-lens evidence).
- **DDD / ubiquitous language** — domain vocabulary consistent; no lingering legacy names.
- **Naming** — file/type/function/constant names; symmetric where the concept is symmetric.
- **Error / fail-soft posture** — uniform across the layer; multi-state returns use the language's idiomatic discriminated form.
- **Module-graph hygiene** — no cycles; type-only back-refs only where supported.

Produce a candidate list (typically 6-14/layer), each with ID `L<layer>-<seq>`, lens `10dim`, Evidence (`file:line` + verbatim quote), Quantified anchor (cite the relevant metric), What it is, Why it's slop, provisional Severity / Effort / Blast radius / Class.
