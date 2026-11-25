// Advisory hooks must speak on a channel Claude reads. For PostToolUse and
// PreToolUse that is `hookSpecificOutput.additionalContext` JSON on stdout; for
// SessionStart it is plain stdout. Claude never sees stderr from a hook that exits 0.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HOOKS = fileURLToPath(new URL("../.claude/hooks/", import.meta.url));
const temps = [];
const tempRepo = () => {
	const dir = mkdtempSync(join(tmpdir(), "hooks-speak-"));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const runHook = (name, repo, stdin = "", env = {}) =>
	spawnSync(process.execPath, [join(HOOKS, name)], {
		cwd: repo,
		input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
	});

/** What a hook told Claude: the `additionalContext` of the one JSON object on
    stdout, checked against the event it answered. Empty stdout is silence;
    anything else must parse. */
const spoken = ({ stdout, status }, event = "PostToolUse") => {
	expect(status).toBe(0);
	if (stdout === "") return "";
	const { hookSpecificOutput } = JSON.parse(stdout);
	expect(hookSpecificOutput.hookEventName).toBe(event);
	return hookSpecificOutput.additionalContext;
};

const put = (file, text) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
};
const editOf = (file) => ({
	tool_name: "Write",
	tool_input: { file_path: file },
});

describe("validate-on-write", () => {
	const validate = (validatorBody, { missingValidator = false } = {}) => {
		const repo = tempRepo();
		const artifact = put(
			join(repo, ".rpiv", "artifacts", "reviews", "t.md"),
			"---\nstatus: ready\n---\n",
		);
		const validator = missingValidator
			? join(repo, "no-such-validator.mjs")
			: put(join(repo, "stub-validator.mjs"), validatorBody);
		return spoken(
			runHook("validate-on-write.mjs", repo, editOf(artifact), {
				RPIV_VALIDATOR: validator,
			}),
		);
	};

	it("reports validation findings as additionalContext", () => {
		const said = validate(
			'process.stderr.write("bad frontmatter\\n"); process.exit(1);\n',
		);
		expect(said).toContain("Artifact validation warnings");
		expect(said).toContain("bad frontmatter");
		expect(said).not.toContain("validator broken");
		expect(validate("process.exit(0);\n")).toBe("");
	});

	it("reports a broken validator distinctly", () => {
		const usage = validate(
			'process.stderr.write("usage: ...\\n"); process.exit(2);\n',
		);
		expect(usage).toContain("validator broken");
		expect(usage).toContain("exit 2");
		expect(usage).not.toContain("validation warnings");
		const missing = validate("", { missingValidator: true });
		expect(missing).toContain("validator broken");
		expect(missing).toContain("no-such-validator.mjs");
		expect(missing).not.toContain("validation warnings");
	});

	it("reports a validator that crashes with exit 1 as broken", () => {
		// Node exits 1 on an uncaught exception, the same code as real findings.
		const crashed = validate('throw new Error("boom");\n');
		expect(crashed).toContain("validator broken");
		expect(crashed).toContain("crashed");
		expect(crashed).toContain("Error: boom");
		expect(crashed).not.toContain("validation warnings");
		// A finding whose own text mentions an error is still a finding.
		const finding = validate(
			'process.stderr.write("ERROR a.md: Error: at line 3\\n"); process.exit(1);\n',
		);
		expect(finding).toContain("Artifact validation warnings");
		expect(finding).not.toContain("validator broken");
	});

	it("reports a store-managed edit as additionalContext", () => {
		const repo = tempRepo();
		const record = put(
			join(repo, ".rpiv", "artifacts", "architecture-reviews", "r.json"),
			"{}",
		);
		const said = spoken(runHook("validate-on-write.mjs", repo, editOf(record)));
		expect(said).toContain("store-managed");
		expect(said).toContain("store.mjs");
	});
});

