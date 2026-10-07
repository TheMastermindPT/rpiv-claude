// tests/approve-outward-actions.test.mjs — contract tests for the outward-action
// approval hook (.claude/hooks/approve-outward-actions.mjs), slice S1-outward-ask
// of .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md.
// Seam: the hook process — event JSON on stdin, decision JSON on stdout.
//   "asks"       — exit 0, stdout is exactly one PreToolUse ask object
//   "no opinion" — exit 0, empty stdout

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { git, makeFixtures } from "./helpers/git-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, ".claude", "hooks", "approve-outward-actions.mjs");
// Some behaviors spawn over a hundred hook processes.
const TEST_TIMEOUT = 120_000;

// Every event runs in a fixture repository (S2): by default on the approved
// branch `feat/ok`, so commit gating stays out of the S1 oracles.
const FX = makeFixtures();
afterAll(() => FX.cleanup());

function runHook(stdin, nodeArgs = [], spawnOptions = {}) {
	const res = spawnSync(process.execPath, [...nodeArgs, HOOK], {
		input: stdin,
		encoding: "utf-8",
		timeout: 10_000,
		...spawnOptions,
	});
	return { status: res.status, stdout: res.stdout ?? "" };
}

const bashEvent = (command, extra = {}) =>
	JSON.stringify({
		tool_name: "Bash",
		tool_input: { command },
		cwd: FX.ok,
		...extra,
	});
const psEvent = (command, extra = {}) =>
	JSON.stringify({
		tool_name: "PowerShell",
		tool_input: { command },
		cwd: FX.ok,
		...extra,
	});
const mcpEvent = (toolName) =>
	JSON.stringify({ tool_name: toolName, tool_input: {} });

/** Returns a failure description, or null when the hook asked with `prefix`. */
function askFailure(label, stdin, prefix, nodeArgs = []) {
	const { status, stdout } = runHook(stdin, nodeArgs);
	if (status !== 0) return `${label}: exit ${status}`;
	const out = parseAskObject(stdout);
	if (typeof out === "string") return `${label}: ${out}`;
	const problem = reasonProblem(out.permissionDecisionReason, prefix);
	return problem ? `${label}: ${problem}` : null;
}

const ASK_KEYS = "hookEventName,permissionDecision,permissionDecisionReason";

/** The `hookSpecificOutput` of exactly one PreToolUse ask object, or a problem. */
function parseAskObject(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return `stdout is not one JSON object: ${JSON.stringify(stdout)}`;
	}
	const out = parsed?.hookSpecificOutput;
	const keys = Object.keys(parsed ?? {});
	if (keys.join(",") !== "hookSpecificOutput" || !out)
		return `unexpected shape ${stdout}`;
	if (Object.keys(out).sort().join(",") !== ASK_KEYS)
		return `unexpected keys ${stdout}`;
	const isAsk =
		out.hookEventName === "PreToolUse" && out.permissionDecision === "ask";
	return isAsk ? out : `not a PreToolUse ask ${stdout}`;
}

/** A reason must start with `prefix`; an outward reason never carries the
    broken prefix. */
function reasonProblem(reason, prefix) {
	if (typeof reason !== "string" || !reason.startsWith(prefix))
		return `reason ${JSON.stringify(reason)} lacks prefix ${prefix}`;
	const outwardAsk = prefix.startsWith("[rpiv-hook] outward action:");
	if (outwardAsk && reason.includes("[rpiv-hook] broken input:"))
		return "outward ask carries the broken prefix";
	return null;
}

function silentFailure(label, stdin) {
	const { status, stdout } = runHook(stdin);
	if (status !== 0) return `${label}: exit ${status}`;
	if (stdout !== "") return `${label}: expected no opinion, got ${stdout}`;
	return null;
}

// Soft assertions: one run reports every failing case group, not only the first.
function expectAsks(cases, prefix, toEvent = bashEvent) {
	const failures = cases
		.map((c) => askFailure(JSON.stringify(c), toEvent(c), prefix))
		.filter(Boolean);
	expect.soft(failures).toEqual([]);
}

function expectSilent(cases, toEvent = bashEvent) {
	const failures = cases
		.map((c) => silentFailure(JSON.stringify(c), toEvent(c)))
		.filter(Boolean);
	expect.soft(failures).toEqual([]);
}

const rawEvent = (s) => s;

const OUTWARD = "[rpiv-hook] outward action: ";
const BROKEN = "[rpiv-hook] broken input:";
const COMMIT_GATE = "[rpiv-hook] commit off an approved branch:";
const MARKER = "[rpiv-hook] approval marker:";

// S2 events run in a named fixture: `in_(FX.main)` builds Bash events there.
const in_ = (cwd) => (command) => bashEvent(command, { cwd });
const psIn = (cwd) => (command) => psEvent(command, { cwd });
const quoted = (path) => `"${path}"`;

/** One soft assertion for `command` run in each fixture, labelled by fixture. */
function expectAsksInEach(repos, command, prefix) {
	const failures = repos
		.map((cwd) =>
			askFailure(
				`${JSON.stringify(command)} in ${cwd.split("/").pop()}`,
				bashEvent(command, { cwd }),
				prefix,
			),
		)
		.filter(Boolean);
	expect.soft(failures).toEqual([]);
}

/** The hook asks broken and its reason contains `text` (S2 revision 1). */
function brokenWithFailure(label, stdin, text, spawnOptions) {
	const { status, stdout } = runHook(stdin, [], spawnOptions);
	if (status !== 0) return `${label}: exit ${status}`;
	const out = parseAskObject(stdout);
	if (typeof out === "string") return `${label}: ${out}`;
	const reason = out.permissionDecisionReason;
	if (!reason.startsWith(BROKEN) || !reason.includes(text))
		return `${label}: reason ${JSON.stringify(reason)} lacks ${BROKEN} … ${text}`;
	return null;
}

/** Milliseconds one hook decision takes. */
function decisionMs(stdin) {
	const started = Date.now();
	runHook(stdin);
	return Date.now() - started;
}

