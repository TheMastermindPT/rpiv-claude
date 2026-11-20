// approval.mjs — the one call per approval step (candidate-workflow.md **Intent And
// Brief**). Agents never compute hashes or copy approved files by hand, and the developer
// is asked only when the append-only rule says the approval no longer holds.
//
// CLI, run only as the entry point:
//   node approval.mjs check  <artifact.md>
//   node approval.mjs record <artifact.md> [--slice <id>]...
//
// check: compares the artifact with its newest approved copy (append-only.mjs).
//   - `approval: keep` (exit 0): only allowed additions; the artifact is validated and
//     re-stamped, and nobody is asked.
//   - `approval: ask` (exit 1): no approved copy yet (`reason: no approved copy yet`), or
//     changes beyond the rule, one `change:` line each, to show the developer verbatim.
//   - `approval: invalid` (exit 1): the additions keep the approval but the artifact fails
//     validation; one `error:` line each.
// record: after the developer approved, runs validate-artifact --finalizing (with the
//   `--slice` options given), stamps `content_hash`, and saves the exact file as
//   `.rpiv/evidence/<stem>/approved-<content_hash>.md`. Prints `approval: recorded`,
//   `content_hash:` and `copy:` (exit 0), or `approval: invalid` with `error:` lines (exit 1).
// A broken call (usage, unreadable artifact, git failing) prints `approval: broken:
// <detail>` on stderr and exits 2, never a verdict.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendOnlyProblems } from "./append-only.mjs";
import { isMain } from "./is-main.mjs";
import {
	approvedCopies,
	approvedCopyDir,
	stampArtifact,
	validateArtifact,
} from "./validate-artifact.mjs";

/** The newest approved copy of `artifact` (the latest approval governs), or null. */
const newestApprovedCopy = (artifact) =>
	approvedCopies(artifact)
		.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;

const invalid = (errors) => ({
	code: 1,
	text: ["approval: invalid", ...errors.map((e) => `error: ${e}`)].join("\n"),
});

/** Validate (without the old hash, which is about to change) and stamp. */
const validateAndStamp = (artifact, options) => {
	const { errors } = validateArtifact(artifact, process.cwd(), {
		verifyHash: false,
		...options,
	});
	return errors.length ? { errors } : { hash: stampArtifact(artifact) };
};

const check = (artifact) => {
	const approved = newestApprovedCopy(artifact);
	if (!approved)
		return {
			code: 1,
			text: "approval: ask\nreason: no approved copy yet (first approval)",
		};
	const problems = appendOnlyProblems(approved, artifact);
	if (problems.length)
		return {
			code: 1,
			text: [
				"approval: ask",
				`reason: changes beyond the append-only rule since ${approved}`,
				...problems.map((p) => `change: ${p}`),
			].join("\n"),
		};
	const { errors, hash } = validateAndStamp(artifact, {});
	if (errors) return invalid(errors);
	return {
		code: 0,
		text: `approval: keep\napproved copy: ${approved}\ncontent_hash: ${hash}`,
	};
};

const record = (artifact, slices) => {
	const dir = approvedCopyDir(artifact);
	if (!dir) throw new Error(`not under .rpiv/artifacts/: ${artifact}`);
	const { errors, hash } = validateAndStamp(artifact, {
		finalizing: true,
		slices,
	});
	if (errors) return invalid(errors);
	mkdirSync(dir, { recursive: true });
	const copy = join(dir, `approved-${hash}.md`);
	copyFileSync(artifact, copy);
	return {
		code: 0,
		text: `approval: recorded\ncontent_hash: ${hash}\ncopy: ${copy}`,
	};
};

/** True when `value` can be an option's value: present and not another option. */
const isValue = (value) => Boolean(value) && !value.startsWith("--");

/** `--slice <id>` values; throws on any other option or a missing value. */
const slicesOf = (rest) => {
	const slices = [];
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i], rest[i + 1]];
		if (flag !== "--slice" || !isValue(value))
			throw new Error(`unexpected argument: ${flag}`);
		slices.push(value);
	}
	return slices;
};

const USAGE =
	"usage: approval.mjs check <artifact.md> | record <artifact.md> [--slice <id>]...";

/** The verdict text and exit code for one call; throws on a broken call. */
const run = ([command, file, ...rest]) => {
	if (!["check", "record"].includes(command) || !file) throw new Error(USAGE);
	const artifact = resolve(file);
	if (!existsSync(artifact) || !statSync(artifact).isFile())
		throw new Error(`artifact is not a readable file: ${artifact}`);
	if (command === "check") {
		if (rest.length) throw new Error(USAGE);
		return check(artifact);
	}
	return record(artifact, slicesOf(rest));
};

if (isMain(import.meta.url)) {
	try {
		const { code, text } = run(process.argv.slice(2));
		process.stdout.write(`${text}\n`);
		process.exitCode = code;
	} catch (error) {
		process.stderr.write(`approval: broken: ${error.message}\n`);
		process.exitCode = 2;
	}
}
