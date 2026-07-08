// run-eval.mjs — execute one eval case headless and grade it mechanically.
//
//   node run-eval.mjs --case <case.json> --rundir <workspace/iteration-N/eval-name/with_skill> [--model fable]
//
// The harness philosophy: the faithful way to eval an orchestration skill is the real
// runtime — `claude -p` from a pinned GymApp worktree with the rpiv plugin loaded —
// not a subagent simulation. This runner (1) isolates the worktree (wipes prior .rpiv
// review artifacts so the skill cannot read an old answer), (2) invokes the case's
// prompt headless, (3) captures timing/token/cost from the CLI's JSON envelope,
// (4) locates the produced artifact, and (5) runs grade-artifact.mjs over it.
//
// Contamination controls baked in: worktrees are detached at pinned refs; GymApp's
// .rpiv/artifacts is gitignored so historical review artifacts (the ground truth) never
// exist inside a worktree; agent cases write output to the run dir, not the worktree.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];

const casePath = resolve(args.case);
const caseSpec = JSON.parse(readFileSync(casePath, "utf-8"));
const rundir = resolve(args.rundir);
const model = args.model ?? caseSpec.model ?? "fable";
const worktree = caseSpec.worktree;
mkdirSync(join(rundir, "outputs"), { recursive: true });

// 1. isolate: wipe any review artifacts a previous run left in the worktree
for (const rel of caseSpec.clean ?? []) {
	const p = join(worktree, rel);
	if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

// 2. resolve the prompt ({OUT} -> absolute agent-output path inside the run dir)
const outFile = join(rundir, "outputs", "agent-output.md").replaceAll("\\", "/");
let prompt = caseSpec.prompt ?? readFileSync(join(dirname(casePath), caseSpec.prompt_file), "utf-8");
prompt = prompt.replaceAll("{OUT}", outFile);

// 3. run headless claude from the worktree
console.log(`[${caseSpec.id}] claude -p (model=${model}) in ${worktree} ...`);
const t0 = Date.now();
// Prompt goes via stdin — argv quoting on Windows would mangle backticks/quotes/newlines.
// PATH: profile-added tool dirs (opengrep lives in ~/.opengrep/cli/latest, added by the
// user's interactive shell profile) are invisible to headless sessions, which made the
// skills' tool probes report tools "absent" that real interactive runs DO have. Append
// them so eval runs match the environment the user actually reviews in.
const EXTRA_PATH_DIRS = [join(process.env.USERPROFILE ?? "", ".opengrep", "cli", "latest")].filter((d) => existsSync(d));
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = { ...process.env, [pathKey]: [process.env[pathKey], ...EXTRA_PATH_DIRS].filter(Boolean).join(process.platform === "win32" ? ";" : ":") };
const exe = process.platform === "win32" ? "claude.exe" : "claude";
const res = spawnSync(exe, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", model], {
	cwd: worktree,
	input: prompt,
	encoding: "utf-8",
	maxBuffer: 256 * 1024 * 1024,
	env,
});
const wall = Date.now() - t0;
writeFileSync(join(rundir, "cli-output.json"), res.stdout ?? "");
if (res.stderr?.trim()) writeFileSync(join(rundir, "cli-stderr.txt"), res.stderr);

let cli = null;
try {
	cli = JSON.parse(res.stdout.trim().split("\n").filter(Boolean).at(-1));
} catch {
	console.error(`[${caseSpec.id}] could not parse CLI JSON (exit ${res.status}); see cli-output.json`);
}
const u = cli?.usage ?? {};
const timing = {
	total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
	duration_ms: cli?.duration_ms ?? wall,
	total_duration_seconds: Math.round((cli?.duration_ms ?? wall) / 100) / 10,
	total_cost_usd: cli?.total_cost_usd ?? null,
	num_turns: cli?.num_turns ?? null,
	is_error: cli?.is_error ?? res.status !== 0,
};
writeFileSync(join(rundir, "timing.json"), JSON.stringify(timing, null, 2));

// 4. locate the produced artifact
let artifact = null;
if (caseSpec.output === "agent") {
	artifact = existsSync(outFile) ? outFile : null;
} else {
	// newest file matching artifact_glob (a "<dir>/*.md" pattern) in the worktree
	const dir = join(worktree, dirname(caseSpec.artifact_glob));
	if (existsSync(dir)) {
		const cands = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => join(dir, f))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		artifact = cands[0] ?? null;
	}
	if (artifact) cpSync(artifact, join(rundir, "outputs", "artifact.md"));
}
writeFileSync(
	join(rundir, "eval_metadata.json"),
	JSON.stringify({ eval_id: caseSpec.id, eval_name: caseSpec.name, prompt: caseSpec.prompt ?? `(file) ${caseSpec.prompt_file}`, assertions: [] }, null, 2),
);

// 5. grade — but a run the CLI itself reports as errored (session limit, crash) must
// not be graded as if it finished: partial artifacts make precision checks vacuously
// pass. Record the run-level failure and stop.
if (timing.is_error) {
	const reason = (cli?.result ?? "").slice(-200) || `exit ${res.status}`;
	writeFileSync(
		join(rundir, "grading.json"),
		JSON.stringify({ case: caseSpec.id, artifact, expectations: [{ text: "run completed without a CLI-level error", passed: false, evidence: reason }], summary: { passed: 0, failed: 1 } }, null, 2),
	);
	console.error(`[${caseSpec.id}] RUN ERRORED (${Math.round(wall / 1000)}s): ${reason}`);
	process.exit(1);
}
if (!artifact) {
	writeFileSync(
		join(rundir, "grading.json"),
		JSON.stringify({ case: caseSpec.id, artifact: null, expectations: [{ text: "produced artifact exists", passed: false, evidence: "no artifact found" }], summary: { passed: 0, failed: 1 } }, null, 2),
	);
	console.error(`[${caseSpec.id}] NO ARTIFACT PRODUCED (wall ${Math.round(wall / 1000)}s)`);
	process.exit(1);
}
const grade = spawnSync("node", [join(HERE, "grade-artifact.mjs"), "--artifact", artifact, "--repo", worktree, "--case", casePath, "--out", join(rundir, "grading.json")], {
	encoding: "utf-8",
});
console.log(grade.stdout);
console.log(`[${caseSpec.id}] done: ${Math.round(wall / 1000)}s, ${timing.total_tokens} tokens, $${timing.total_cost_usd} — grading ${grade.status === 0 ? "ALL PASS" : "has FAILs"}`);
