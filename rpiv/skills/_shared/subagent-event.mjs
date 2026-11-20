// subagent-event.mjs — the one owner of how rpiv's SubagentStop checks read their event (D28 of
// .rpiv/artifacts/designs/2026-10-04_19-05-47_risk-lanes-short-cycles.md).
//
// Claude Code sends the agent's text as `last_assistant_message` and a plugin agent's type with
// its prefix (`rpiv:claim-verifier`); the OpenCode plugin sends `result`. A check that finds no
// text for an agent it checks must say so (NO_AGENT_OUTPUT), never return silently
// (degrade-distinguishes-broken).
//
// An agent that was stopped mid tool call (interrupted, cut off) never wrote an answer.
// subagent-output-check reports that once (STOPPED_MID_TOOL_CALL); the row and citation
// checks then stay quiet instead of repeating it.
//
// Importable: agentOutput, NO_AGENT_OUTPUT, STOPPED_MID_TOOL_CALL, stoppedMidToolCall.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export const NO_AGENT_OUTPUT =
	"no agent output in the event (result or last_assistant_message)";

export const STOPPED_MID_TOOL_CALL =
	"agent stopped mid tool call before writing an answer";

/** The last assistant entry in a Claude Code subagent transcript, or null. */
function lastAssistantEntry(path) {
	const lines = readFileSync(path.replace(/^~(?=[\\/])/, homedir()), "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		const entry = JSON.parse(lines[i]);
		if (entry?.type === "assistant") return entry;
	}
	return null;
}

/** True when the event's subagent transcript shows the agent's last turn ended on a tool
    call. False when there is no transcript or it cannot be read, so a broken transcript
    still surfaces as NO_AGENT_OUTPUT. */
export function stoppedMidToolCall(event) {
	const path = event?.agent_transcript_path;
	if (typeof path !== "string" || !path) return false;
	try {
		const content = lastAssistantEntry(path)?.message?.content;
		return Array.isArray(content) && content.at(-1)?.type === "tool_use";
	} catch {
		return false;
	}
}

/** The agent's text: `result` when it is a non-empty string, else `last_assistant_message`, else "". */
export function agentOutput(event) {
	for (const field of ["result", "last_assistant_message"]) {
		const value = event?.[field];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}
