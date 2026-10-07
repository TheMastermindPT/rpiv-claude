---
template_version: 5
date: {Current ISO timestamp with timezone}
author: {Author from Metadata}
commit: {Observed repository commit, not a substitute for candidate_revision}
branch: {Observed branch, not a substitute for candidate_revision}
repository: {Repository name}
topic: "Validation of {approved artifact topic}"
status: ready
verdict: {pass | fail}
parent: "{approved artifact path}"
tags: [validation, {relevant inherited tags}]
last_updated: {Same ISO timestamp as date}
last_updated_by: {Author from Metadata}
---

## Validation Report: {Topic}

### Scope and Identity

- Audit scope: {candidate slice | final combined integrated tree; exact included intent/slice IDs}
- Review input: `mode=candidate`; `artifact_path`: {path}; `slice_id`: {ID}; `repository_path`: {absolute candidate workspace}; `base_commit`: {exact accepted predecessor base}; `candidate_revision`: {shared immutable revision identity}; `evidence_paths`: {paths}
- Candidate representation: {explicitly authorized commit plus verified clean state, or complete immutable patch and included file digest manifest as defined by the shared workflow; verification evidence or blocker}
- Approved contract identity: {approved body hash, approved copy path, referenced document hashes, and approval record}
- Document integrity: {content_hash checks and the append-only check against the approved copy; any missing copy, failed check, or mismatch}
- Original integration target: {target and recorded base, separate from the accepted predecessor base_commit}
- Before/after candidate identity: {matching observations or drift diagnostic}

### Implementation Status

{One evidence-backed result per included intent/slice ID: verified, partial, or unproven, with evidence paths. If no verified candidate exists, state blocked and verdict: fail even when documents are ready.}

### TDD Evidence Audit

{One result per behavior: test name/path, agreed seam/oracle, expected-red reason, observed red before implementation, re-proved red (the helper's bucket and reason for the slice commit or its --base revision; pins skipped; for every outcome other than `failed`, the developer's answer and reason), subsequent green, and linked revision/contract evidence. Record explicit valid exemptions with reasons. Missing historical red is a proof gap, never an automatic pre-TDD exemption.}

### Independent Review/Refactor Audit

{Reviewer identities and report paths; matching contract, candidate_revision, and base_commit; review after minimal green; findings and disposition; fresh tests and reviews after every edit. Missing or stale review is a blocker, not a clean review.}

### Automated Verification Results

{One result per actual project command: scope, command, outcome, evidence path. Distinguish passed, failed, unavailable, and broken; identify required versus optional gates and missing runtime proof.}

### Test Quality

{Project gate requirements and observed outcomes for test-quality lint, mutation, and CodeScene. Include survivor/regression evidence and justified dispositions. No hardcoded tool mandate or score threshold; unavailable optional tools remain unavailable, broken invocations retain diagnostics, and any unmet required gate blocks. Validation makes no source or test fixes.}

### Findings

{Verified matches, deviations, and action-required gaps with source/evidence references. If none, state none found within the declared scope, with any testing limitations.}

### Human Acceptance

{Exact accepted contract and candidate revision, human decision evidence, or awaiting acceptance. Technical pass is not acceptance. Record the acceptance the lane requires: each slice in rigorous, the combined result in fast and normal (shared **Lanes**).}

### Integration Authorization and Validation

{Separate human integration consent for exact candidates and target, or not authorized. For final combined scope, record integrated-tree identity, included accepted candidates, all-contract and combined-gate results. For candidate-only scope, state integrated-tree validation not performed; no claim of whole-scope completion.}

### Manual Verification

{Required manual/runtime criteria, verified evidence and outstanding steps; or not applicable with a reason.}

### Remaining Scope

{Pending, deferred, and blocked intent/slice IDs with next refinement triggers. Active-slice completion does not complete the whole scope. If none, explain the evidence supporting that conclusion.}

### Verdict and Next Decision

{pass | fail for the declared scope, with reasons and workflow blockers. A ready report is not a verified or accepted candidate. Name the next human decision or route fixes to implement/revise; no automatic commit or integration.}
