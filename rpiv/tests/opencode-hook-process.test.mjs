import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../opencode/hook-process.mjs";

const options = { cwd: tmpdir(), env: process.env, timeout: 2000 };
const embeddedBun =
	process.env.RPIV_BUN_EXECUTABLE ??
	(process.env.APPDATA &&
		join(
			process.env.APPDATA,
			"npm",
			"node_modules",
			"opencode-ai",
			"bin",
			"opencode.exe",
		));

describe("hook child process lifecycle", () => {
	it("keeps the host event loop responsive while a hook runs", async () => {
		let heartbeat = false;
		const timer = setTimeout(() => {
			heartbeat = true;
		}, 20);
		try {
			const result = await runProcess(
				process.execPath,
				["-e", "setTimeout(() => process.stdout.write('done'), 150)"],
				options,
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe("done");
			expect(heartbeat).toBe(true);
		} finally {
			clearTimeout(timer);
		}
	});

	it.skipIf(!embeddedBun || !existsSync(embeddedBun))(
		"does not prematurely time out after idle in OpenCode's embedded Bun",
		() => {
			const module = new URL("../opencode/hook-process.mjs", import.meta.url)
				.href;
			const script = [
				`const {runProcess}=await import(${JSON.stringify(module)});`,
				`const options={cwd:${JSON.stringify(tmpdir())},env:process.env,timeout:500};`,
				`const node=${JSON.stringify(process.execPath)};`,
				`const args=['-e','process.stdout.write("ready")'];`,
				"const warmup=await runProcess(node,args,options); if(warmup.status!==0)throw Error('warmup failed');",
				"await new Promise(r=>setTimeout(r,800));",
				"const result=await runProcess(node,args,options); console.log(JSON.stringify(result));",
				"if(result.status!==0||result.stdout!=='ready')process.exitCode=1;",
				"const expired=await runProcess(node,['-e','setTimeout(()=>{},10000)'],{...options,timeout:100});",
				"if(expired.status!==null||!expired.error.includes('ETIMEDOUT'))throw Error('genuine timeout not preserved');",
			].join("\n");
			const result = spawnSync(embeddedBun, ["--eval", script], {
				cwd: tmpdir(),
				env: { ...process.env, BUN_BE_BUN: "1" },
				encoding: "utf8",
				timeout: 7000,
			});
			expect(result.status, result.stdout || result.stderr).toBe(0);
			expect(JSON.parse(result.stdout).stdout).toBe("ready");
		},
		10000,
	);

	it("delivers input followed by EOF and preserves literal argv and environment", async () => {
		const input = "payload-λ";
		const arg = "literal ; & $value with spaces";
		const code =
			"let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>data+=chunk); process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({input:data,arg:process.argv[1],marker:process.env.HOOK_TEST_MARKER}));process.stderr.write('diagnostic');});";
		const result = await runProcess(process.execPath, ["-e", code, arg], {
			...options,
			input,
			env: { ...process.env, HOOK_TEST_MARKER: "fixture" },
		});
		expect(result).toMatchObject({
			status: 0,
			error: "",
			stderr: "diagnostic",
		});
		expect(JSON.parse(result.stdout)).toEqual({
			input,
			arg,
			marker: "fixture",
		});
	});

	it("closes stdin even when no input was supplied", async () => {
		const result = await runProcess(
			process.execPath,
			[
				"-e",
				"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('EOF'));",
			],
			options,
		);
		expect(result).toMatchObject({ status: 0, stdout: "EOF", error: "" });
	});

	it("retains partial diagnostics but reports a genuine timeout as failure", async () => {
		const start = performance.now();
		const result = await runProcess(
			process.execPath,
			["-e", "process.stdout.write('started');setTimeout(()=>{},10000)"],
			{ ...options, timeout: 300 },
		);
		expect(result.status).toBeNull();
		expect(result.error).toMatch(/ETIMEDOUT/);
		expect(result.stdout).toBe("started");
		expect(performance.now() - start).toBeLessThan(1800);
	});

	it("reports nonzero exits and spawn failures distinctly", async () => {
		const exited = await runProcess(
			process.execPath,
			["-e", "process.stderr.write('bad input');process.exit(7)"],
			options,
		);
		expect(exited.status).toBe(7);
		expect(exited.stderr).toBe("bad input");
		const missing = await runProcess(
			join(tmpdir(), "rpiv-missing-hook-executable"),
			["private-argv-sentinel"],
			{ ...options, input: "private-stdin-sentinel" },
		);
		expect(missing.status).toBeNull();
		expect(missing.error).toMatch(/ENOENT/);
		expect(missing.error).not.toMatch(/private-(argv|stdin)-sentinel/);
	});

	it("bounds excessive output and reports overflow rather than timeout or success", async () => {
		const result = await runProcess(
			process.execPath,
			["-e", "process.stdout.write('x'.repeat(2*1024*1024))"],
			options,
		);
		expect(result.status).toBeNull();
		expect(result.error).toMatch(/maxBuffer/);
		expect(result.error).not.toContain("ETIMEDOUT");
		expect(result.stdout.length).toBeLessThanOrEqual(1024 * 1024);
	});
});
