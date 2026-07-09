// trigger-eval.mjs — Windows-compatible skill-triggering eval.
//
//   node trigger-eval.mjs --eval-set <queries.json> --skill <name> --desc-file <SKILL.md> [--model opus] [--runs 1]
//
// The skill-creator's run_eval.py detects triggering via select()/os.read() on subprocess
// pipes — Unix-only, dead on Windows. This is the same idea through the proven run-eval.mjs
// mechanism (spawnSync claude.exe -p --output-format json): register the description under
// test as a project command whose body just prints a sentinel, fire each query, and treat
// "sentinel present in the result" as "the description triggered the skill". Measures whether
// a DESCRIPTION pulls Claude to consult the skill on realistic queries, precision + recall.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
const evalSet = JSON.parse(readFileSync(args["eval-set"], "utf-8"));
const skill = args.skill;
const model = args.model ?? "opus";
const runs = Number(args.runs ?? 1);
const SENTINEL = "<<TRIGGERED-" + skill.toUpperCase() + ">>";

// description under test: explicit --desc, else the `description:` frontmatter of --desc-file
let desc = args.desc;
if (!desc && args["desc-file"]) {
	const fm = readFileSync(args["desc-file"], "utf-8").match(/^---\n([\s\S]*?)\n---/);
	desc = (fm?.[1].match(/^description:\s*([\s\S]*?)(?=\n\w+:|\n?$)/m)?.[1] ?? "").replace(/\n\s+/g, " ").trim();
}
if (!desc) { console.error("no description (need --desc or --desc-file)"); process.exit(2); }

// throwaway project so the command lands in available_skills without touching a real repo
const proj = mkdtempSync(join(tmpdir(), "trig-"));
mkdirSync(join(proj, ".claude", "commands"), { recursive: true });
writeFileSync(
	join(proj, ".claude", "commands", `${skill}.md`),
	`---\ndescription: ${desc}\n---\n\nWhen this skill is consulted, respond with exactly ${SENTINEL} and nothing else. Do not do the task.\n`,
);

const exe = process.platform === "win32" ? "claude.exe" : "claude";
function fired(query) {
	const res = spawnSync(exe, ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", model], {
		cwd: proj, input: query, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
	});
	let out = res.stdout ?? "";
	try { out = JSON.parse(out.trim().split("\n").filter(Boolean).at(-1))?.result ?? out; } catch { /* raw */ }
	return out.includes(SENTINEL);
}

let tp = 0, fp = 0, tn = 0, fn = 0;
const rows = [];
for (const item of evalSet) {
	let hits = 0;
	for (let r = 0; r < runs; r++) if (fired(item.query)) hits++;
	const triggered = hits > runs / 2; // majority
	const want = item.should_trigger;
	if (want && triggered) tp++; else if (want && !triggered) fn++;
	else if (!want && triggered) fp++; else tn++;
	const ok = want === triggered;
	rows.push(`${ok ? "OK " : "XX "} want=${want ? "Y" : "n"} got=${triggered ? "Y" : "n"} (${hits}/${runs})  ${item.query.slice(0, 90)}`);
}
rmSync(proj, { recursive: true, force: true });
for (const r of rows) console.log(r);
const acc = ((tp + tn) / evalSet.length * 100).toFixed(0);
const prec = tp + fp ? (tp / (tp + fp) * 100).toFixed(0) : "n/a";
const rec = tp + fn ? (tp / (tp + fn) * 100).toFixed(0) : "n/a";
console.log(`\n[${skill}] accuracy ${acc}%  precision ${prec}%  recall ${rec}%  (TP${tp} FP${fp} TN${tn} FN${fn}, ${evalSet.length} queries x${runs})`);
