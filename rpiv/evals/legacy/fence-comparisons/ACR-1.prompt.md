Headless eval run — follow these two steps exactly and do nothing else.

Step 1: Use the Agent tool to spawn subagent_type "rpiv:artifact-code-reviewer" with EXACTLY the prompt between the <agent-prompt> tags below (verbatim, no additions, no summary of your own).
Step 2: When the agent returns, use the Write tool to save the agent's complete final output VERBATIM to this file: {OUT}

Do not add commentary, do not edit the output, do not run any other tools.

<agent-prompt>
Plan artifact: C:/Users/pedro/rpiv-claude/rpiv/evals/cases/artifact-code-reviewer/ACR-1.plan.md

Review the finalized plan against the live codebase at HEAD. Walk every Phase code fence, audit against code-quality / codebase-fit / actionability, emit one severity-tagged row per finding.
</agent-prompt>
