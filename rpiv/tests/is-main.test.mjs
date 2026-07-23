// tests/is-main.test.mjs — contract tests for the shared CLI-entrypoint check
// (skills/_shared/is-main.mjs). Pins symlink-safe detection AND the M2 fallback:
// a realpath failure degrades per-side to the raw path with a visible diagnostic —
// the comparison always completes, never a silent `false` (the old regen IIFE bug).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isMain } from "../skills/_shared/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_MAIN_URL = pathToFileURL(resolve(HERE, "..", "skills", "_shared", "is-main.mjs")).href;
const toPosix = (p) => p.replaceAll("\\", "/");

const tmp = mkdtempSync(join(tmpdir(), "is-main-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("isMain entrypoint detection + per-side fallback", () => {
	it("in-process: the test module is not the entrypoint; the worker script is", () => {
		expect(isMain(import.meta.url)).toBe(false);
		expect(isMain(pathToFileURL(resolve(process.argv[1])).href)).toBe(true);
	});

	it("spawned script sees itself as main, exit 0", () => {
		const script = join(tmp, "main-check.mjs");
		writeFileSync(script, `import { isMain } from ${JSON.stringify(IS_MAIN_URL)};\nprocess.stdout.write(\`\${isMain(import.meta.url)}\\n\`);\n`);
		const out = execFileSync("node", [script], { encoding: "utf-8" });
		expect(out).toBe("true\n");
	});

	it("symlinked invocation still detects main (realpath normalisation)", (ctx) => {
		const script = join(tmp, "sym-target.mjs");
		writeFileSync(script, `import { isMain } from ${JSON.stringify(IS_MAIN_URL)};\nprocess.stdout.write(\`\${isMain(import.meta.url)}\\n\`);\n`);
		const link = join(tmp, "sym-link.mjs");
		try {
			symlinkSync(script, link);
		} catch (e) {
			// Windows without developer mode cannot create file symlinks — justified skip.
			if (e?.code === "EPERM" || e?.code === "EACCES") return ctx.skip();
			throw e;
		}
		const out = execFileSync("node", [link], { encoding: "utf-8" });
		expect(out).toBe("true\n");
	});

	it("realpath failure degrades per-side to the raw path with a visible diagnostic", () => {
		const ghost = toPosix(join(tmp, "ghost.mjs")); // never created — realpath throws on BOTH sides
		const script = join(tmp, "fallback-check.mjs");
		writeFileSync(
			script,
			`import { pathToFileURL } from "node:url";\nimport { isMain } from ${JSON.stringify(IS_MAIN_URL)};\nprocess.argv[1] = ${JSON.stringify(ghost)};\nprocess.stdout.write(\`\${isMain(pathToFileURL(${JSON.stringify(ghost)}).href)}\\n\`);\n`,
		);
		const run = spawnSync("node", [script], { encoding: "utf-8" });
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("true\n"); // the OLD regen IIFE returned false here — gate silently skipped
		// stderr carries the M2 diagnostic for BOTH degraded sides
		const hits = run.stderr.match(/is-main: realpath failed/g) ?? [];
		expect(hits.length).toBe(2);
	});
});
