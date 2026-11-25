// enforce-readonly-agent.test.mjs — golden-fixture test for enforce-readonly-agent.mjs.
// Builds a throwaway plugin root with agent .md files in various permission states and
// asserts the hook's deny/allow decisions and its warnings (additionalContext) in stdout JSON.
//
//   node .claude/hooks/enforce-readonly-agent.test.mjs
//
// Prints "OK ..." and exits 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "enforce-readonly-agent.mjs");

const runHook = (repo, stdin) => {
  const { stdout, stderr } = spawnSync("node", [HOOK], {
    cwd: repo, input: JSON.stringify(stdin), encoding: "utf-8", stdio: "pipe",
    env: { ...process.env, RPIV_AGENTS_DIR: join(repo, "agents") },
  });
  // The hook exits 0 and Claude never reads its stderr, so nothing may go there.
  assert.equal(stderr.trim(), "", `hook wrote to stderr: ${stderr}`);
  // stdout holds at most one JSON object: a deny decision, or a warning told to the
  // agent as additionalContext with no permission decision.
  const out = stdout.trim() ? JSON.parse(stdout.trim()) : null;
  const decision = out?.hookSpecificOutput?.permissionDecision ? out : null;
  const said = out?.hookSpecificOutput?.additionalContext ?? "";
  return { decision, said };
};

const mkAgent = (repo, name, tools) => {
  mkdirSync(join(repo, "agents"), { recursive: true });
  writeFileSync(join(repo, "agents", `${name}.md`), `---\ntools: ${tools}\n---\n`);
};

