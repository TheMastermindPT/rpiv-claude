// cycle-timing.mjs — the timing lines of one branch's cycle (cycles.mjs prints
// them): how long each stage ran, how long the developer took to answer, and how
// long each kind of agent ran. Records are the branch's parsed cycle-log lines,
// in log order. A time the log does not hold is said to be missing, never read
// as zero (degrade-distinguishes-broken).
//
// Importable: formatDuration, stageLines, waitingLine, agentLines.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const pad = (n) => String(n).padStart(2, "0");

/** `45s`, `3m 05s` or `1h 10m` for a duration in milliseconds. */
export function formatDuration(ms) {
	const total = Math.max(0, Math.round(ms / SECOND));
	if (total < 60) return `${total}s`;
	if (total < HOUR / SECOND)
		return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
	const minutes = Math.floor(total / 60);
	return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

const timeOf = (rec) => Date.parse(rec.time);

/** One `stage:` line per stage start, with the time until the next stage starts
    (the last stage runs until the branch's last record). */
export function stageLines(own) {
	const stages = own.filter((rec) => rec.event === "stage");
	const end = timeOf(own.at(-1));
	return stages.map((rec, i) => {
		const until = i + 1 < stages.length ? timeOf(stages[i + 1]) : end;
		return `stage: ${rec.time} ${rec.stage} (${formatDuration(until - timeOf(rec))})`;
	});
}

const isWait = (ms) => Number.isInteger(ms) && ms >= 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The `waiting:` line: the developer's answer time over the asks that hold it. */
export function waitingLine(own) {
	const asks = own.filter((rec) => rec.event === "decision");
	if (asks.length === 0) return "waiting: none";
	const timed = asks.filter((rec) => isWait(rec.wait_ms));
	const missing = asks.length - timed.length;
	const without = `${plural(missing, "ask")} without time`;
	if (timed.length === 0) return `waiting: not recorded (${without})`;
	const total = timed.reduce((sum, rec) => sum + rec.wait_ms, 0);
	const head = `waiting: ${formatDuration(total)} over ${plural(timed.length, "ask")}`;
	return missing > 0 ? `${head} (${without})` : head;
}

/** Pairs each agent finish with its agent's latest start. Returns the runs
    `{ agent, ms }`, the starts left open and the finishes with no start. */
function pairAgentRuns(own) {
	const state = { open: new Map(), runs: [], anonymousStarts: 0, orphans: 0 };
	for (const rec of own) {
		if (rec.event === "dispatch") onStart(state, rec);
		else if (rec.event === "agent-done") onFinish(state, rec);
	}
	return {
		runs: state.runs,
		unfinished: state.open.size + state.anonymousStarts,
		orphans: state.orphans,
	};
}

const agentIdOf = (rec) =>
	typeof rec.agent_id === "string" ? rec.agent_id : null;

/** A start opens its agent's run; a start with no id can never be paired. */
function onStart(state, rec) {
	const id = agentIdOf(rec);
	if (id === null) state.anonymousStarts++;
	else state.open.set(id, rec);
}

/** A finish closes its agent's latest open start, or is an orphan. */
function onFinish(state, rec) {
	const id = agentIdOf(rec);
	const start = id === null ? undefined : state.open.get(id);
	if (start === undefined) {
		state.orphans++;
		return;
	}
	state.open.delete(id);
	state.runs.push({
		agent: start.agent || "(no type)",
		ms: timeOf(rec) - timeOf(start),
	});
}

/** Total run time per agent kind, longest first. */
function totalsByAgent(runs) {
	const totals = new Map();
	for (const { agent, ms } of runs) {
		const sum = totals.get(agent) ?? { runs: 0, ms: 0 };
		totals.set(agent, { runs: sum.runs + 1, ms: sum.ms + ms });
	}
	return [...totals].sort((a, b) => b[1].ms - a[1].ms);
}

/** `agent-time:` lines per agent kind, then any agent with no finish recorded
    and a diagnostic for finishes that match no start. */
export function agentLines(own) {
	const { runs, unfinished, orphans } = pairAgentRuns(own);
	const lines = totalsByAgent(runs).map(
		([agent, sum]) =>
			`agent-time: ${agent} ${plural(sum.runs, "run")} ${formatDuration(sum.ms)}`,
	);
	if (unfinished > 0) lines.push(`agents without finish: ${unfinished}`);
	if (orphans > 0)
		lines.push(
			`diagnostic: ${orphans} agent finish${orphans === 1 ? "" : "es"} without a start`,
		);
	return lines;
}
