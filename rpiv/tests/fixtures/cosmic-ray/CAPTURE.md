# Cosmic Ray capture

rpiv test data for `skills/architectural-review/_helpers/cosmic-ray.mjs`. Each file is the
output of one real `cosmic-ray dump <session>` (Cosmic Ray 8.9.0, pytest 9.2.0, CPython
3.13, a throwaway `uv venv`, Windows) on the S8 spike project: `src/calc/ops.py` (`add`,
`is_big`) and `tests/test_ops.py`, with `module-path = "src/calc/ops.py"` and the local
distributor.

| File | Session | Jobs |
| --- | --- | --- |
| `dump-run.jsonl` | after `exec`, `test-command` with an absolute forward-slash venv python | 18: 14 killed, 4 survived (`cr-report`: `surviving mutants: 4 (22.22%)`) |
| `dump-incompetent.jsonl` | after `exec`, `test-command` naming a python that does not exist | 18 incompetent (`cr-report`: `surviving mutants: 0 (0.00%)`) |
| `dump-pending.jsonl` | after `init`, before `exec` | 18 with a `null` result |

Every result's `output` and `diff` were replaced with `<removed>` (they held machine paths
and pytest output the reader never uses). Nothing else changed.
