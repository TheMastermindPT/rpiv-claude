// run-all-tests.mjs — the one command that runs every test file (`npm test`).
//
// The plugin has two kinds of test file:
//   - vitest suites under tests/ (and the four `skills/_shared/*.test.ts` suites);
//   - plain `node <file>.test.mjs` scripts beside their sources (hooks, shared
//     helpers, skill helpers, eval harness), each exiting non-zero on failure.
// This runs vitest first, then every script, and fails when either fails.
//
//   node scripts/run-all-tests.mjs [--scripts-only] [--root <dir>]
//
// Each unit (vitest as a whole, then each script) gets one line: `ok <unit>`,
// `skip <unit>` or `FAILED <unit> (<how>)`. `skip` is a script that exited 0 but
// printed a notice that part or all of it did not run (a missing optional tool);
// its notice lines follow, indented. It is not a failure and it is never shown as a
// plain `ok`. The last stdout line is `run-all-tests: <n> failed of <m>`, with
// ` (<k> reported a skip)` when any did, or `run-all-tests: broken: <why>`.
//
// Exit 0: nothing failed. Exit 1: at least one unit failed. Exit 2: the run is
// broken (unknown option, unreadable root, vitest not installed, or no test script
// found — an empty discovery is never a pass).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: run-all-tests.mjs [--scripts-only] [--root <dir>]";

// Folders never searched for scripts, as paths from the root: vitest's own tree,
// the generated OpenCode copies of the same scripts, and tool output.
const SKIPPED_FOLDERS = new Set([
	"tests",
	"opencode/generated",
	"coverage",
	"reports",
]);
// Folder names skipped at any depth.
const SKIPPED_NAMES = new Set(["node_modules", ".git", ".stryker-tmp"]);
const MAX_SHOWN_LINES = 40;
// How the scripts say "this did not run": an upper-case SKIP/SKIPPED anywhere, or a
// parenthesised aside that says `skipped`. A passing line that merely talks about
// skipping (`OK — skip dirs: …`, `… dead-exports skipped (delegated)`) is neither.
const SKIP_NOTICE = /\bSKIP(PED)?\b|^\s*\(.*\bskipped\b/;

class Broken extends Error {}

function parseArgs(argv) {
	const options = { scriptsOnly: false, root: PLUGIN_ROOT };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--scripts-only") options.scriptsOnly = true;
		else if (argv[i] === "--root" && argv[i + 1]) options.root = resolve(argv[++i]);
		else throw new Broken(`unknown or incomplete option ${argv[i]}; ${USAGE}`);
	}
	return options;
}

/** Every `*.test.mjs` script under `root`, as sorted `/`-separated paths from it. */
function findScripts(root) {
	const found = [];
	const walk = (rel) => {
		let entries;
		try {
			entries = readdirSync(join(root, rel), { withFileTypes: true });
		} catch (err) {
			throw new Broken(`cannot read ${join(root, rel)}: ${err.code ?? err.message}`);
		}
		for (const entry of entries) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED_NAMES.has(entry.name) && !SKIPPED_FOLDERS.has(path)) walk(path);
			} else if (entry.name.endsWith(".test.mjs")) {
				found.push(path);
			}
		}
	};
	walk("");
	return found.sort();
}

/** Runs one script; resolves `{ unit, status, output }` (never rejects). */
const runScript = (root, script) =>
	new Promise((done) => {
		const child = spawn(process.execPath, [script], { cwd: root });
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => chunks.push(chunk));
		const finish = (status) =>
			done({ unit: script, status, output: Buffer.concat(chunks).toString("utf8") });
		child.on("error", (err) => finish(`did not start: ${err.code ?? err.message}`));
		child.on("close", (code, signal) => finish(code ?? signal));
	});

/** Runs `tasks` (functions returning promises) at most `limit` at a time, in order. */
async function inBatches(tasks, limit) {
	const results = [];
	for (let i = 0; i < tasks.length; i += limit) {
		results.push(...(await Promise.all(tasks.slice(i, i + limit).map((run) => run()))));
	}
	return results;
}

const linesOf = (output) => output.trimEnd().split(/\r?\n/);
const indented = (lines) => lines.map((line) => `    ${line}`);

/** A result's verdict: `failed`, `skip` (passed but said part of it did not run)
    or `ok`, with the lines that explain it. */
function verdictOf({ status, output }) {
	if (status !== 0) return { verdict: "failed", shown: linesOf(output).slice(-MAX_SHOWN_LINES) };
	const notices = linesOf(output)
		.filter((line) => SKIP_NOTICE.test(line))
		.map((line) => line.trim());
	return { verdict: notices.length > 0 ? "skip" : "ok", shown: notices };
}

/** Prints one unit's report and returns its verdict. */
function report(result) {
	const { verdict, shown } = verdictOf(result);
	const how = typeof result.status === "number" ? `exit ${result.status}` : result.status;
	const head = verdict === "failed" ? `FAILED ${result.unit} (${how})` : `${verdict} ${result.unit}`;
	console.log([head, ...indented(shown)].join("\n"));
	return verdict;
}

/** Runs every script under `root`; returns each one's verdict. */
async function runScripts(root) {
	const scripts = findScripts(root);
	if (scripts.length === 0) throw new Broken("no test scripts found");
	const limit = Math.max(1, Math.min(4, availableParallelism()));
	const results = await inBatches(
		scripts.map((script) => () => runScript(root, script)),
		limit,
	);
	return results.map(report);
}

/** Runs the vitest suites with this terminal's output; returns `ok` or `failed`.
    Vitest prints its own report (skipped tests included), so only the verdict line
    is added. A vitest that is not installed is a broken run, not a failed test. */
function runVitest(root) {
	const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
	if (!existsSync(vitest)) throw new Broken(`vitest not found at ${vitest}`);
	const run = spawnSync(process.execPath, [vitest, "run"], { cwd: root, stdio: "inherit" });
	if (run.error) throw new Broken(`vitest did not start: ${run.error.code ?? run.error.message}`);
	const verdict = run.status === 0 ? "ok" : "failed";
	console.log(verdict === "ok" ? "ok vitest" : `FAILED vitest (exit ${run.status ?? run.signal})`);
	return verdict;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	// Discover before running anything, so a broken discovery costs no vitest run.
	if (findScripts(options.root).length === 0) throw new Broken("no test scripts found");
	const verdicts = [
		...(options.scriptsOnly ? [] : [runVitest(options.root)]),
		...(await runScripts(options.root)),
	];
	const count = (verdict) => verdicts.filter((v) => v === verdict).length;
	const skips = count("skip") > 0 ? ` (${count("skip")} reported a skip)` : "";
	console.log(`run-all-tests: ${count("failed")} failed of ${verdicts.length}${skips}`);
	return count("failed") === 0 ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		if (!(err instanceof Broken)) console.error(err);
		console.log(`run-all-tests: broken: ${err.message}`);
		process.exit(2);
	},
);
