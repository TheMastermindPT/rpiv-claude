# Legacy Fence Comparisons

These frozen case manifests and prompts describe the historical code-fence
experiment, including the three-versus-four-row slice-verifier comparison.
They are not active current-review cases and do not receive the opt-in integrity
gate. Their bytes are retained for regrading archived outputs, not as an assertion
that unavailable review is clean or planned code is a candidate implementation.

SV-3's first-entry-versus-maximum implementation bug is legacy-only. Current SV
has three rows and reviews temporal composition, not a fourth Correctness row.
Actual implementation correctness belongs to candidate-mode code review; these
intent evals do not claim to measure it.

The archived prompts/manifests retain original paths for provenance and are not
directly runnable from this archive. Do not bulk-discover this directory as an
active suite. For historical regrading, supply a saved output to grade-artifact
with one of these manifests and the original pinned source tree. Legacy grading
behavior is intentionally unchanged; no integrity result will be emitted.

Frozen historical input bytes remain at their original locations:

- `evals/cases/slice-verifier/SV-1.artifact.md`
- `evals/cases/artifact-code-reviewer/ACR-1.plan.md`
- `evals/cases/artifact-code-reviewer/ACR-2.plan.md`
- `evals/cases/_fixtures/design-load-cap-clamp-audit.md`
- `evals/cases/_fixtures/research-load-cap-clamp-audit.md`

Do not format or rewrite these frozen inputs or the archived JSON/prompts when
updating active cases. Planning cases now use lean approved-intent fixtures.