describe("fence-duplication-check", () => {
	const project = () => {
		const repo = tempRepo();
		const plan = join(repo, ".rpiv", "artifacts", "plans", "p.md");
		return { repo, plan };
	};
	const fenced = "# Plan\n\n```javascript\nconst a = 1;\n```\n";

	it("reports duplicated fences as additionalContext", () => {
		const { repo, plan } = project();
		put(plan, fenced);
		// A stub detector that reports one clone between the fence and a repo file.
		const cpd = put(
			join(repo, "stub-cpd.js"),
			`const { mkdirSync, writeFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const fenceDir = args[0];
const out = args[args.indexOf("-o") + 1];
mkdirSync(out, { recursive: true });
const fence = join(fenceDir, readdirSync(fenceDir)[0]);
writeFileSync(join(out, "jscpd-report.json"), JSON.stringify({ duplicates: [{
  lines: 12, tokens: 80,
  firstFile: { name: fence, start: 1, end: 12 },
  secondFile: { name: ${JSON.stringify(join(repo, "lib", "existing.mjs"))}, start: 3, end: 14 },
}] }));
`,
		);
		const said = spoken(
			runHook("fence-duplication-check.mjs", repo, editOf(plan), {
				RPIV_CPD_BIN: cpd,
			}),
		);
		const lines = said.split("\n");
		expect(lines[0]).toContain(
			"Duplication: 1 code fence region(s) in p.md re-emit code that already exists",
		);
		// The fence marker is on line 3; its body's first line is line 4.
		expect(lines[1]).toContain("p.md:4 [target unknown");
		expect(lines[2]).toContain(
			"duplicates lib/existing.mjs:3-14  (80 tokens, 12 lines)",
		);
		expect(lines.at(-1)).toContain("Import or extract the existing code");
	});

	it("reports a skipped check as additionalContext", () => {
		const { repo, plan } = project();
		put(plan, fenced);
		const said = spoken(
			runHook("fence-duplication-check.mjs", repo, editOf(plan), {
				RPIV_CPD_BIN: join(repo, "no-such-cpd"),
			}),
		);
		expect(said).toContain("Duplication check SKIPPED for p.md");
		expect(said).toContain("no-such-cpd");
		expect(said).toContain("1 code fence(s) went unchecked");

		put(plan, "# Plan\n\nProse only, no fences.\n");
		expect(
			spoken(runHook("fence-duplication-check.mjs", repo, editOf(plan))),
		).toBe("");
	});
});

describe("cache-sync-check", () => {
	it("reports cache drift as additionalContext", () => {
		const repo = tempRepo();
		const cache = join(repo, "cache");
		put(
			join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "rpiv", version: "9.9.9" }),
		);
		const skill = put(join(repo, "skills", "demo", "SKILL.md"), "same\n");
		const cached = put(join(cache, "skills", "demo", "SKILL.md"), "same\n");
		const run = () =>
			spoken(
				runHook("cache-sync-check.mjs", repo, editOf(skill), {
					RPIV_CACHE_ROOT: cache,
				}),
			);
		expect(run()).toBe("");
		writeFileSync(cached, "OLD\n");
		expect(run()).toContain("OUT OF SYNC for skills/demo/SKILL.md");
	});
});

describe("enforce-readonly-agent", () => {
	const guard = (command) => {
		const repo = tempRepo();
		put(join(repo, "agents", "shell-agent.md"), "---\ntools: Read, Bash\n---\n");
		return runHook(
			"enforce-readonly-agent.mjs",
			repo,
			{
				agent_type: "shell-agent",
				tool_name: "Bash",
				tool_input: { command },
			},
			{ RPIV_AGENTS_DIR: join(repo, "agents") },
		);
	};

	it("tells the agent about a destructive command without blocking it", () => {
		const run = guard("git push origin main");
		const said = spoken(run, "PreToolUse");
		expect(said).toContain(
			'agent "shell-agent" running potentially destructive Bash: git push origin main',
		);
		// Advisory: no permission decision, so the normal permission flow decides.
		expect(JSON.parse(run.stdout).hookSpecificOutput).not.toHaveProperty(
			"permissionDecision",
		);
		expect(spoken(guard("git status"), "PreToolUse")).toBe("");
	});
});

describe("session-state-restore", () => {
	const writeState = (repo, text) =>
		put(join(repo, ".rpiv", ".claude", "session-state.json"), text);

	it("reports a corrupt state file on stdout", () => {
		const repo = tempRepo();
		writeState(repo, "{not json");
		const { stdout, status } = runHook("session-state-restore.mjs", repo);
		expect(status).toBe(0);
		expect(stdout).toContain("session state file is corrupt");
		expect(stdout).not.toContain("Session restored");
	});

	it("stays silent with no state file", () => {
		const { stdout, status } = runHook("session-state-restore.mjs", tempRepo());
		expect(status).toBe(0);
		expect(stdout).toBe("");
	});
});
