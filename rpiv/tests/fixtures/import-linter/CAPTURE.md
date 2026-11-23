# import-linter capture

rpiv test data for `skills/architectural-review/_helpers/import-contracts.mjs`. Each file
is the stdout and stderr of one real `lint-imports --no-cache` run (import-linter 2.17,
CPython 3.13, a throwaway `uv venv`, Windows), on the S7 spike project: `src/shop/` with
`core.py` importing `shop.db`, `api/views.py` importing `shop.core` and `..db`, and two
contracts in `pyproject.toml` (layers `shop.api` > `shop.core` > `shop.db`, kept; `shop.api`
forbidden from `shop.db`, broken).

| File | Run | Exit |
| --- | --- | --- |
| `kept-broken.txt` | `PYTHONPATH=src lint-imports --no-cache` | 1 |
| `missing-package.txt` | `lint-imports --no-cache` (no `PYTHONPATH`) | 1 |
| `bad-type.txt` | `PYTHONPATH=src lint-imports --no-cache --config <a copy with type "laaayers">` | 1 |
| `no-config.txt` | `PYTHONPATH=src lint-imports --no-cache`, in a copy with no import-linter config | 1 |

The outputs hold no machine paths, so nothing was replaced.