// S2 revision-1 cases (D14 "S2 revision 1"), kept here so test bodies stay short.
const S2_REV1 = (() => {
	const ok = quoted(FX.ok);
	const main = quoted(FX.main);
	const root = quoted(FX.root);
	return {
		gateAtOk: ["git symbolic-ref HEAD refs/heads/main && git commit -m x"],
		gateAtMain: ["git-commit -m x", 'bash -c "git commit -m x"'],
		silentAtMain: ["git merge feat/x", "git revert HEAD", "git rebase main"],
		brokenAtMain: [
			`cd ${ok} & git commit -m x`,
			`cd ${ok} | cat; git commit -m x`,
			`env cd ${ok}; git commit -m x`,
			`nohup cd ${ok}; git commit -m x`,
			`function cd { :; }; cd ${ok} && git commit -m x`,
			`git commit -m "$(cd ${ok}; echo m)"`,
			`(cd ${ok}) && git commit -m x`,
			`pushd ${ok} && popd && git commit -m x`,
		],
		brokenAtOk: [
			`eval 'cd ${main}'; git commit -m x`,
			`builtin cd ${main} && git commit -m x`,
			`CDPATH=${FX.root}/cdp cd sub && git commit -m x`,
			"GIT_WORK_TREE=x git commit -m x",
			"git --work-tree=x commit -m x",
			"export GIT_DIR=x; git commit -m x",
		],
		brokenPsAtOk: [
			"[Environment]::SetEnvironmentVariable('GIT_DIR', 'x'); git commit -m x",
			"$env:GIT_WORK_TREE='x'; git commit -m x",
		],
		gateFollowed: [`cd ${root} && cd main && git commit -m x`],
		silentFollowed: [`cd ${root} && git -C ok commit -m x`],
		silentPsAtPlain: [
			`sl ${ok}; git commit -m x`,
			`chdir ${ok}; git commit -m x`,
			`Push-Location ${ok}; git commit -m x`,
		],
		markerSpellings: [
			"git config branch.main.rpiv''Approved true",
			"git config branch.main.rpiv\\Approved true",
			"git config branch.main.rpivApp'roved' true",
		],
		markerComputed: ["K=rpivApp; git config branch.main.${K}roved true"],
		manyCommits: "git commit -m x; ".repeat(2000),
		nineDirs: FX.nine
			.map((dir) => `cd ${quoted(dir)} && git commit -m x`)
			.join("; "),
	};
})();

// S2 revision-2 cases (D14 "S2 revision 2").
const S2_REV2 = (() => {
	const ok = quoted(FX.ok);
	const main = quoted(FX.main);
	const execPath = git(FX.ok, "--exec-path").replaceAll("\\", "/");
	return {
		refusedCd: [`cd ${ok} extra; git commit -m x`],
		wholeWordSilent: [
			'git commit -m "Set up CI/CD"',
			"git add ci/cd && git commit -m x",
		],
		brokenAtMain: [`echo x | cd ${ok}; git commit -m x`],
		brokenPsAtMain: [`Push-Location ${ok} | Out-Null; git commit -m x`],
		brokenAtOk: [
			"source x.sh && git commit -m x",
			". x.sh && git commit -m x",
			"alias c=cd; git commit -m x",
		],
		brokenPsAtOk: [
			"Pop-Location; git commit -m x",
			`iex 'cd ${main}'; git commit -m x`,
			"Set-Item env:GIT_DIR x; git commit -m x",
			"New-Item env:GIT_WORK_TREE -Value x; git commit -m x",
		],
		silentAtOk: ["git add . && git commit -m x"],
		silentAtMain: [
			`pushd ${ok} && git commit -m x && popd`,
			`cd ${ok} && git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`,
		],
		markerThroughAlias: [
			"K=rpivApp; git -c alias.cf=config cf branch.main.${K}roved true",
			`K=rpivApp; "${execPath}/git-config" branch.main.\${K}roved true`,
		],
		crowded: `git commit -m x ${"git ".repeat(65)}`,
	};
})();

/** The hook imported by a process started without a script path. */
function importedHookAsk(event) {
	const url = pathToFileURL(HOOK).href;
	const res = spawnSync(
		process.execPath,
		["--input-type=module", "-e", `await import(${JSON.stringify(url)})`],
		{ input: event, encoding: "utf-8", timeout: 10_000 },
	);
	return res.stdout ?? "";
}

/** `headState` after the git time budget is spent (a child process). */
function headStateWithoutBudget(dir) {
	const url = pathToFileURL(join(ROOT, ".claude", "hooks", "_git-branch.mjs"));
	const code = `const m = await import(${JSON.stringify(url.href)}); m.limitGitTime(0); console.log(JSON.stringify(m.headState(${JSON.stringify(dir)})));`;
	const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		encoding: "utf-8",
		timeout: 10_000,
	});
	return res.stdout ?? "";
}

// Revision-2 cases of "inspects wrapper commands and fails closed on dynamic
// ones" (B9), kept here so the test body stays readable.
const WRAPPERS_REV2 = {
	outward: [
		'bash -c -x "git push"',
		'sh -c -- "git push"',
		'bash -c -o pipefail "git push"',
		'bash -c -O extglob "git push"',
		'bash -O extglob -c "git push"',
		'bash +O extglob -c "git push"',
		'bash -c +O extglob "git push"',
		'bash -c --rcfile r "git push"',
		'bash -lc "git push"',
		'su -c "git push"',
		'su root -c "git push"',
		'su --command="git push"',
		"su --command 'git push'",
		"su -c'git push'",
		'env -S "git push"',
		'env --split-string="git push"',
		'env --split-string "git push"',
		"env -S'git push'",
		"trap 'git push' EXIT",
		"trap -- 'git push' EXIT",
		'parallel "git push" ::: origin',
		"watch 'git push'",
		"watch -n 5 'git push'",
		"watch --interval 5 'git push'",
		"script -c 'git push'",
		"script --command 'git push'",
		"flock /tmp/l -c 'git push'",
		"flock /tmp/l --command 'git push'",
		"runuser -c 'git push' x",
		"runuser --command='git push' x",
		"sg grp -c 'git push'",
		"sg grp 'git push'",
		'cmd /k "git push"',
		'cmd /d /c "git push"',
	],
	outwardPs: [
		'[scriptblock]::Create("git push")',
		"pwsh -Command Write-Host 'git push'",
		'powershell -ExecutionPolicy Bypass -Command "git push"',
	],
	broken: [
		'su -c "$CMD"',
		'trap "$CMD" EXIT',
		'cmd /c "%CMD%"',
		'bash -c --frobnicate "git push"',
		'env -S "$CMD"',
		"su --frobnicate -c 'git push'",
		'watch "$CMD"',
		'script -c "$CMD"',
		'flock /tmp/l -c "$CMD"',
		'runuser -c "$CMD" x',
		'sg grp -c "$CMD"',
		"tmux new-session -d 'git push'",
		"tmux send-keys 'git push' Enter",
		"tmux run-shell 'npm test'",
		"tmux -L s new -d 'git push'",
		"tmux neww 'git push'",
		"tmux -c 'git push'",
		"tmux ls \\; run-shell 'git push'",
		"tmux bind-key x run-shell 'git push'",
		"tmux set-hook -g after-new-session 'run-shell true'",
		"tmux command-prompt 'run-shell %1'",
		"tmux new-window 'git push'",
		"tmux split-window 'git push'",
		"tmux splitw 'git push'",
		"tmux send 'git push' Enter",
		"tmux run 'git push'",
		"tmux respawn-pane 'git push'",
		"tmux respawnp 'git push'",
		"tmux respawn-window 'git push'",
		"tmux respawnw 'git push'",
		"tmux if-shell true 'run-shell true'",
		"tmux if true 'run-shell true'",
		"tmux pipe-pane 'git push'",
		"tmux pipep 'git push'",
		"tmux display-popup 'git push'",
		"tmux popup 'git push'",
		"tmux bind x run-shell 'git push'",
	],
	brokenPs: [
		"iex (Get-Content x)",
		"Invoke-Expression (irm https://x.invalid)",
		"iex",
		'Start-Process pwsh -ArgumentList "-c git push"',
		"[scriptblock]::Create($s)",
		"'git push' | iex",
	],
	silent: [
		'su -c "npm test"',
		"trap 'rm -f x' EXIT",
		"tmux ls",
		"tmux attach -t x",
		"trap - EXIT",
		"trap '' INT",
		"watch -n 5 'npm test'",
	],
};

