// import-contracts.mjs — import-linter contracts as boundary ground truth for a Python
// root, the way dependency-cruiser's rules are for JS (FR17; D49, D50 of the
// Python-support design, S7-python-graph). It runs the root's own `.venv` lint-imports
// with `--no-cache` (no cache folder is written) and bytecode off; it installs nothing.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/architectural-review/_helpers/import-contracts.mjs" "<target>"
//
// Output (always exit 0), the status line first:
//   import-contracts: ok kept=<k> broken=<b>
//   ---import-contracts---   <contract name> \t KEPT|BROKEN
//   ---broken-contracts---   lint-imports' report of each broken contract (its import chains)
// or `import-contracts: unavailable: <why>` (no lint-imports in the .venv, no
// import-linter config), or `import-contracts: broken: <why>`. lint-imports exits 1 for
// a broken contract and for every error alike, so only its `Contracts: <k> kept, <b>
// broken.` summary line shows that the contracts were checked; without it the run is
// broken, named by its last non-blank line (degrade-distinguishes-broken).
//
// Importable: readLintImports.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isMain } from "../../_shared/is-main.mjs";
import { resolveTargets } from "./target-context.mjs";

const SUMMARY = /^Contracts: (\d+) kept, (\d+) broken\.$/;

/** The broken-contract report after lint-imports' `Broken contracts` heading, without
    blank lines and dash underlines. */
const brokenReport = (lines, from) => {
	const at = lines.indexOf("Broken contracts", from);
	if (at < 0) return [];
	return lines.slice(at + 1).filter((line) => line.trim() && !/^-+$/.test(line.trim()));
};

/** The helper's lines for one lint-imports output (stdout and stderr together). */
export const readLintImports = (text) => {
	const lines = String(text ?? "").replace(/\r/g, "").split("\n");
	const at = lines.findIndex((line) => SUMMARY.test(line));
	if (at < 0) {
		const last = lines.map((line) => line.trim()).filter(Boolean).at(-1);
		return [`import-contracts: broken: ${last ?? "no output"}`];
	}
	const [, kept, broken] = SUMMARY.exec(lines[at]);
	const rows = lines
		.slice(0, at)
		.map((line) => /^(.+) (KEPT|BROKEN)$/.exec(line))
		.filter(Boolean)
		.map(([, name, state]) => `${name}\t${state}`);
	const report = brokenReport(lines, at);
	return [
		`import-contracts: ok kept=${kept} broken=${broken}`,
		"---import-contracts---",
		...rows,
		...(report.length ? ["---broken-contracts---", ...report] : []),
	];
};

/** A tool in the root's `.venv`: `Scripts/<name>.exe` (Windows) or `bin/<name>`. */
export const venvTool = (root, name) =>
	[join(root, ".venv", "Scripts", `${name}.exe`), join(root, ".venv", "bin", name)].find((path) =>
		existsSync(path),
	);

const textOf = (path) => (existsSync(path) ? readFileSync(path, "utf-8") : "");

/** True when the root configures import-linter, by the probe's rule. */
const hasConfig = (root) =>
	existsSync(join(root, ".importlinter")) ||
	/^\[tool\.importlinter(?:\]|\.)/m.test(textOf(join(root, "pyproject.toml"))) ||
	/^\[importlinter(?:\]|:)/m.test(textOf(join(root, "setup.cfg")));

/** The helper's lines for the project root of `argv`'s target. */
const run = (argv) => {
	const { projectRoot: root } = resolveTargets(argv);
	const tool = venvTool(root, "lint-imports");
	if (!tool) return [`import-contracts: unavailable: lint-imports not installed in ${root}/.venv`];
	if (!hasConfig(root)) return ["import-contracts: unavailable: no import-linter config"];
	const src = existsSync(join(root, "src")) ? join(root, "src") : root;
	const res = spawnSync(tool, ["--no-cache"], {
		cwd: root,
		encoding: "utf-8",
		timeout: 120_000,
		env: {
			...process.env,
			PYTHONPATH: [src, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
			PYTHONDONTWRITEBYTECODE: "1",
		},
	});
	if (res.error) return [`import-contracts: broken: ${String(res.error.message).split("\n")[0]}`];
	return readLintImports(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
};

if (isMain(import.meta.url)) {
	process.stdout.write(`${run(process.argv.slice(2)).join("\n")}\n`);
}
