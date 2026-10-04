// tests/approve-outward-actions.test.mjs — contract tests for the outward-action
// approval hook (.claude/hooks/approve-outward-actions.mjs), slice S1-outward-ask
// of .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md.
// Seam: the hook process — event JSON on stdin, decision JSON on stdout.
//   "asks"       — exit 0, stdout is exactly one PreToolUse ask object
//   "no opinion" — exit 0, empty stdout

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, ".claude", "hooks", "approve-outward-actions.mjs");
const TEST_TIMEOUT = 60_000;

function runHook(stdin) {
	const res = spawnSync(process.execPath, [HOOK], {
		input: stdin,
		encoding: "utf-8",
		timeout: 10_000,
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

const bashEvent = (command, extra = {}) =>
	JSON.stringify({ tool_name: "Bash", tool_input: { command }, ...extra });
const psEvent = (command) =>
	JSON.stringify({ tool_name: "PowerShell", tool_input: { command } });
const mcpEvent = (toolName) =>
	JSON.stringify({ tool_name: toolName, tool_input: {} });

/** Returns a failure description, or null when the hook asked with `prefix`. */
function askFailure(label, stdin, prefix) {
	const { status, stdout } = runHook(stdin);
	if (status !== 0) return `${label}: exit ${status}`;
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return `${label}: stdout is not one JSON object: ${JSON.stringify(stdout)}`;
	}
	const out = parsed?.hookSpecificOutput;
	const keys = Object.keys(parsed ?? {});
	if (keys.length !== 1 || keys[0] !== "hookSpecificOutput" || !out)
		return `${label}: unexpected shape ${stdout}`;
	if (
		Object.keys(out).sort().join(",") !==
		"hookEventName,permissionDecision,permissionDecisionReason"
	)
		return `${label}: unexpected keys ${stdout}`;
	if (out.hookEventName !== "PreToolUse" || out.permissionDecision !== "ask")
		return `${label}: not a PreToolUse ask ${stdout}`;
	if (
		typeof out.permissionDecisionReason !== "string" ||
		!out.permissionDecisionReason.startsWith(prefix)
	)
		return `${label}: reason ${JSON.stringify(out.permissionDecisionReason)} lacks prefix ${prefix}`;
	if (
		prefix.startsWith("[rpiv-hook] outward action:") &&
		out.permissionDecisionReason.includes("[rpiv-hook] broken input:")
	)
		return `${label}: outward ask carries the broken prefix`;
	return null;
}

function silentFailure(label, stdin) {
	const { status, stdout } = runHook(stdin);
	if (status !== 0) return `${label}: exit ${status}`;
	if (stdout !== "") return `${label}: expected no opinion, got ${stdout}`;
	return null;
}

function expectAsks(cases, prefix, toEvent = bashEvent) {
	const failures = cases
		.map((c) => askFailure(JSON.stringify(c), toEvent(c), prefix))
		.filter(Boolean);
	expect(failures).toEqual([]);
}

function expectSilent(cases, toEvent = bashEvent) {
	const failures = cases
		.map((c) => silentFailure(JSON.stringify(c), toEvent(c)))
		.filter(Boolean);
	expect(failures).toEqual([]);
}

const OUTWARD = "[rpiv-hook] outward action: ";
const BROKEN = "[rpiv-hook] broken input:";

describe("approve-outward-actions hook", () => {
	it(
		"asks before any git push",
		() => {
			expectAsks(
				[
					"git push",
					"git push origin feat/x",
					"git push --force-with-lease",
					"git push --delete origin old",
					"git push origin :old",
					"git push --tags",
					"git subtree push --prefix d origin main",
					"git lfs push origin main",
					"git send-pack origin HEAD:main",
					"git http-push https://example.invalid/r.git main",
				],
				`${OUTWARD}git push`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks before branch or worktree creation only",
		() => {
			expectAsks(
				[
					"git switch -c x",
					"git switch -C x",
					"git switch --create x",
					"git switch --force-create x",
					"git switch --orphan x",
					"git switch -t origin/x",
					"git switch --track origin/x",
					"git checkout -b x",
					"git checkout -B x",
					"git checkout --orphan x",
					"git checkout -t origin/x",
					"git checkout --track origin/x",
					"git branch x",
					"git branch x main",
					"git branch -f x main",
					"git branch -t x origin/x",
					"git branch --track x origin/x",
					"git branch -c a b",
					"git branch -C a b",
					"git branch --copy a b",
					"git branch -m a b",
					"git branch -M a b",
					"git branch --move a b",
					"git stash branch x",
				],
				`${OUTWARD}branch creation`,
			);
			expectAsks(
				["git worktree add ../wt", "git worktree add -b x ../wt"],
				`${OUTWARD}worktree creation`,
			);
			expectSilent([
				"git switch main",
				"git checkout main",
				"git checkout -- file.txt",
				"git branch",
				"git branch --list",
				"git branch --list 'feat/*'",
				"git branch -a",
				"git branch -vv",
				"git branch --show-current",
				"git branch -d x",
				"git branch -D x",
				"git branch -u origin/main",
				"git branch --set-upstream-to=origin/main",
				"git branch --contains HEAD",
				"git branch --merged main",
				"git worktree list",
			]);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for gh writes and unknown gh commands, passes known reads",
		() => {
			expectAsks(
				[
					"gh pr create --title t --body b",
					"gh pr merge 5",
					"gh pr comment 5 -b hi",
					"gh issue create -t t -b b",
					"gh issue comment 3 -b x",
					"gh issue close 3",
					"gh label create bug",
					"gh release create v1",
					"gh repo create o/r",
					"gh workflow run ci.yml",
					"gh api repos/o/r/issues -f title=x",
					"gh api -X POST repos/o/r/labels",
					"gh api --method PATCH repos/o/r",
					"gh api -XDELETE repos/o/r/git/refs/heads/x",
					"gh api --method=POST repos/o/r/labels",
					"gh api -X=DELETE repos/o/r/labels/x",
					"gh api -F n=1 repos/o/r/issues",
					"gh api --field n=1 repos/o/r/issues",
					"gh api --raw-field q=x graphql",
					"gh api --input body.json repos/o/r/issues",
					"gh pr edit 5",
					"gh pr checkout 5",
					"gh pr frobnicate 5",
					"gh frobnicate",
				],
				`${OUTWARD}gh`,
			);
			expectSilent([
				"gh pr view 5",
				"gh pr list",
				"gh pr status",
				"gh pr diff 5",
				"gh pr checks 5",
				"gh issue view 3",
				"gh issue list",
				"gh repo view",
				"gh auth status",
				"gh --version",
				"gh api repos/o/r/pulls",
				"gh api -X GET repos/o/r/pulls",
			]);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for GitHub MCP writes, passes reads",
		() => {
			expectAsks(
				[
					"mcp__github__create_pull_request",
					"mcp__github__merge_pull_request",
					"mcp__plugin_github_github__add_issue_comment",
					"mcp__github__create_branch",
					"mcp__github__push_files",
					"mcp__github__frobnicate",
					"mcp__github__mark_all_notifications_read",
					"mcp__GitHub__create_issue",
					"mcp__github-mcp-server__create_issue",
				],
				`${OUTWARD}GitHub MCP`,
				mcpEvent,
			);
			expect(
				askFailure(
					"create_issue without tool_input",
					JSON.stringify({ tool_name: "mcp__github__create_issue" }),
					`${OUTWARD}GitHub MCP`,
				),
			).toBeNull();
			expectSilent(
				[
					"mcp__github__get_issue",
					"mcp__github__list_pull_requests",
					"mcp__github__search_code",
					"mcp__plugin_github_github__get_file_contents",
					"mcp__GitHub__get_issue",
					"mcp__codescene__code_health_score",
				],
				mcpEvent,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"detects outward actions in compound commands and ignores quoted text",
		() => {
			expectAsks(
				[
					"npm test && git push",
					"npm test; git push",
					"npm test || git push",
					"npm test\ngit push",
					"npm test & git push",
					"ls | gh pr create -t t -b b",
					"(git push)",
					"{ git push; }",
					"if true; then git push; fi",
					"cat <(git push)",
					"GIT_TRACE=1 git push",
					'A=1 B="x y" git push',
					"env git push",
					"command git push",
					"exec git push",
					"nohup git push",
					"time git push",
					"echo origin | xargs git push",
					"echo origin | xargs -n1 git push",
					"env -i git push",
					"sudo git push",
					"timeout 60 git push",
					"nice git push",
					"git -C ../wt push",
					"git -c user.name=x push",
					"git --no-pager push",
					"git -p push",
					"git --git-dir=.git push",
					"git --work-tree ../wt push",
					"git --namespace n push",
					"git -c alias.p=push p",
					'echo "$(git push)"',
					"echo `gh pr create`",
				],
				OUTWARD,
			);
			expectAsks(
				[
					"git push; Write-Host ok",
					"$(git push)",
					"& gh pr create -t t -b b",
					"Start-Process git -ArgumentList push",
					"Start-Job { git push }",
					"Invoke-Command -ScriptBlock { git push }",
				],
				OUTWARD,
				psEvent,
			);
			expectSilent([
				'git commit -m "do not git push"',
				`git commit -m "fix #12: don't push"`,
				"echo 'gh pr create'",
				'rg "git push" docs',
				"git -c alias.st=status st",
				"git status # don't push",
				`git commit -m "$(cat <<'EOF'\ndoesn't push\nEOF\n)"`,
				"git status",
				"git log --oneline",
				"git diff",
				"npm test",
			]);
			expectSilent(["Write-Host 'git push'"], psEvent);
		},
		TEST_TIMEOUT,
	);

	it(
		"normalises quoted, escaped, path-qualified and differently-cased command words",
		() => {
			expectAsks(
				[
					'"git" push',
					"'gh' pr create -t t -b b",
					"g\\it push",
					'git "push"',
					"git\tpush",
					"/usr/bin/gh pr create -t t -b b",
					"gh.exe pr create -t t -b b",
					"git \\\npush",
				],
				OUTWARD,
			);
			expectAsks(
				[
					"g`it push",
					"Git push",
					"GH.EXE pr create -t t -b b",
					"git.exe switch -c x",
					'& "C:\\Program Files\\GitHub CLI\\gh.exe" pr create -t t -b b',
					"git `\npush",
				],
				OUTWARD,
				psEvent,
			);
			expectSilent(['"git" status']);
			expectSilent(["Git status"], psEvent);
		},
		TEST_TIMEOUT,
	);

	it(
		"fails closed on unparseable input",
		() => {
			const raw = [
				"not json",
				"",
				"[]",
				"null",
				'"x"',
				JSON.stringify({ tool_input: { command: "git push" } }),
				JSON.stringify({ tool_name: 7, tool_input: { command: "git push" } }),
				JSON.stringify({ tool_name: "Bash" }),
				JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } }),
			];
			expectAsks(raw, BROKEN, (s) => s);
			expectAsks(
				[
					'git commit -m "unterminated',
					"git commit -m 'unterminated",
					"echo $(git status",
					"echo `git status",
					"$GIT push",
					'"$(which git)" push',
				],
				BROKEN,
			);
			expectAsks(["& $git push"], BROKEN, psEvent);
			expectSilent([""]);
		},
		TEST_TIMEOUT,
	);

	it(
		"inspects wrapper commands and fails closed on dynamic ones",
		() => {
			expectAsks(
				[
					'bash -c "git push"',
					"sh -c 'gh pr create -t t -b b'",
					'zsh -c "git switch -c x"',
					'eval "git push"',
					'pwsh -c "git push"',
					'cmd /c "git push"',
				],
				OUTWARD,
			);
			expectAsks(
				[
					'Invoke-Expression "git push"',
					"iex 'gh pr create -t t -b b'",
					'powershell -Command "git push"',
				],
				OUTWARD,
				psEvent,
			);
			expectAsks(
				[
					'bash -c "$CMD"',
					'eval "$(make_cmd)"',
					"echo 'git push' | bash",
					"pwsh -EncodedCommand Zm9v",
				],
				BROKEN,
			);
			expectAsks(["iex $cmd", "powershell -File x.ps1"], BROKEN, psEvent);
			expectSilent(['bash -c "npm test"', 'eval "echo hi"']);
			expectSilent(['Invoke-Expression "Get-ChildItem"'], psEvent);
		},
		TEST_TIMEOUT,
	);

	it(
		"fails closed on pathological input within the timeout",
		() => {
			const pathological = [
				[`echo ${"a".repeat(70_000 - 5)}`, BROKEN],
				["$(".repeat(10_000), BROKEN],
				// Beyond the contract minimum: wrapper re-parsing must be bounded too.
				// `eval … git push` really pushes, so either ask reason is correct.
				[`${"eval ".repeat(12_000)}git push`, "[rpiv-hook] "],
				[`${"eval ".repeat(12_000)}echo hi`, BROKEN],
			];
			const failures = pathological
				.map(([command, prefix]) => {
					const started = Date.now();
					const failure = askFailure(
						`${command.slice(0, 12)}…${command.slice(-8)} (${command.length} chars)`,
						bashEvent(command),
						prefix,
					);
					const elapsed = Date.now() - started;
					return failure ?? (elapsed > 2_000 ? `took ${elapsed} ms` : null);
				})
				.filter(Boolean);
			expect(failures).toEqual([]);
		},
		TEST_TIMEOUT,
	);

	it("registers the outward hook for Bash, PowerShell and GitHub MCP", () => {
		const registry = JSON.parse(
			readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
		);
		const pre = registry.hooks.PreToolUse;
		const command =
			'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/approve-outward-actions.mjs"';
		const entry = pre.find((e) => e.hooks.some((h) => h.command === command));
		expect(entry).toBeDefined();
		const hook = entry.hooks.find((h) => h.command === command);
		expect(hook.timeout).toBeGreaterThanOrEqual(1);
		expect(hook.timeout).toBeLessThanOrEqual(15);

		const matcher = new RegExp(`^(?:${entry.matcher})$`);
		const matched = [
			"Bash",
			"PowerShell",
			"mcp__github__create_issue",
			"mcp__plugin_github_github__create_issue",
			"mcp__GitHub__create_issue",
			"mcp__github-mcp-server__create_issue",
		];
		const unmatched = [
			"Edit",
			"Write",
			"Read",
			"BashOutput",
			"mcp__codescene__code_health_score",
		];
		expect(matched.filter((t) => !matcher.test(t))).toEqual([]);
		expect(unmatched.filter((t) => matcher.test(t))).toEqual([]);

		expect(pre).toContainEqual({
			matcher: "Edit|Write|Bash",
			hooks: [
				{
					type: "command",
					command:
						'node "${CLAUDE_PLUGIN_ROOT}/.claude/hooks/enforce-readonly-agent.mjs"',
					timeout: 15,
				},
			],
		});
	});

	it(
		"applies in main session and every subagent",
		() => {
			const contexts = [
				{},
				{ agent_type: "general-purpose" },
				{ agent_type: "codebase-analyzer" },
			];
			const pushes = contexts.map((ctx) => runHook(bashEvent("git push", ctx)));
			const failures = contexts
				.map((ctx) =>
					askFailure(
						`git push ${JSON.stringify(ctx)}`,
						bashEvent("git push", ctx),
						`${OUTWARD}git push`,
					),
				)
				.filter(Boolean);
			expect(failures).toEqual([]);
			expect(pushes.map((p) => p.stdout)).toEqual(
				contexts.map(() => pushes[0].stdout),
			);
			expect(
				contexts
					.map((ctx) =>
						silentFailure(
							`git status ${JSON.stringify(ctx)}`,
							bashEvent("git status", ctx),
						),
					)
					.filter(Boolean),
			).toEqual([]);

			// Companion PermissionRequest hook must never auto-allow an asked call.
			const approver = join(
				ROOT,
				".claude",
				"hooks",
				"auto-approve-readonly.mjs",
			);
			const approvals = [
				"Bash",
				"PowerShell",
				"mcp__github__create_pull_request",
			].map(
				(tool) =>
					spawnSync(process.execPath, [approver], {
						input: JSON.stringify({
							agent_type: "codebase-analyzer",
							tool_name: tool,
							tool_input: { command: "git push" },
						}),
						encoding: "utf-8",
						timeout: 10_000,
					}).stdout,
			);
			expect(approvals).toEqual(["", "", ""]);
		},
		TEST_TIMEOUT,
	);
});