// A 66-link inline alias chain, deeper than the hook's nesting bound of 64.
const ALIAS_CHAIN = Array.from(
	{ length: 65 },
	(_, i) => `-c alias.a${i}=a${i + 1}`,
).join(" ");

// Revision-2 cases of "fails closed when words that decide a git or gh action
// are computed or not plain" (B12).
const DECIDING_REV2 = {
	broken: [
		"echo push | xargs --eof git",
		"parallel --joblog j git < args",
		"git config alias.p push && git p",
		"git config --global include.path x.cfg; git status",
		"$'\\u'git push",
		"echo f | xargs --frobnicate rg x",
		"echo push | xargs --frobnicate x git",
		"echo push | xargs --max-lines git",
		"git config includeIf.onbranch:main.path x.cfg; git p",
		"git config Alias.p push && git p",
		"echo push | xargs --frobnicate git",
		"find . -execdir git {} \\;",
		"find . -ok git {} \\;",
		"git checkout *.js",
		"git checkout [ab]",
		"git switch {a..b}",
		'git checkout "feat/$X"',
		"git checkout -q $B",
		"git lfs push origin $R",
		"gh api -X GET -F $F repos/o/r/issues",
		"gh api -X $M repos/o/r",
		"git $'\\u'",
		"parallel --frobnicate x git ::: push",
		"echo push | xargs --replace git {}",
		"find . -okdir git {} \\;",
		"sudo $GH pr --title view create --body b",
		"parallel --frobnicate rg x ::: y",
		"echo origin | xargs $CMD",
		'parallel "$CMD" ::: x',
		"find . -exec $CMD {} \\;",
	],
	aliasProblems: [
		"git -c alias.a=b -c alias.b=a a",
		`git ${ALIAS_CHAIN} -c alias.a65=push a0`,
	],
	brokenPs: [
		'git ("push")',
		"git ('pu'+'sh') origin",
		'gh ("pr") create -t t -b b',
		'Start-Process git -ArgumentList ("push")',
		"Set-Item env:GIT_CONFIG_COUNT 1; git p",
		"[Environment]::SetEnvironmentVariable('GIT_CONFIG_COUNT','1'); git p",
		"${env:GIT_CONFIG_COUNT}=1; git p",
		"New-Item env:GIT_CONFIG_COUNT -Value 1; git p",
	],
	silent: [
		'git --git-dir="$D" status',
		'git --work-tree "$W" status',
		"echo $X browse",
		"echo $X search issues bug",
		"git config user.name x && git status",
		"git config --get alias.p",
		"sudo --frobnicate git status",
		"echo f | xargs -n 1 rg x",
		"echo f | xargs -I {} rg {}",
	],
};

// Revision-3 cases of B9 and B12.
const WRAPPERS_REV3 = {
	outwardPs: [
		'iex -Command:"git push"',
		"Invoke-Expression -Command:'git push'",
		'[scriptblock]::Create("git push").Invoke()',
	],
};
const DECIDING_REV3 = {
	broken: [
		"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push bash -c 'git p'",
		"GIT_CONFIG_GLOBAL=x.cfg sh -c 'git p'",
		"git config alias.p push && bash -c 'git p'",
		'alias g="$(which git)"; g push',
		"alias g=$GIT; g push",
		"echo 'push origin main' | xargs git-lfs",
		"parallel ::: 'git push'",
		"echo 'git push' | parallel",
		"echo push | xargs -i git {}",
		"echo push | xargs -e git",
		"echo push | xargs -l git",
	],
	brokenPs: [
		"$env:GIT_CONFIG_COUNT=1; $env:GIT_CONFIG_KEY_0='alias.p'; $env:GIT_CONFIG_VALUE_0='push'; iex 'git p'",
		"Set-Alias g (Get-Command git); g push",
		"sal g $gitPath; g push",
		"Start-Process -ArgumentList push -FilePath git",
		"start -ArgumentList push git",
		'Start-Process -ArgumentList "pr create -t t -b b" -FilePath gh',
	],
	outwardPs: ["Start-Process -FilePath:git -ArgumentList:push"],
};

