#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LARGE_PATCH_BYTES = 1_000_000;

/**
 * Selects the diff context used for a generated review patch.
 *
 * @param {number} patchSizeBytes - Size of the patch generated with full context.
 * @returns {10 | 30} The bounded context line count.
 */
export function contextForPatchSize(patchSizeBytes) {
	return patchSizeBytes > LARGE_PATCH_BYTES ? 10 : 30;
}

let gitRoot = null;
function runGit(args, acceptedStatuses = [0]) {
	if (gitRoot == null) {
		const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		});
		gitRoot = probe.stdout?.trim() || "";
	}
	const result = spawnSync("git", args, {
		cwd: gitRoot || undefined,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (!acceptedStatuses.includes(result.status ?? 1)) {
		throw new Error(
			result.error?.message ||
				result.stderr?.trim() ||
				`git ${args.join(" ")} failed`,
		);
	}
	return result.stdout;
}

function untrackedPatch(files, context) {
	return files
		.map((file) =>
			runGit(
				["diff", "--no-index", `-U${context}`, "--", "/dev/null", file],
				[0, 1],
			),
		)
		.join("");
}

function workingPatch(mode, files, context) {
	const pathspec = ["--", ...files];
	if (mode === "commit")
		return runGit([
			"show",
			"--format=fuller",
			`-U${context}`,
			"HEAD",
			...pathspec,
		]);
	if (mode === "staged")
		return runGit(["diff", "--cached", `-U${context}`, ...pathspec]);
	if (mode === "working") return runGit(["diff", `-U${context}`, ...pathspec]);
	if (mode === "modified")
		return runGit(["diff", `-U${context}`, "HEAD", ...pathspec]);
	if (mode === "untracked") return untrackedPatch(files, context);
	throw new Error(`Unsupported working-tree mode: ${mode}`);
}

function committedPatch(manifest, files, context) {
	if (Array.isArray(manifest.commits)) {
		return manifest.commits
			.map((hash) =>
				runGit([
					"show",
					hash,
					"--format=fuller",
					"--patch",
					`-U${context}`,
					"--",
					...files,
				]),
			)
			.join("");
	}
	const firstParent = manifest.fpFlag ? [manifest.fpFlag] : [];
	return runGit([
		"log",
		manifest.range,
		...firstParent,
		"--patch",
		"--reverse",
		"--no-merges",
		`-U${context}`,
		"--",
		...files,
	]);
}

function createPatch(manifest, files, context) {
	return manifest.strategy === "working-tree"
		? workingPatch(manifest.mode, files, context)
		: committedPatch(manifest, files, context);
}

function shardStat(manifest, files) {
	const pathspec = ["--", ...files];
	if (manifest.strategy !== "working-tree") {
		if (Array.isArray(manifest.commits)) {
			return manifest.commits
				.map((hash) =>
					runGit(["show", hash, "--stat", "--format=", ...pathspec]),
				)
				.join("");
		}
		const firstParent = manifest.fpFlag ? [manifest.fpFlag] : [];
		return runGit([
			"log",
			manifest.range,
			...firstParent,
			"--stat",
			"--format=",
			"--reverse",
			...pathspec,
		]);
	}
	if (manifest.mode === "commit") {
		return runGit(["show", "HEAD", "--stat", "--format=", ...pathspec]);
	}
	if (manifest.mode === "staged") {
		return runGit(["diff", "--cached", "--stat", ...pathspec]);
	}
	if (manifest.mode === "modified") {
		return runGit(["diff", "HEAD", "--stat", ...pathspec]);
	}
	return runGit(["diff", "--stat", ...pathspec]);
}

function commitMessages(manifest) {
	if (manifest.strategy === "working-tree") {
		return manifest.mode === "commit"
			? runGit(["show", "HEAD", "--format=%H %s%n%n%b%n---", "--no-patch"])
			: "(n/a)";
	}
	if (Array.isArray(manifest.commits)) {
		return manifest.commits
			.map((hash) =>
				runGit(["show", hash, "--format=%H %s%n%n%b%n---", "--no-patch"]),
			)
			.join("\n");
	}
	const firstParent = manifest.fpFlag ? [manifest.fpFlag] : [];
	return runGit([
		"log",
		manifest.range,
		...firstParent,
		"--reverse",
		"--format=%H %s%n%n%b%n---",
	]);
}

function reviewContext(manifest) {
	return {
		stat: manifest.shards
			.map((shard) => shardStat(manifest, shard.files))
			.join(""),
		commitMessages: commitMessages(manifest),
	};
}

/**
 * Generates one bounded patch file for each manifest shard.
 *
 * @param {string} manifestInput - Absolute or repository-relative manifest path.
 * @returns {{ manifest: string, patches: Array<{ id: string, category: string, path: string, files: string[], context: 10 | 30, bytes: number }> }} Patch metadata.
 */
export function assembleReviewPatches(manifestInput) {
	const manifestPath = isAbsolute(manifestInput)
		? manifestInput
		: resolve(manifestInput);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
		throw new Error("Review manifest contains no shards");
	}
	const repositoryRoot = runGit(["rev-parse", "--show-toplevel"]).trim();
	const manifestDirectory = dirname(manifestPath);
	const context = reviewContext(manifest);
	const patches = manifest.shards.map((shard) => {
		let context = 30;
		let content = createPatch(manifest, shard.files, context);
		if (contextForPatchSize(Buffer.byteLength(content)) === 10) {
			context = 10;
			content = createPatch(manifest, shard.files, context);
		}
		const absolutePath = join(
			manifestDirectory,
			`code-review-patch-${shard.id}.diff`,
		);
		writeFileSync(absolutePath, content);
		return {
			id: shard.id,
			category: shard.category,
			path: relative(repositoryRoot, absolutePath).replaceAll("\\", "/"),
			files: shard.files,
			context,
			bytes: statSync(absolutePath).size,
		};
	});
	writeFileSync(
		manifestPath,
		`${JSON.stringify({ ...manifest, ...context, patches }, null, 2)}\n`,
	);
	return {
		manifest: relative(repositoryRoot, manifestPath).replaceAll("\\", "/"),
		patches,
	};
}

const isMain =
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const manifestPath = process.argv[2];
	if (!manifestPath) {
		console.error(
			"Usage: node assemble-review-patches.mjs <code-review-files.json>",
		);
		process.exit(2);
	}
	try {
		console.log(JSON.stringify(assembleReviewPatches(manifestPath)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
