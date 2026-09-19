# Approved Intent Scenario: Clamp Audit Entry

This is an eval scenario's agreed behavioral contract, not a claim that a real
candidate has been built, tested, accepted, or authorized for integration. Approval
here covers only these normative sections. Build authority remains pending.
The whole file is the contract hash scope; evidence belongs outside it.

## Scope And Decisions

- `slice_id: audit-entry`. Build a pure projection of one validated load proposal
  into an audit entry or `null`. The public seam is the proposed named export
  `buildClampAuditEntry` in `lib/generation/load-cap-audit/entry.ts`.
- Input fields: `exerciseId`, `proposedLoadKg`, `prescribedLoadKg`,
  `maxLoadIncreasePct`. Numbers are finite and non-negative, validated upstream;
  invalid-input handling and schema ownership are outside this slice.
- Output fields: `exerciseId`, `proposedLoadKg`, `cappedLoadKg`,
  `maxLoadIncreasePct`. An entry describes a proposed cap, not an applied mutation.
- Use the existing load-cap owner's exported formula and predicates. Keep its
  private epsilon private; do not duplicate arithmetic or tolerance constants.
- No persistence, telemetry, clocks, module-level buffer, or runtime validation
  side effects. Each call depends only on its arguments.
- This slice must stand alone. No UI, generation-lifecycle drain, or future module
  is an implemented predecessor. No exemption from behavioral red-green proof.

## CA-OVER

- Behavior: an over-cap proposal produces exactly one projected entry.
- Test: `projects an over-cap proposal` through `buildClampAuditEntry`, in
  `tests/unit/generation/load-cap-audit-entry.test.ts`.
- Oracle: `{ exerciseId: "squat", proposedLoadKg: 110, prescribedLoadKg: 100,
  maxLoadIncreasePct: 5 }` -> `{ exerciseId: "squat", proposedLoadKg: 110,
  cappedLoadKg: 105, maxLoadIncreasePct: 5 }`, with no additional fields.
- Expected red: after behavior-neutral export scaffolding returning `null`, the
  exact object assertion fails with received `null`. A missing module or compile
  error is setup failure, not behavioral red.

## CA-NOOP

- Behavior: proposals at or below the tolerated cap produce no entry.
- Test: `does not project uncapped proposals` through the same export/test file.
- Oracle: the CA-OVER input with proposed loads `104`, `105`, and `105.0005` ->
  `null` for each; proposed load `105.01` -> the CA-OVER output with
  `proposedLoadKg: 105.01`. All other fields stay unchanged.
- Expected red: an unconditional entry implementation after CA-OVER's green
  returns an object for the no-entry inputs. Observe that assertion failure;
  if it is already handled, record that coverage honestly instead of inventing red.

## Verification Criteria

- Automated: exact public-seam assertions for CA-OVER and CA-NOOP, input object
  unchanged after each call, and identical repeated input producing equal output.
  No wall-clock reads or mutable shared state. Locate the repo's actual unit-test
  command and typecheck command before a later authorized build.
- Static: inspect the owner import and ensure no copied epsilon or cap formula.
- Manual: no UI/runtime journey required for this pure leaf slice; generation
  integration and coach-facing wording need separate contracts when activated.
- Red and green are future obligations until observed on a real candidate. After
  green, require a separate independent review/refactor gate and human acceptance.

## Grounding

Read `lib/generation/load-cap.ts:1-32`, its callers and relevant tests in the real
repository. `lib/generation/adaptive-context/validation.ts:289-318` rejects
over-cap proposals; it does not apply clamps. Do not inherit an assumption that
validation already mutates the load. The baseline is resolved by the parent from
the pinned Git ref, not replaced with code copied from a historical artifact.