// Revision-4 cases of B12, B14 and B15.
const REV4 = {
	computedRun: [
		"sudo $GIT $SUB origin main",
		"command $GIT $SUB origin main",
		"env $GIT -c include.path=x.cfg p",
		"if $GIT $SUB origin main; then :; fi",
	],
	fedCommandsSilent: [
		"echo x | flock /tmp/l rg x",
		"echo x | runuser -u root -- npm test",
		"ps aux | grep su",
		"echo x | sudo -s ls",
	],
	fedShells: ["runuser -u root -- bash", "flock /tmp/l bash", "sudo su"],
	placedSilent: [
		"watch git status",
		"watch -n 2 git status",
		"eval git status",
		"flock /tmp/l git fetch",
		"runuser -u root -- git status",
		"sed -n 1,20p skills/_shared/git-context.mjs",
		"node scripts/git-hooks.mjs",
	],
	placedSilentPs: [
		"$b = git branch --show-current",
		"$prs = gh pr list",
		"$null = git fetch",
		"[string]$b = git branch",
		"foreach ($f in git ls-files) { $f }",
	],
	unplaced: [
		"env -a x npm exec gh",
		"env --frobnicate mytool git",
		"doas -a x mytool git",
		"sudo --no-update mytool git",
		"bash -c 'mytool git'",
		"mytool git-status",
	],
};

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
			// Revision 2: a `git-<name>` program is `git <name>`.
			expectAsks(
				[
					"git-lfs push origin main",
					"git-push origin main",
					"/usr/lib/git-core/git-push origin main",
				],
				`${OUTWARD}git push`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"deleting a local branch asks (its approval marker goes with it)",
		() => {
			// S26 (D36): git deletes `branch.<name>.rpivApproved` with the branch,
			// so a delete asks; the S2-era silent pins for -d, -D and --delete moved here.
			expectAsks(
				[
					"git branch -d x",
					"git branch -D x",
					"git branch --delete x",
					"git branch -dr origin/x",
					"git branch -Dq x",
					"git -C repo branch -D x",
				],
				`${OUTWARD}branch deletion`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"delete abbreviations and joined upstream values",
		() => {
			// S26 revision 1: git accepts a unique abbreviation of --delete; `-u`
			// takes the rest of its cluster as the upstream name.
			expectAsks(["git branch --del x", "git branch --dele x"], `${OUTWARD}branch deletion`);
			expectSilent(["git branch -udev", "git branch -uorigin/dev"]);
			// S26 revision 2: `-t` takes the rest of its cluster too (`--track=direct`).
			expectAsks(["git branch -tdirect x origin/x"], `${OUTWARD}branch creation`);
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
				"git branch -u origin/main",
				"git branch --set-upstream-to=origin/main",
				"git branch --contains HEAD",
				"git branch --merged main",
				"git worktree list",
			]);
			// Revision 1: a redirection target is not a branch name; one pin per
			// query option, and a creation next to them.
			expectSilent([
				"git branch >out",
				"git branch --all",
				"git branch --remotes",
				"git branch --verbose",
				"git branch --no-contains HEAD",
				"git branch --no-merged main",
				"git branch --points-at HEAD",
				"git branch --format='%(refname)'",
				"git branch --sort=-committerdate",
				"git branch --column",
				"git branch --no-column",
				"git branch --unset-upstream",
				"git branch --edit-description",
				"git branch -r",
				"git branch -l",
			]);
			expectAsks(["git branch --force x main"], `${OUTWARD}branch creation`);
			// Revision 2: display options do not switch to list mode; creation flags
			// inside short-option clusters still create.
			expectAsks(
				[
					"git branch -v x",
					"git branch --verbose x",
					"git branch --format='%(refname)' x",
					"git branch --sort=-committerdate x",
					"git branch --column x",
					"git branch --no-column x",
					"git branch -vv x",
					"git checkout -qb x",
					"git checkout -bq x",
					"git switch -qc x",
				],
				`${OUTWARD}branch creation`,
			);
			expectSilent([
				"git branch --format '%(refname)'",
				"git branch --sort committerdate",
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
			// Revision 1: joined field flags, own-property lookups, case-insensitive
			// subcommands; a write next to each read group and one pin per read.
			expectAsks(
				[
					"gh api -ftitle=x repos/o/r/issues",
					"gh api -Fn=1 repos/o/r/issues",
					"gh constructor",
					"gh secret set X",
					"gh variable set X",
					"gh release delete v1",
					"gh run cancel 1",
					"gh run rerun 1",
					"gh workflow enable ci.yml",
					"gh gist create f",
					"gh label delete bug",
					"gh cache delete 1",
					"gh auth login",
					"gh PR create -t t -b b",
				],
				`${OUTWARD}gh`,
			);
			expectSilent([
				"gh PR view 5",
				"gh issue status",
				"gh repo list",
				"gh run view 1",
				"gh run list",
				"gh run watch 1",
				"gh workflow view ci.yml",
				"gh workflow list",
				"gh release view v1",
				"gh release list",
				"gh gist view abc",
				"gh gist list",
				"gh label list",
				"gh cache list",
				"gh secret list",
				"gh variable list",
				"gh variable get X",
				"gh search issues bug",
				"gh status",
				"gh help",
				"gh version",
				"gh completion -s bash",
				"gh pr",
			]);
			// Revision 2: an option gh does not know before the subcommand may take
			// the next word, so the subcommand is unknown; the last `-X` decides.
			expectAsks(
				[
					"gh pr --title view create --body b",
					"gh issue --title list create -b b",
					"gh --title search pr create --body b",
				],
				BROKEN,
			);
			expectSilent([
				"gh pr -R o/r view 5",
				"gh -R o/r pr view 5",
				"gh api -X GET -f q=x search/issues",
				"gh api -X POST -X GET repos/o/r/pulls",
			]);
			expectAsks(
				["gh api -X GET -X POST repos/o/r/labels", "gh browse"],
				`${OUTWARD}gh`,
			);
			// Revision 3: `-h` is read like `--help`.
			expectAsks(["gh pr -h create"], `${OUTWARD}gh`);
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
			// Revision 1 pins: mid-word `#`, options consuming the next word,
			// substitutions inside double quotes, here-strings and block comments.
			expectAsks(
				[
					"echo a#b; git push",
					"git --git-dir .git push",
					"git --exec-path /x push",
					'echo "`git push`"',
				],
				OUTWARD,
			);
			expectAsks(
				['Write-Host "$(git push)"', "<# x #> git push"],
				OUTWARD,
				psEvent,
			);
			expectSilent(
				["Write-Host @'\ndon't push\n'@", "<# don't #> git status"],
				psEvent,
			);
			expectAsks(["git --attr-source HEAD push"], `${OUTWARD}git push`);
			// Revision 2 pins: commands after a heredoc body, `--super-prefix`,
			// outward outranking broken across segments, appending redirections;
			// chained inline aliases; PowerShell argument expressions.
			expectAsks(
				[
					"cat <<EOF\nx\nEOF\ngit push",
					"cat <<-EOF\n\tx\n\tEOF\ngit push",
					"git --super-prefix x push",
					"$GIT status; git push",
					"git -c alias.a=b -c alias.b=push a",
				],
				`${OUTWARD}git push`,
			);
			expectAsks(
				["Write-Host (git push)", "(git push)"],
				`${OUTWARD}git push`,
				psEvent,
			);
			expectSilent(["git branch >>out"]);
			expectSilent(["git branch *>&1"], psEvent);
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
			// Revision 1 pins: subcommands compare case-insensitively.
			expectAsks(["git PUSH"], `${OUTWARD}git push`);
			expectAsks(["git PUSH"], `${OUTWARD}git push`, psEvent);
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
			// Revision 1: only Bash, PowerShell and GitHub MCP tool names count, by
			// own property (an inherited `constructor` is not a shell).
			expectSilent(
				[
					JSON.stringify({
						tool_name: "constructor",
						tool_input: { command: "git push" },
					}),
					JSON.stringify({
						tool_name: "BashOutput",
						tool_input: { command: "git push" },
					}),
					JSON.stringify({ tool_name: "Edit", tool_input: {} }),
				],
				rawEvent,
			);
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
			// Revision 1: a positional pwsh argument is a script file; `-Command -`
			// reads stdin.
			expectAsks(
				[
					"pwsh script.ps1",
					"echo 'git push' | pwsh -Command -",
					"pwsh -e Zm9v",
					"pwsh -ec Zm9v",
				],
				BROKEN,
			);
			expectAsks(["'git push' | pwsh -Command -"], BROKEN, psEvent);
			expectAsks(
				['bash -c "git push" --version', 'powershell "git push"'],
				`${OUTWARD}git push`,
			);
			expectSilent(["powershell Get-Date"]);
			expectAsks(
				['powershell -Version 5.1 -Command "git push"'],
				`${OUTWARD}git push`,
				psEvent,
			);
			// Revision 2: more wrappers looked into, every spelling of their string
			// option, shell options around `-c`, and the tmux string runners.
			expectAsks(WRAPPERS_REV2.outward, `${OUTWARD}git push`);
			expectAsks(WRAPPERS_REV2.outwardPs, `${OUTWARD}git push`, psEvent);
			expectAsks(WRAPPERS_REV2.broken, BROKEN);
			expectAsks(WRAPPERS_REV2.brokenPs, BROKEN, psEvent);
			expectSilent(WRAPPERS_REV2.silent);
			// Revision 3: `-Name:value`, scriptblock member access, env options.
			expectAsks(WRAPPERS_REV3.outwardPs, `${OUTWARD}git push`, psEvent);
			expectAsks(["watch -d 'git push'"], `${OUTWARD}git push`);
			expectAsks(["env --frobnicate -S 'git push'", "eval"], BROKEN);
			expectSilent(["env --frobnicate git status"]);
		},
		TEST_TIMEOUT,
	);

	it(
		"fails closed on pathological input within the timeout",
		() => {
			// [command, ask prefix, or null for no opinion]
			const pathological = [
				[`echo ${"a".repeat(70_000 - 5)}`, BROKEN],
				["$(".repeat(10_000), BROKEN],
				// Beyond the contract minimum: wrapper re-parsing must be bounded too.
				// `eval … git push` really pushes, so either ask reason is correct.
				[`${"eval ".repeat(12_000)}git push`, "[rpiv-hook] "],
				[`${"eval ".repeat(12_000)}echo hi`, BROKEN],
				// Revision 1: analysis cost stays linear in the command length.
				[`${"A= ".repeat(21_800)}git push`, `${OUTWARD}git push`],
				["A=1 ".repeat(16_000), null],
				[`${"cmd ".repeat(16_000)}& git push`, `${OUTWARD}git push`],
				[`${"git ".repeat(16_000)}push`, `${OUTWARD}git push`],
				["gh api x ".repeat(7_000), null],
				["echo $A push ".repeat(4_500), BROKEN],
				// Revision 2: every option walk and scan stays linear.
				[`${"git -C ".repeat(9_300)}status`, null],
				["$A -C ".repeat(10_000), `${BROKEN} command word`],
				[`${"( a ".repeat(16_000)}git push`, `${OUTWARD}git push`],
				[`${"gh -R ".repeat(10_900)}x`, null],
				[`${"xargs -n ".repeat(7_200)}x`, null],
				["tmux ".repeat(13_000), null],
				["su ".repeat(21_000), null],
				["git config alias.p x ".repeat(3_000), BROKEN],
				// Revision 3: nested unclosed `$((` and repeated alias expansion are
				// bounded.
				[`git push\n${"$((".repeat(22)}`, BROKEN],
				["$((".repeat(40), BROKEN],
				// S26 (D36): the expansion `git branch -d x` is now a branch deletion,
				// whose outward reason outranks the alias one; still bounded and asking.
				[
					"git -c alias.b=branch b -d x -- ".repeat(2_000),
					`${OUTWARD}branch deletion`,
				],
				["git -c alias.p=status p ".repeat(2_700), `${BROKEN} git alias`],
				[`${"sudo -u x ".repeat(6_000)}bash`, null],
			];
			const failures = pathological
				.map(([command, prefix]) => {
					const label = `${command.slice(0, 12)}…${command.slice(-8)} (${command.length} chars)`;
					const event = bashEvent(command);
					const started = Date.now();
					const failure =
						prefix === null
							? silentFailure(label, event)
							: askFailure(label, event, prefix);
					const elapsed = Date.now() - started;
					return (
						failure ?? (elapsed > 2_000 ? `${label}: took ${elapsed} ms` : null)
					);
				})
				.filter(Boolean);
			expect.soft(failures).toEqual([]);

			// Internal-error path (pin): a stack too small for the analysis must
			// still end in a fail-closed ask. If a refactor changes frame depth,
			// retune the stack size and nesting, but keep asserting the reason.
			const nested = `${"$(".repeat(20)}${")".repeat(20)}`;
			expect(
				askFailure(
					"stack overflow",
					bashEvent(nested),
					`${BROKEN} internal error`,
					["--stack-size=60"],
				),
			).toBeNull();
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

	it(
		"fails closed when words that decide a git or gh action are computed or not plain",
		() => {
			expectAsks(
				[
					"git $SUB origin main",
					"git $(echo push)",
					"git ${X:-push}",
					'git "$@"',
					"git $OPT push",
					"git {push,} origin main",
					"git -c alias.p=$X p",
					"git checkout $BRANCH",
					"sudo $GIT push",
					"env $GIT push",
					"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p",
					"git --config-env=alias.p=V p",
					"alias g=git",
					"alias g='git push'",
					"gh $SUB create",
					"gh pr $ACTION 5",
					"gh api $ENDPOINT $ARGS",
					// round 2
					"git -c $KV p",
					"git switch $F x",
					"git branch $N",
					"git stash $S x",
					"git worktree $A ../wt",
					"git lfs $P origin main",
					"git subtree $P --prefix d origin main",
					"gh api repos/o/r/issues $ARGS",
					'gh api "$EP"',
					"alias p='sudo git push'",
					"alias g=/usr/bin/git",
					"alias g=gh",
					"export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push; git p",
					"git -c include.path=x.cfg p",
					"{git,} push",
					"/usr/bin/gi? push",
					// round 3
					"git --frobnicate push",
					"echo push | xargs git",
					"echo create | xargs gh pr",
					"echo 'pr create -t t -b b' | xargs gh",
					"echo push | xargs -Ix git x",
					"echo 'git push' | xargs -I{} sh -c '{}'",
					"find . -exec git {} \\;",
					"parallel git ::: push",
					"GIT_CONFIG_GLOBAL=x.cfg git p",
					"GIT_CONFIG_SYSTEM=x.cfg git p",
					`GIT_CONFIG_PARAMETERS="'alias.p=push'" git p`,
					"git -c includeIf.onbranch:main.path=x.cfg p",
					"sudo $GH pr create -t t -b b",
					"env $GH api -X POST repos/o/r/labels",
					"echo 'git push' | xargs -I{} bash -c {}",
				],
				BROKEN,
			);
			expectAsks(
				[
					"git $sub",
					'Start-Process git -ArgumentList "push origin main"',
					"Start-Process git -ArgumentList push,origin",
					"Start-Process git -ArgumentList 'push','origin'",
					"Start-Process git -ArgumentList @('push')",
					'& ("git") push',
					"& (Get-Command git) push",
					"Set-Alias g git",
					// round 2
					"New-Alias g git",
					"sal g git",
					"nal g git",
					"Set-Alias -Name g -Value git",
					"$env:GIT_CONFIG_COUNT=1; $env:GIT_CONFIG_KEY_0='alias.p'; $env:GIT_CONFIG_VALUE_0='push'; git p",
					'& "`u{67}it" push',
				],
				BROKEN,
				psEvent,
			);
			expectAsks(
				[
					"git push origin $BRANCH",
					"find . -name x -exec git push \\;",
					"git -c alias.p='!git push' p",
				],
				`${OUTWARD}git push`,
			);
			expectSilent([
				'git commit -m "$MSG"',
				'git log --format="$FMT"',
				"git status $DIR",
				"git diff $BASE..HEAD",
				"gh pr view $N",
				"echo $HOME",
				"cd $DIR && git status",
				"alias ll='ls -l'",
				// round 2
				'git -C "$DIR" status',
				"GIT_CONFIG_NOSYSTEM=1 git status",
				'git stash push -m "$MSG"',
				'git worktree remove "$WT"',
				'git checkout -- "$FILE"',
				'gh api "repos/$O/$R/pulls"',
				"cp $SRC dest",
				'git log --format="$FMT" -n 5',
				"[[ -f x ]] && git status",
				// round 3
				"echo $X status",
				"GIT_DIR=$D git status",
				'GIT_SSH_COMMAND="$C" git fetch',
				"echo f | xargs rg x",
				"find . -name '*.js' -exec rg x {} \\;",
				"cp $SRC release",
			]);
			// Revision 2: unknown options before a deciding word, PowerShell
			// argument expressions, run-time config writes, runner command words,
			// alias cycles and depth.
			expectAsks(DECIDING_REV2.broken, BROKEN);
			expectAsks(DECIDING_REV2.aliasProblems, `${BROKEN} git alias`);
			expectAsks(DECIDING_REV2.brokenPs, BROKEN, psEvent);
			expectSilent(DECIDING_REV2.silent);
			// Revision 3: config across wrapper strings, computed aliases,
			// Start-Process placement, runner `git-<name>`, command-less parallel.
			expectAsks(DECIDING_REV3.broken, BROKEN);
			expectAsks(DECIDING_REV3.brokenPs, BROKEN, psEvent);
			expectAsks(DECIDING_REV3.outwardPs, `${OUTWARD}git push`, psEvent);
			// Revision 4: a computed word at the launcher-aware run position.
			expectAsks(REV4.computedRun, BROKEN);
			expectAsks(["Start-Process $GIT push"], BROKEN, psEvent);
		},
		TEST_TIMEOUT,
	);

	it(
		"decodes ANSI-C quoting, redirections and expanding bodies before matching",
		() => {
			expectAsks(
				[
					"git $'push'",
					"$'git' push",
					'$"git" push',
					"git push>/dev/null",
					"git push 2>&1",
					"git push</dev/null",
					"git>log push",
					"git push &>/dev/null",
					"echo ${X:-$(git push)}",
					'echo "${X:-$(git push)}"',
					"cat <<EOF\n$(git push)\nEOF",
					// round 2
					"$'\\x67it' push",
					"git $'\\160ush'",
					'echo $"$(git push)"',
					"git push > /dev/null",
					// round 3
					"$'\\u0067it' push",
					"$'\\U00000067it' push",
					"echo hi > $(git push)",
					"echo hi > >(git push)",
				],
				`${OUTWARD}git push`,
			);
			expectAsks(
				['Write-Output @"\n$(git push)\n"@'],
				`${OUTWARD}git push`,
				psEvent,
			);
			expectSilent([
				"git commit -m $'don\\'t push'",
				"git branch >out",
				"git status 2>&1",
				"cat <<'EOF'\n$(git push)\nEOF",
				"echo {a,b}",
				"git log --format='%(refname)'",
				// round 2
				"git branch > out",
				"git branch 2>/dev/null",
				"cat <<EOF\ndoesn't push\nEOF",
				"git checkout @{-1}",
				"gh api repos/{owner}/{repo}/pulls",
			]);
			expectSilent(
				[
					"Write-Output @'\n$(git push)\n'@",
					"git branch 2>$null",
					'Write-Output @"\ndon\'t push\n"@',
				],
				psEvent,
			);
			// Revision 2: arithmetic expansion is a computed word whose inner
			// substitutions are still inspected; an unclosed `$((` is a substitution.
			expectSilent(["echo $(( $(date +%s) - start ))", "echo $(( 1 + 2 ))"]);
			expectAsks(
				[
					"echo $(( $(git push) ))",
					"echo $((git push) )",
					"echo $(( `git push` ))",
				],
				`${OUTWARD}git push`,
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for stdin-fed shells only and lets shell reads through",
		() => {
			expectAsks(
				[
					'bash <<< "git push"',
					"sudo bash <<EOF\ngit push\nEOF",
					"bash < script.sh",
					"echo 'git push' | sudo bash",
					'timeout 60 bash <<< "git push"',
					"echo 'git push' | (bash)",
					"echo 'git push' | { bash; }",
					"echo 'git push' | sudo -u root bash",
					"echo 'git push' | env bash",
					"bash <(echo 'git push')",
					"echo 'git push' | bash -",
					"echo 'git push' | sh -s",
					// round 3
					"echo 'git push' | bash /dev/stdin",
					"echo 'git push' | bash /dev/fd/0",
					"echo 'git push' | doas bash",
					"echo 'git push' | command bash",
					"echo 'git push' | exec bash",
					"echo 'git push' | nohup bash",
					"echo 'git push' | time bash",
					"echo 'git push' | nice -n 5 bash",
					"echo 'git push' | stdbuf -o L bash",
					"echo 'git push' | setsid bash",
					"echo 'git push' | bash -help",
					"echo f | xargs bash",
				],
				BROKEN,
			);
			expectAsks(['bash -help -c "git push"'], `${OUTWARD}git push`);
			expectSilent([
				"bash --version",
				"sh --help",
				"pwsh --version",
				"pwsh -version",
				"pwsh -help",
				"pwsh -?",
				"cmd",
				"bash",
				"ls | grep bash",
				"ps aux | grep sh",
				"which bash",
				"bash script.sh",
			]);
			// Revision 2: more stdin feeds, precise launchers, stdin into wrapper
			// strings, and a computed positional powershell only when it is run.
			const piped = (cmd) => `echo 'git push' | ${cmd}`;
			expectAsks(
				[
					"echo 'git push' |& bash",
					piped("sudo --user root bash"),
					piped("sudo -Hu root bash"),
					"echo 'git push' > >(bash)",
					"echo x | tee >(bash)",
					"source <(echo 'git push')",
					". <(echo 'git push')",
					piped("source /dev/stdin"),
					piped("sudo --frobnicate bash"),
					piped("doas -u root bash"),
					piped("exec -a x bash"),
					piped("env -u X bash"),
					piped("env A=1 bash"),
					piped("time -o f bash"),
					piped("timeout -s KILL 60 bash"),
					"{ bash; } < script.sh",
					"( bash ) < script.sh",
					...["zsh", "dash", "ksh", "cmd", "powershell", "pwsh"].map(piped),
					piped("sudo --frobnicate x bash"),
					piped("bash -c bash"),
					piped("su -c bash"),
					piped("env -S bash"),
				],
				BROKEN,
			);
			expectAsks(
				[
					"Start-Process powershell $cmd",
					"Start-Process -FilePath powershell -ArgumentList $cmd",
					"saps powershell $cmd",
					"start powershell $cmd",
				],
				BROKEN,
				psEvent,
			);
			expectAsks(
				['start powershell "git push"', 'cmd /c start powershell "git push"'],
				`${OUTWARD}git push`,
			);
			expectSilent([
				"powershell -help",
				"powershell -?",
				"pwsh --help",
				"t PowerShell $x",
				"source ~/.bashrc",
			]);
			// Revision 3: wrappers that start a shell reading stdin.
			expectAsks(
				[
					"su",
					"su root",
					"runuser -l root",
					"sg grp",
					"script -q /dev/null",
					"sudo -s",
					"sudo -i",
					"doas -s",
					"flock /tmp/l bash",
				].map(piped),
				BROKEN,
			);
			expectSilent(["su root", "sudo -i"]);
			// Revision 4: flock / runuser -- run their command words.
			expectSilent(REV4.fedCommandsSilent);
			expectAsks(REV4.fedShells.map(piped), BROKEN);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks when a git or gh word sits where the hook cannot classify it",
		() => {
			expectAsks(
				[
					"echo push | xargs sudo git",
					"echo push | xargs env git",
					"echo push | xargs timeout 60 git",
					"echo push | parallel sudo git",
					"echo create | xargs sudo gh pr",
					"mytool git",
					"npm exec gh",
				],
				BROKEN,
			);
			expectAsks(["Invoke-Thing git"], BROKEN, psEvent);
			expectSilent([
				"which git",
				"type git",
				"command -v git",
				"rg git src",
				"echo git",
				"man git",
				"git help git",
				"ls git",
				"cd git",
				"sudo git",
			]);
			expectSilent(["Get-Command git", "Write-Host gh"], psEvent);
			// Revision 4: exact run position, wrapper-analysed words, PowerShell
			// assignments, `git-<name>` as a plain program name.
			expectSilent(REV4.placedSilent);
			expectSilent(REV4.placedSilentPs, psEvent);
			expectAsks(REV4.unplaced, BROKEN);
			expectAsks(["iex 'Invoke-Thing git'"], BROKEN, psEvent);
			expectAsks(
				["rg git push", "flock /tmp/l git push"],
				`${OUTWARD}git push`,
			);
			expectAsks(["$b = git push"], `${OUTWARD}git push`, psEvent);
		},
		TEST_TIMEOUT,
	);

	it(
		"asks for git commit off an approved branch",
		() => {
			expectAsksInEach(
				[FX.main, FX.x, FX.y, FX.det, FX.unborn],
				"git commit -m x",
				COMMIT_GATE,
			);
			expectAsks(
				[
					"git commit --amend --no-edit",
					"git -c user.name=x commit -m x",
					"git -c alias.ci=commit ci -m x",
				],
				COMMIT_GATE,
				in_(FX.main),
			);
			expectAsks(["git commit -m x"], COMMIT_GATE, psIn(FX.main));
			expectSilent(
				["git commit -m x", 'git commit -m "do not git push"'],
				in_(FX.ok),
			);
			expectSilent(["git status"], in_(FX.main));
			expectAsksInEach(
				[FX.ok, FX.main],
				"git commit -m x && git push",
				`${OUTWARD}git push`,
			);
			// S2 revision 1: HEAD movers, git-commit, same-named tag, git booleans,
			// only `git commit` gated.
			expectAsks(S2_REV1.gateAtOk, COMMIT_GATE, in_(FX.ok));
			expectAsks(S2_REV1.gateAtMain, COMMIT_GATE, in_(FX.main));
			expectSilent(["git-commit -m x"], in_(FX.ok));
			expectSilent(["git commit -m x"], in_(FX.tagged));
			expectSilent(["git commit -m x"], in_(FX.yes));
			expectSilent(S2_REV1.silentAtMain, in_(FX.main));
			// S2 revision 2 pin: bisect moves HEAD.
			expectAsks(
				["git bisect reset && git commit -m x"],
				COMMIT_GATE,
				in_(FX.ok),
			);
		},
		TEST_TIMEOUT,
	);

	it(
		"reads the branch where the commit runs",
		() => {
			const ok = quoted(FX.ok);
			const main = quoted(FX.main);
			expectSilent(
				[
					`cd ${ok} && git commit -m x`,
					`git -C ${ok} commit -m x`,
					`pushd ${ok} && git commit -m x`,
				],
				in_(FX.plain),
			);
			expectSilent([`Set-Location ${ok}; git commit -m x`], psIn(FX.plain));
			expectSilent(["cd sub && git commit -m x"], in_(FX.ok));
			expectAsks(
				[
					`git -C ${main} commit -m x`,
					`cd ${main} && git commit -m x`,
					"git switch main && git commit -m x",
					"git checkout feat/ok && git commit -m x",
				],
				COMMIT_GATE,
				in_(FX.ok),
			);
			expectAsks(
				[
					"cd $D && git commit -m x",
					'git -C "$D" commit -m x',
					"GIT_DIR=x git commit -m x",
					"git --git-dir=x commit -m x",
				],
				BROKEN,
				in_(FX.ok),
			);
			// S2 revision 1: only a plain top-level directory change is followed.
			expectAsks(S2_REV1.brokenAtMain, BROKEN, in_(FX.main));
			expectAsks(S2_REV1.brokenAtOk, BROKEN, in_(FX.ok));
			expectAsks(S2_REV1.brokenPsAtOk, BROKEN, psIn(FX.ok));
			expectAsks(S2_REV1.gateFollowed, COMMIT_GATE, in_(FX.ok));
			expectAsks([`sl ${main}; git commit -m x`], COMMIT_GATE, psIn(FX.ok));
			expectSilent(S2_REV1.silentFollowed, in_(FX.main));
			expectSilent(S2_REV1.silentPsAtPlain, psIn(FX.plain));
			// S2 revision 2: refused cd, whole-word directory names, pins.
			expectAsks(S2_REV2.refusedCd, BROKEN, in_(FX.main));
			expectAsks(S2_REV2.refusedCd, BROKEN, psIn(FX.main));
			expectSilent(S2_REV2.wholeWordSilent, in_(FX.ok));
			expectAsks(S2_REV2.brokenAtMain, BROKEN, in_(FX.main));
			expectAsks(S2_REV2.brokenPsAtMain, BROKEN, psIn(FX.main));
			expectAsks(S2_REV2.brokenAtOk, BROKEN, in_(FX.ok));
			expectAsks(S2_REV2.brokenPsAtOk, BROKEN, psIn(FX.ok));
			expectSilent(S2_REV2.silentAtOk, in_(FX.ok));
			expectSilent(S2_REV2.silentAtMain, in_(FX.main));
		},
		TEST_TIMEOUT,
	);

	it(
		"asks before any command touches the approval marker",
		() => {
			expectAsks(
				[
					"git config branch.feat/x.rpivApproved true",
					"git config --unset branch.main.rpivApproved",
					"git config --bool branch.main.RPIVAPPROVED yes",
					`echo '[branch "main"] rpivApproved = true' >> .git/config`,
					"git -c branch.main.rpivApproved=true commit -m x",
				],
				MARKER,
				in_(FX.ok),
			);
			expectAsks(
				["git config branch.main.rpivApproved true"],
				MARKER,
				psIn(FX.ok),
			);
			expectSilent(["git config --get user.name"], in_(FX.ok));
			// S2 revision 1: decoded spellings, computed `git config` arguments,
			// precedence (marker before gate, outward before marker).
			expectAsks(S2_REV1.markerSpellings, MARKER, in_(FX.ok));
			expectAsks(S2_REV1.markerComputed, BROKEN, in_(FX.ok));
			expectAsks(
				["git -c branch.main.rpivApproved=true commit -m x"],
				MARKER,
				in_(FX.main),
			);
			expectAsks(
				["git push; git config branch.x.rpivApproved true"],
				`${OUTWARD}git push`,
				in_(FX.ok),
			);
			// S2 revision 2: git config through an inline alias or git-config.
			expectAsks(S2_REV2.markerThroughAlias, BROKEN, in_(FX.ok));
		},
		TEST_TIMEOUT,
	);

	it(
		"fails closed when the commit branch cannot be read",
		() => {
			const repos = [FX.plain, FX.missing];
			expectAsksInEach(repos, "git commit -m x", BROKEN);
			const slow = repos.filter((cwd) => {
				const started = Date.now();
				runHook(bashEvent("git commit -m x", { cwd }));
				return Date.now() - started >= 2_000;
			});
			expect.soft(slow).toEqual([]);
			// S2 revision 1: distinct diagnostics; bounded git work (D13).
			const emptyPath = { env: { ...process.env, PATH: "", Path: "" } };
			const failures = [
				brokenWithFailure(
					"no cwd",
					JSON.stringify({
						tool_name: "Bash",
						tool_input: { command: "git commit -m x" },
					}),
					"no cwd",
					{ cwd: FX.ok },
				),
				brokenWithFailure(
					"PATH empty",
					bashEvent("git commit -m x"),
					"git could not run",
					emptyPath,
				),
			].filter(Boolean);
			expect.soft(failures).toEqual([]);
			expectAsks([S2_REV1.manyCommits], COMMIT_GATE, in_(FX.main));
			expectSilent([S2_REV1.manyCommits], in_(FX.ok));
			const timings = [FX.main, FX.ok].map((cwd) =>
				decisionMs(bashEvent(S2_REV1.manyCommits, { cwd })),
			);
			expect.soft(timings.filter((ms) => ms >= 2_000)).toEqual([]);
			expectAsks([S2_REV1.nineDirs], BROKEN, in_(FX.ok));
			// S2 revision 2: entry point without a script path; pins for the
			// 64-git-word bound and the spent git budget.
			const imported = importedHookAsk(bashEvent("git push"));
			expect.soft(imported).toContain(`${OUTWARD}git push`);
			expect
				.soft(
					brokenWithFailure(
						"65 git words",
						bashEvent(S2_REV2.crowded),
						"more than 64 git invocations",
					),
				)
				.toBeNull();
			expect.soft(headStateWithoutBudget(FX.ok)).toContain("git could not run");
		},
		TEST_TIMEOUT,
	);
});
