// subagent-event.mjs — the one owner of how rpiv's SubagentStop checks read their event (D28 of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
//
// Claude Code sends the agent's text as `last_assistant_message` and a plugin agent's type with
// its prefix (`rpiv:claim-verifier`); the OpenCode plugin sends `result`. A check that finds no
// text for an agent it checks must say so (NO_AGENT_OUTPUT), never return silently
// (degrade-distinguishes-broken).
//
// Importable: agentOutput, NO_AGENT_OUTPUT.

export const NO_AGENT_OUTPUT =
	"no agent output in the event (result or last_assistant_message)";

/** The agent's text: `result` when it is a non-empty string, else `last_assistant_message`, else "". */
export function agentOutput(event) {
	for (const field of ["result", "last_assistant_message"]) {
		const value = event?.[field];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}
