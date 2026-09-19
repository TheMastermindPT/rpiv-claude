import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readLog } from "../scripts/jev-lint-calibrate.mjs";
import { labelFromLog } from "../evals/harness/jev-run-labels.mjs";
import {
	readCompletedBatch,
	reserveSource,
	writeCompletedBatch,
} from "../scripts/jev-source-store.mjs";

const roots = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("canonical path aliases share a reservation", () => {
	const { log, source } = fixture();
	const release = reserveSource(log, source);
	try {
		expect(reserveSource(log, source.replaceAll("\\", "/"))).toBeNull();
		if (process.platform === "win32")
			expect(reserveSource(log, source.toUpperCase())).toBeNull();
	} finally {
		release();
	}
});

it("does not steal ownership when process inspection is denied", () => {
	const { log, source } = fixture();
	const release = reserveSource(log, source);
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("denied"), { code: "EPERM" });
	});
	try {
		expect(reserveSource(log, source)).toBeNull();
	} finally {
		release();
	}
});

it.each(["0-token.json", "invalid-token.json"])(
	"reports corrupt reservation ownership instead of stealing it: %s",
	(owner) => {
		const { log, source } = fixture();
		reserveSource(log, source);
		const dir = `${log}.sources`;
		const lock = join(
			dir,
			readdirSync(dir).find((name) => name.endsWith(".lock")),
		);
		renameSync(join(lock, readdirSync(lock)[0]), join(lock, owner));
		expect(() => reserveSource(log, source)).toThrow(
			/invalid source reservation/,
		);
	},
);

it.each([
	{ status: "pending", results: [] },
	{ status: "complete", results: {} },
])("rejects invalid completed-batch envelopes", (batch) => {
	const { log, source } = fixture();
	writeCompletedBatch(log, source, batch);
	expect(() => readCompletedBatch(log, source)).toThrow(/broken source batch/);
});

it("calibration deduplicates the durable/log representations of a completed row", () => {
	const { log, source } = fixture();
	const row = { ts: "t", source, id: "Q1", verdict: "ok", p: 0.9 };
	writeCompletedBatch(log, source, {
		status: "complete",
		source,
		results: [row],
	});
	writeFileSync(log, `${JSON.stringify(row)}\n`);
	expect(readLog(log)).toEqual([row]);
});

it("calibration recovers committed rows despite a truncated diagnostic tail", () => {
	const { log, source } = fixture();
	const rows = [
		{ ts: "t", source, id: "Q1", verdict: "ok", p: 0.9 },
		{ ts: "t", source, id: "Q2", verdict: "flag", p: 0.1 },
	];
	writeCompletedBatch(log, source, {
		status: "complete",
		source,
		results: rows,
	});
	writeFileSync(log, `${JSON.stringify(rows[0])}\n{"ts":`);
	const diagnostics = [];
	const recovered = readLog(log, (message) => diagnostics.push(message));
	expect(recovered).toEqual(rows);
	expect(diagnostics.join("\n")).toMatch(/line 2/);
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jev-source-"));
	roots.push(root);
	return { root, log: join(root, "lint.log"), source: join(root, "output.md") };
}

it("reclaims an empty reservation left by interrupted acquisition or release", () => {
	const { log, source } = fixture();
	const release = reserveSource(log, source);
	const lock = readdirSync(`${log}.sources`).find((name) =>
		name.endsWith(".lock"),
	);
	release();
	mkdirSync(join(`${log}.sources`, lock));
	const recovered = reserveSource(log, source);
	expect(typeof recovered).toBe("function");
	recovered();
});

it("different source paths have independent reservations and completion records", () => {
	const { log, source } = fixture();
	const other = `${source}.other`;
	const release = reserveSource(log, source);
	const releaseOther = reserveSource(log, other);
	try {
		expect(typeof releaseOther).toBe("function");
		writeCompletedBatch(log, source, {
			source,
			status: "complete",
			results: [{ id: "one" }],
		});
		writeCompletedBatch(log, other, {
			source: other,
			status: "complete",
			results: [{ id: "two" }],
		});
		expect(readCompletedBatch(log, source).results[0].id).toBe("one");
		expect(readCompletedBatch(log, other).results[0].id).toBe("two");
	} finally {
		release();
		releaseOther?.();
	}
});

it("recovers a reservation left by an exited process and excludes live contenders", () => {
	const { log, source } = fixture();
	const module = new URL("../scripts/jev-source-store.mjs", import.meta.url)
		.href;
	const run = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { reserveSource } from ${JSON.stringify(module)}; reserveSource(${JSON.stringify(log)}, ${JSON.stringify(source)});`,
		],
		{ encoding: "utf8" },
	);
	expect(run.status, run.stderr).toBe(0);
	const release = reserveSource(log, source);
	expect(typeof release).toBe("function");
	try {
		expect(reserveSource(log, source)).toBeNull();
	} finally {
		release();
	}
	const again = reserveSource(log, source);
	expect(typeof again).toBe("function");
	again();
});

it("failed batch publication preserves prior completion and leaves no partial batch", () => {
	const { log, source } = fixture();
	const original = { source, digest: "old", status: "complete", results: [] };
	writeCompletedBatch(log, source, original);
	const cyclic = { status: "complete", results: [] };
	cyclic.self = cyclic;
	expect(() => writeCompletedBatch(log, source, cyclic)).toThrow(/circular/i);
	expect(readCompletedBatch(log, source)).toEqual(original);
	expect(
		readdirSync(`${log}.sources`).filter((f) => f.endsWith(".tmp")),
	).toEqual([]);
});

it("mechanical labels consume the committed batch after diagnostic log rotation", () => {
	const { root, log, source } = fixture();
	writeFileSync(join(root, "a.ts"), "const value = 1;\n");
	writeCompletedBatch(log, source, {
		status: "complete",
		source,
		digest: "snapshot",
		results: [
			{
				ts: "t",
				agent: "claim-verifier",
				source,
				id: "Q1",
				verdict: "ok",
				row: "`a.ts:1` — `const value = 1;`",
			},
		],
	});
	expect(labelFromLog(log, join(root, "labels.jsonl"), source, root)).toBe(1);
});