// --- Test 1: main session (no agent_type) — allow everything -----------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-main-"));
  try {
    const { decision, said } = runHook(repo, { tool_name: "Write" });
    assert.equal(decision, null, "main session: no deny decision");
    assert.equal(said.trim(), "", "main session: no stderr");
    console.log("OK — main session: allows everything.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 2: Write allowed — agent has Write in tools ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-write-ok-"));
  try {
    mkAgent(repo, "test-agent", "Read, Write");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.equal(decision, null, "write-allowed: no deny");
    console.log("OK — Write allowed: agent has Write tool.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 3: Write blocked — agent is read-only -----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-write-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.ok(decision, "write-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /"Write" blocked: agent "test-agent" is read-only/);
    console.log("OK — Write blocked: agent is read-only.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 4: Edit blocked — agent is read-only ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-edit-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read, Glob");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Edit" });
    assert.ok(decision, "edit-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /"Edit" blocked: agent "test-agent" is read-only/);
    console.log("OK — Edit blocked: agent is read-only.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 5: Bash blocked — agent doesn't allow Bash ------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-deny-"));
  try {
    mkAgent(repo, "test-agent", "Read");
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Bash", tool_input: { command: "ls" } });
    assert.ok(decision, "bash-blocked: must return a decision");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Bash blocked: agent "test-agent" does not allow Bash/);
    console.log("OK — Bash blocked: agent has no Bash tool.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 6: Bash allowed, destructive command — warns, no deny --------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-warn-"));
  try {
    mkAgent(repo, "test-agent", "Read, Bash");
    const { decision, said } = runHook(repo, {
      agent_type: "test-agent", tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/scratch" },
    });
    assert.equal(decision, null, "destructive command: no deny — agent has Bash");
    assert.match(said, /WARNING: agent "test-agent" running potentially destructive Bash/);
    console.log("OK — Bash allowed, destructive: warns, no deny.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 7: Bash allowed, safe command — silent ----------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-bash-ok-"));
  try {
    mkAgent(repo, "test-agent", "Read, Bash");
    const { decision, said } = runHook(repo, {
      agent_type: "test-agent", tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    assert.equal(decision, null, "safe bash: no deny");
    assert.equal(said.trim(), "", `safe bash: no warning, got: ${said}`);
    console.log("OK — Bash allowed, safe command: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 8: non-rpiv agent — allow everything ------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-ext-"));
  try {
    const { decision, said } = runHook(repo, { agent_type: "external-agent", tool_name: "Write" });
    assert.equal(decision, null, "external agent: no deny");
    assert.equal(said.trim(), "", "external agent: silent");
    console.log("OK — non-rpiv agent: allows everything.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 9: empty stdin — silent exit --------------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-empty-"));
  try {
    const { stdout, stderr } = spawnSync("node", [HOOK], {
      cwd: repo, input: "", encoding: "utf-8", stdio: "pipe",
    });
    assert.equal(stdout.trim(), "", "empty stdin: no stdout");
    assert.equal(stderr.trim(), "", "empty stdin: no stderr");
    console.log("OK — empty stdin: silent exit.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 10: tools field empty — treated as no tools -----------------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-notools-"));
  try {
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeFileSync(join(repo, "agents", "test-agent.md"), `---\n---\n`); // no tools field
    const { decision } = runHook(repo, { agent_type: "test-agent", tool_name: "Write" });
    assert.ok(decision, "no tools: must deny Write");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    console.log("OK — no tools field: Write denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 12: allowlisted agent, allowed command — silent --------------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-al-ok-"));
  try {
    mkAgent(repo, "claim-verifier", "Read, Grep, Glob, Bash");
    const { decision, said } = runHook(repo, {
      agent_type: "claim-verifier", tool_name: "Bash",
      tool_input: { command: "git show 3a2b1c8 -- src/services/OrderService.ts" },
    });
    assert.equal(decision, null, "allowed git show: no deny");
    assert.equal(said.trim(), "", `allowed git show: silent, got: ${said}`);
    console.log("OK — allowlisted agent, allowed command: silent.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 13: allowlisted agent, out-of-contract command — denied -------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-al-deny-"));
  try {
    mkAgent(repo, "claim-verifier", "Read, Grep, Glob, Bash");
    const { decision } = runHook(repo, {
      agent_type: "claim-verifier", tool_name: "Bash",
      tool_input: { command: "git log --oneline --all" },
    });
    assert.ok(decision, "out-of-contract command: must deny");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    assert.match(decision.hookSpecificOutput.permissionDecisionReason, /contract allows/);
    console.log("OK — allowlisted agent, out-of-contract command: denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 14: allowlisted agent, chained smuggle — denied ---------------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-al-chain-"));
  try {
    mkAgent(repo, "claim-verifier", "Read, Grep, Glob, Bash");
    const { decision } = runHook(repo, {
      agent_type: "claim-verifier", tool_name: "Bash",
      tool_input: { command: "git show abc123 && rm -rf /tmp/x" },
    });
    assert.ok(decision, "chained smuggle: must deny");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    console.log("OK — allowlisted agent, chained smuggle: denied (per-segment check).");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 15: precedent-locator — read-only git allowed, fetch denied ---------
{
  const repo = mkdtempSync(join(tmpdir(), "era-pl-"));
  try {
    mkAgent(repo, "precedent-locator", "Read, Grep, Glob, Bash");
    const ok = runHook(repo, {
      agent_type: "precedent-locator", tool_name: "Bash",
      tool_input: { command: 'git log --oneline --all --grep="rate limit"' },
    });
    assert.equal(ok.decision, null, "git log: no deny");
    const denied = runHook(repo, {
      agent_type: "precedent-locator", tool_name: "Bash",
      tool_input: { command: "git fetch origin" },
    });
    assert.ok(denied.decision, "git fetch: must deny");
    assert.equal(denied.decision.hookSpecificOutput.permissionDecision, "deny");
    console.log("OK — precedent-locator: read-only git allowed, fetch denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 16: non-allowlisted agent, newly-covered destructive git — warns only
{
  const repo = mkdtempSync(join(tmpdir(), "era-gitgap-"));
  try {
    mkAgent(repo, "test-agent", "Read, Bash");
    const { decision, said } = runHook(repo, {
      agent_type: "test-agent", tool_name: "Bash",
      tool_input: { command: "git reset --hard HEAD~1" },
    });
    assert.equal(decision, null, "non-allowlisted destructive git: no deny");
    assert.match(said, /WARNING: agent "test-agent" running potentially destructive Bash/);
    console.log("OK — git reset now covered by destructive scan: warns.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 11: traversal agent_type — no fs probe, defers (no deny) -----------
{
  const repo = mkdtempSync(join(tmpdir(), "era-traversal-"));
  try {
    mkAgent(repo, "test-agent", "Read"); // read-only agent exists in agents/
    // A permissive sibling one level up that a traversal from agents/ would hit.
    writeFileSync(join(repo, "sibling.md"), `---\ntools: Read, Write, Bash\n---\n`);
    const { decision, said } = runHook(repo, { agent_type: "../sibling", tool_name: "Write" });
    // Unsafe agent_type is not a recognized rpiv agent → defer to normal permission
    // flow (no deny), and crucially the sibling's permissive tools are never read.
    assert.equal(decision, null, "traversal agent_type: no deny decision");
    assert.equal(said.trim(), "", "traversal agent_type: silent");
    console.log("OK — traversal agent_type: no fs probe, defers to normal flow.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 17: review agents read git history and diffs, never write -------------
{
  const repo = mkdtempSync(join(tmpdir(), "era-reviewer-"));
  try {
    for (const name of ["artifact-code-reviewer", "artifact-coverage-reviewer", "slice-verifier"]) {
      mkAgent(repo, name, "Read, Grep, Glob, Bash");
      for (const command of [
        "git diff d490024..65a10bb -- apps/harness/src",
        "git show d490024:apps/harness/src/storage/permit-lock.ts",
        "git log --oneline -5 -- src/lock.ts",
        "git merge-base main HEAD",
        "git ls-files src",
        "git blame -L 10,20 src/lock.ts",
        "git rev-parse HEAD",
        "rg -n withPermits apps",
      ]) {
        const { decision } = runHook(repo, { agent_type: name, tool_name: "Bash", tool_input: { command } });
        assert.equal(decision, null, `${name}: read allowed: ${command}`);
      }
      for (const command of [
        "git diff > out.patch",
        "git diff --output=out.patch",
        "git show --ext-diff HEAD",
        "git log -p --textconv",
        "git -c core.pager=sh show HEAD",
        "git checkout main",
        "git diff && git commit -m x",
        "node scripts/anything.mjs",
        "rg --pre sh pattern .",
        "rg --pre=sh pattern .",
        "rg --search-zip pattern .",
        "rg -z pattern .",
        "git diff & touch pwned",
        "git diff &touch pwned",
        "git diff --no-index f <(touch pwned)",
        "git show HEAD\nrm -rf x",
        "git show $(rm -rf x)",
        "git show `rm -rf x`",
      ]) {
        const { decision } = runHook(repo, { agent_type: name, tool_name: "Bash", tool_input: { command } });
        assert.ok(decision, `${name}: must deny: ${command}`);
        assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      }
    }
    console.log("OK — review agents: read-only git and rg allowed; writes, redirections and other commands denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 18: an allowed prefix never smuggles a write through a redirection ----
{
  const repo = mkdtempSync(join(tmpdir(), "era-redirect-"));
  try {
    mkAgent(repo, "precedent-locator", "Read, Grep, Glob, Bash");
    mkAgent(repo, "claim-verifier", "Read, Grep, Glob, Bash");
    for (const [agent, command] of [
      ["precedent-locator", "git diff HEAD~1 > notes.txt"],
      ["precedent-locator", "git log --output=log.txt"],
      ["claim-verifier", "git show abc123 --ext-diff"],
    ]) {
      const { decision } = runHook(repo, { agent_type: agent, tool_name: "Bash", tool_input: { command } });
      assert.ok(decision, `${agent}: must deny: ${command}`);
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    }
    console.log("OK — allowlisted agents: redirection, --output and --ext-diff denied.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 19: round-2 bypasses — the shell's reading, not the raw text, decides ----
{
  const repo = mkdtempSync(join(tmpdir(), "era-r2-"));
  try {
    for (const name of ["artifact-code-reviewer", "slice-verifier", "precedent-locator", "claim-verifier"])
      mkAgent(repo, name, "Read, Grep, Glob, Bash");
    const verdict = (agent, command) => runHook(repo, { agent_type: agent, tool_name: "Bash", tool_input: { command } }).decision;
    for (const command of [
      "git diff HEAD -- ->victim.txt",
      "git log HEAD x=>out.txt",
      "rg PWNED a.sh -->w.txt",
      "rg --'pre'=sh x .",
      "rg -'z' x .",
      'rg --"search-zip" x',
      "git diff --'output'=out HEAD",
      "rg --pr\\e=sh x .",
      "rg --p${x}re=sh x .",
      "rg -iz x .",
      'git log --format="$(id)"',
    ]) {
      const decision = verdict("slice-verifier", command);
      assert.ok(decision, `must deny: ${command}`);
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    }
    for (const command of [
      'node -e "require(\'child_process\').execSync(\'calc\')" structural.mjs',
      "node evil.mjs structural.mjs",
      "node --import=./evil.mjs structural.mjs",
    ]) {
      const decision = verdict("claim-verifier", command);
      assert.ok(decision, `claim-verifier must deny: ${command}`);
    }
    for (const [agent, command] of [
      ["slice-verifier", 'rg -n "=>" src'],
      ["slice-verifier", "rg -n 'a|b' src"],
      ["slice-verifier", "git log --format='%h %s' -3"],
      ["claim-verifier", "node /plugin/skills/_shared/structural.mjs --tool ast-grep --pattern '$A => $B'"],
    ]) {
      assert.equal(verdict(agent, command), null, `${agent}: still allowed: ${command}`);
    }
    console.log("OK — round-2 bypasses denied; quoted searches and the structural helper still allowed.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 20: every file-writing tool is governed, not only Edit and Write -------

{
  const repo = mkdtempSync(join(tmpdir(), "era-multi-"));
  try {
    mkAgent(repo, "ro-agent", "Read, Grep, Glob, Bash");
    mkAgent(repo, "rw-agent", "Read, MultiEdit, NotebookEdit");
    for (const tool of ["MultiEdit", "NotebookEdit"]) {
      const denied = runHook(repo, { agent_type: "ro-agent", tool_name: tool, tool_input: { file_path: "src/a.ts" } }).decision;
      assert.ok(denied, `${tool}: must deny a read-only agent`);
      assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
      assert.match(denied.hookSpecificOutput.permissionDecisionReason, new RegExp(`"${tool}" blocked: agent "ro-agent" is read-only`));
      assert.equal(runHook(repo, { agent_type: "rw-agent", tool_name: tool }).decision, null, `${tool}: listed, no deny`);
    }
    console.log("OK — MultiEdit and NotebookEdit: denied for a read-only agent, allowed when listed.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- Test 21: PowerShell is a shell like Bash -----------------------------------

{
  const repo = mkdtempSync(join(tmpdir(), "era-pwsh-"));
  try {
    mkAgent(repo, "bash-only", "Read, Bash");
    mkAgent(repo, "pwsh-agent", "Read, PowerShell");
    mkAgent(repo, "claim-verifier", "Read, Grep, Glob, PowerShell");
    const verdict = (agent, command) => runHook(repo, { agent_type: agent, tool_name: "PowerShell", tool_input: { command } });

    const unlisted = verdict("bash-only", "Get-ChildItem").decision;
    assert.ok(unlisted, "PowerShell not listed: must deny");
    assert.equal(unlisted.hookSpecificOutput.permissionDecision, "deny");
    assert.match(unlisted.hookSpecificOutput.permissionDecisionReason, /PowerShell blocked: agent "bash-only" does not allow PowerShell/);

    const outOfContract = verdict("claim-verifier", "Remove-Item -Recurse x").decision;
    assert.ok(outOfContract, "allowlisted agent: out-of-contract denied");
    assert.match(outOfContract.hookSpecificOutput.permissionDecisionReason, /PowerShell command blocked: agent "claim-verifier"'s contract allows/);
    assert.equal(verdict("claim-verifier", "git show abc123 > out.txt").decision?.hookSpecificOutput.permissionDecision, "deny", "allowlisted agent: redirection denied");
    assert.equal(verdict("claim-verifier", "git show abc123 -- src/a.ts").decision, null, "allowlisted agent: in-contract command allowed");

    const destructive = verdict("pwsh-agent", "git push origin main");
    assert.equal(destructive.decision, null, "listed, no allowlist: no deny");
    assert.match(destructive.said, /WARNING: agent "pwsh-agent" running potentially destructive PowerShell/);
    console.log("OK — PowerShell: denied unless listed; when listed the allowlist and destructive scan apply.");
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
