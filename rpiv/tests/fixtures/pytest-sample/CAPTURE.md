# pytest-sample capture

rpiv test data. The three reports in `junit/` were captured once from a real
pytest run, so `tests/reprove-red.test.mjs` can read genuine pytest JUnit
shapes without Python installed.

- pytest 9.2.0, in a venv created by `uv venv` (CPython 3.13, Windows).
- The venv lives outside this folder: `<venv>`.
- Every command runs from this folder, with `PYTHONDONTWRITEBYTECODE=1` set.

| Report | Command | Exit |
| --- | --- | --- |
| `junit/ok.xml` | `<venv>/Scripts/python.exe -m pytest -p no:cacheprovider --junitxml=<out>/ok.xml tests/test_ok.py` | 1 |
| `junit/collection-error.xml` | `<venv>/Scripts/python.exe -m pytest -p no:cacheprovider --junitxml=<out>/collection-error.xml tests/test_ok.py tests/test_broken.py` | 2 |
| `junit/no-tests.xml` | `<venv>/Scripts/python.exe -m pytest -p no:cacheprovider --junitxml=<out>/no-tests.xml -k zzz tests/test_ok.py` | 5 |

`<out>` is a folder outside this one. The raw reports were then copied here
with these replacements, and nothing else changed:

- The absolute path of this folder → `&lt;root&gt;` (it reads `<root>`).
- The base interpreter's install folder (the one holding `Lib/importlib`) →
  `&lt;python&gt;` (it reads `<python>`).
- Each `hostname` attribute's value → `&lt;host&gt;` (it reads `<host>`).

Re-running the commands reproduces the reports, apart from `time`,
`timestamp` and the replaced values. No `uv.lock` or `.venv` is committed.
