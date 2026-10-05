# RPIV for OpenCode

The OpenCode adapter keeps the existing Claude Code plugin as the canonical source. It registers the same 20 read-only subagents, exposes all 21 workflows as `/rpiv:*` commands, and generates portable `rpiv-*` Agent Skills without maintaining a second prompt tree by hand.

## Install

1. Generate the OpenCode skill tree:

   ```sh
   pnpm generate:opencode
   ```

2. Add the local plugin to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": [
       "file:///C:/path/to/rpiv/opencode/plugin.ts"
     ]
   }
   ```

3. Restart OpenCode. Configuration, agents, commands, plugins, and skills are loaded only at startup.

4. Verify registration:

   ```sh
   opencode agent list
   opencode debug skill
   opencode debug config
   ```

The plugin adds `opencode/generated/skills` to OpenCode's skill paths. Do not edit generated files. Change the canonical files under `skills/` and rerun `pnpm generate:opencode`; `tests/opencode-adapter.test.mjs` fails when generated skills, references, templates, helpers, or `_shared` resources drift. Markdown support files receive the same Claude-to-OpenCode tool and path translation as each `SKILL.md`.

## Model Mapping

| Claude source model | OpenCode model | Agents |
| --- | --- | --- |
| `fable` | `openai/gpt-6-astra` | 2 whole-system analysis agents (`entity-mapper`, `interaction-sweeper`) |
| `opus` | `openai/gpt-5.6-terra` | 13 codebase, integration, review and verification agents |
| `sonnet` | `openai/gpt-5.6-luna` | 4 mechanical locator/auditor agents |
| `sonnet` | `openai/gpt-5.6-terra` | `web-search-researcher` |

The web researcher prefers `exa-search_web_search_exa` and `exa-search_web_fetch_exa`. Built-in web tools are fallback-only.

## Hook Mapping

| Claude hook | OpenCode behavior |
| --- | --- |
| `PreToolUse` read-only enforcement | Per-agent `permission` rules; shell access remains narrowly allowlisted for two agents |
| `PostToolUse` artifact validation | `tool.execute.after` runs the existing artifact validator and fence-duplication checker |
| `PermissionRequest` read auto-approval | Unnecessary because each generated agent has explicit permissions |
| `PreCompact` plus restore | `experimental.session.compacting` injects fresh time and Git continuation context |
| Impeccable `PostToolUse` | `tool.execute.after` calls the installed Impeccable hook and appends its context |
| Sonar Secrets `PreToolUse` | `tool.execute.before` forwards reads through the installed `sonar` CLI when present |
| Sonar Secrets `UserPromptSubmit` | `chat.message` forwards primary-session prompts through the installed `sonar` CLI; child task prompts are skipped because Claude does not re-submit them as user prompts |

OpenCode has no reliable equivalent for Claude's `PostToolBatch`, `SubagentStart`, or `SubagentStop` payloads. Their guarantees are handled by generated configuration, orchestrator instructions, and tests rather than reconstructed from incomplete session events. Impeccable's deep `Stop` pass is also not ported because `session.idle` fires after the answer and cannot add corrective context to it.

Local hooks run through absolute, trusted Node and Sonar executable paths. Child processes receive an allowlisted environment without application credentials. Generated subagents deny every tool by default, then enable only their declared read/search tools; the two Git-history agents also deny command chaining, redirection, external diffs, text conversion, and output-file options.

Sonar blocks only explicit structured denials. If the local scanner process crashes, times out, or exits without a denial payload, the adapter fails open and records a warning instead of misreporting the operational failure as a detected secret.

The plugin publishes one immutable runtime snapshot as `RPIV_CAPABILITIES` through `shell.env`. It reports whether CodeScene, SonarQube, and Context Mode MCPs are configured plus whether local Node/Sonar hook executables were found. Workflow helpers combine this snapshot with repository-local detection instead of repeatedly probing MCP availability or treating an operational failure as an absent capability.

Claude's skill-local `allowed-tools` grants have no exact OpenCode equivalent: OpenCode scopes permissions to agents, not to one skill invocation. Explicit `/rpiv:*` workflows therefore retain the permissions of the selected primary agent. Keep OpenCode's normal confirmation policy enabled for edits and shell commands. Creating hidden command-specific agents was rejected because commands would switch the active session agent and could break interactive RPIV checkpoints.

## CodeScene

Register CodeScene as a local MCP server:

```json
{
  "mcp": {
    "codescene": {
      "type": "local",
      "command": ["npx", "-y", "@codescene/codehealth-mcp"],
      "environment": {
        "CS_ACCESS_TOKEN": "{env:CS_ACCESS_TOKEN}"
      },
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

OpenCode already discovers the CodeScene skills under `~/.claude/skills`; copying them into `~/.config/opencode/skills` would create duplicate skill IDs. Keep `CS_ACCESS_TOKEN` in the user environment or CodeScene's own persistent configuration, never in JSON.

## Development

```sh
pnpm generate:opencode
pnpm test:opencode
pnpm lint
pnpm deps
pnpm knip
```

The adapter is deliberately zero-dependency at runtime. `@opencode-ai/plugin` is a development-only type dependency pinned to the OpenCode version used for this port.
