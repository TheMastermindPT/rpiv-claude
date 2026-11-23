// validate-artifact.mjs — deterministic finalization lint for .rpiv artifacts.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <artifact.md> [more.md ...] [--root <dir>]
//        [--finalizing [--slice <id>]...] [--stamp]
//
// Runs the cheap, deterministic checks that LLM reviewers are worst at and a script is best at,
// so a skill can gate a `status: in-progress -> ready` flip on them. Any finding fails (exit 1).
// The checks here aim to be zero-false-positive on real artifacts: a lint that cries wolf gets
// disabled. (A body file-reference check was prototyped and dropped — artifacts legitimately use
// context-relative paths, globs, and illustrative placeholders, so it was ~all false alarms.) The
// lone heuristic is the unfilled-token scan (check 2), which flags any `{...}` left in prose — put
// genuine brace prose (e.g. `{a, b}`) inside a code span/fence, both of which are stripped first.
//
// Checks (all ERRORS):
//   - missing a required frontmatter field
//   - a `lane` that is not fast or normal (an older `rigorous` reads as normal), a lane without non-empty `lane_reasons`,
//     or `lane_reasons` without a lane (no lane fields at all is valid)
//   - `status: ready` but body still holds unfilled `{template tokens}` in prose
//   - TODO / TBD / FIXME left in prose
//   - an empty code fence
//   - with --finalizing, in designs and plans only (D26): a code fence over 10 inner lines, and
//     an unterminated code fence
//   - a `parent:` that points at a file that does not exist
//   - a `content_hash:` that no longer matches the body (a ready artifact edited after finalization)
//   - with --finalizing, a `Test Contract: <id>` section not yet approved that has a Behavior
//     without a Test line or a Test clause test-contract.mjs cannot read. A section whose exact
//     text is in an approved copy (.rpiv/evidence/<stem>/approved-*.md, beside the brief or in the
//     main worktree when the brief sits in a linked one) only warns: approved
//     text of an append-only brief is never edited. `--slice <id>` (repeatable) names the sections
//     being approved instead, for a brief whose approved copies are not kept.
//
// `--stamp` writes `content_hash:` into an artifact's frontmatter after its checks pass; the
// finalizing skill calls it at the `ready` flip so later verify runs detect post-finalization
// edits. This is git-INDEPENDENT — it works even if .rpiv is gitignored. The body hash normalizes
// CRLF and trailing whitespace so formatting churn is not flagged; a `--stamp` is an explicit
// re-finalization, so it catches casual/accidental edits, not a determined editor who re-stamps.
//
// The repo-wide "CLAUDE.md Standing Decisions block is in sync" check is a sibling gate; run
// `regen-decisions-index.mjs --check` for it (it shares this module's frontmatter parser).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseFences } from "./fences.mjs";
import { splitFrontmatter } from "./frontmatter.mjs";
import { isMain } from "./is-main.mjs";
import { laneOf } from "./lane.mjs";
import { contractProblems, contractSections } from "./test-contract.mjs";

// Universal core — every artifact template's frontmatter carries these.
const CORE_REQUIRED = ["date", "author", "commit", "branch", "repository", "status"];

// Extra required fields per artifact kind, keyed by the directory segment under
// `artifacts/` (or "test-cases"). A kind absent here requires only CORE. Derived from
// each kind's actual template — do NOT list a field a kind's template does not emit.
// (The old flat list required `topic`/`last_updated`/`last_updated_by` of everything,
// but review/design/research/plan/annotate templates emit none of them — so every such
// artifact failed with false-positive "missing frontmatter field" errors. This surfaced
// only once validate-on-write actually began firing at save time.)
const KIND_EXTRA_REQUIRED = {
	discover: ["topic", "last_updated", "last_updated_by"],
	validation: ["topic", "last_updated", "last_updated_by"],
	"architecture-reviews": ["last_updated", "last_updated_by"],
};

/** Artifact kind = the path segment under `artifacts/`, or "test-cases", else "". */
function artifactKind(artifactPath) {
	const p = artifactPath.replaceAll("\\", "/");
	const m = p.match(/\/artifacts\/([^/]+)\//);
	if (m) return m[1];
	return /(?:^|\/)test-cases\//.test(p) ? "test-cases" : "";
}

/** An inline code span on one line: a backtick run closed by the next run of the same length. */
const CODE_SPAN = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;

/**
 * Remove closed fenced blocks and `inline code` so prose scans don't false-positive on code.
 * An unclosed fence is kept as prose, so it can never hide a TODO or token (D26).
 */
function stripCode(body, fences) {
	const fenced = new Set(fences.flatMap(({ start, end }) => Array.from({ length: end - start + 1 }, (_, i) => start + i)));
	return body
		.split(/\r?\n/)
		.filter((_, i) => !fenced.has(i + 1))
		.join("\n")
		.replace(CODE_SPAN, "");
}

/** Kinds whose fences are size-limited at finalization (D26), and the limit in inner lines. */
const FENCE_RULE_KINDS = new Set(["designs", "plans"]);
const MAX_FENCE_LINES = 10;

/** Finalization fence errors for `body`, with line numbers counted in the whole file `text`. */
function fenceRuleErrors(text, body) {
	const offset = text.slice(0, text.length - body.length).split("\n").length - 1;
	const { fences, unterminated } = parseFences(body);
	const errors = [];
	for (const { start, lines } of fences) {
		if (lines.length > MAX_FENCE_LINES) {
			errors.push(`code fence over ${MAX_FENCE_LINES} lines at line ${start + offset}: ${lines.length} lines`);
		}
	}
	if (unterminated) errors.push(`unterminated code fence at line ${unterminated.start + offset}`);
	return errors;
}

/** A Test Contract section's identity: its id and its lines, trailing spaces ignored. */
const sectionKey = ({ id, body }) =>
	[id, ...body.map(({ line }) => line.trimEnd())].join("\n").trimEnd();

/** The approved copies of `artifactPath`: `.rpiv/evidence/<stem>/approved-*.md` beside
    the `.rpiv/artifacts/` folder that holds it (candidate-workflow.md). */
export function approvedCopies(artifactPath) {
	const p = artifactPath.replaceAll("\\", "/");
	const at = p.lastIndexOf("/.rpiv/artifacts/");
	if (at === -1) return [];
	const home = p.slice(0, at);
	const stem = basename(p).replace(/\.md$/, "");
	const homes = [home, mainWorktreeTwin(home)].filter(Boolean);
	const dirs = new Set(homes.map((h) => resolve(h, ".rpiv", "evidence", stem)));
	return [...dirs].flatMap(listApproved);
}

/** Where a new approved copy of `artifactPath` goes: `.rpiv/evidence/<stem>/` beside the
    artifact's own `.rpiv/`, unless that folder is gitignored in a linked worktree, where
    the copy would be lost with the worktree: then in the main worktree. A repository
    that tracks its evidence keeps each worktree's copy in that worktree, so parallel
    workers do not write into the main checkout. Null for a file outside
    `.rpiv/artifacts/`. */
export function approvedCopyDir(artifactPath) {
	const p = artifactPath.replaceAll("\\", "/");
	const at = p.lastIndexOf("/.rpiv/artifacts/");
	if (at === -1) return null;
	const home = p.slice(0, at);
	const stem = basename(p).replace(/\.md$/, "");
	const own = resolve(home, ".rpiv", "evidence", stem);
	if (!isIgnored(home, own)) return own;
	return resolve(mainWorktreeTwin(home) ?? home, ".rpiv", "evidence", stem);
}

/** True when git ignores files in `folder` for the repository at `dir`; false when it
    does not, or outside a git repository. */
function isIgnored(dir, folder) {
	const probe = join(folder, "approved-probe.md");
	const res = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", probe], { cwd: dir });
	return res.status === 0;
}

/** The `approved-*.md` files in `dir`; none when it does not exist. */
const listApproved = (dir) =>
	existsSync(dir)
		? readdirSync(dir)
				.filter((name) => /^approved-.*\.md$/.test(name))
				.map((name) => join(dir, name))
		: [];

/** The folder at the same place in the main worktree when `dir` sits in a linked one:
    .rpiv/evidence is gitignored, so approved copies live only in the main checkout.
    `dir` itself in the main worktree; null outside a git repository. */
function mainWorktreeTwin(dir) {
	const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
	const top = git(["rev-parse", "--show-toplevel"]);
	const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (top.status !== 0 || common.status !== 0) return null;
	return join(dirname(common.stdout.trim()), relative(top.stdout.trim(), dir));
}

/** The Test Contract sections of `text`, or the error that hides them: an unterminated
    fence, which only an artifact holding a contract heading loses anything to. */
function readContracts(text) {
	try {
		return { sections: contractSections(text), errors: [] };
	} catch (error) {
		const hasContract = /^#{2,6}\s+Test Contract:/m.test(text);
		return { sections: [], errors: hasContract ? [`test contracts unreadable: ${error.message}`] : [] };
	}
}

/** The identities of every Test Contract section any approved copy of the artifact holds. */
const approvedKeys = (artifactPath) =>
	new Set(approvedCopies(artifactPath).flatMap((copy) => contractSections(readFileSync(copy, "utf-8")).map(sectionKey)));

/** What one section's reader cannot check, as finalization messages. */
const sectionMessages = (section, duplicate) => [
	...(duplicate ? [`Test Contract ${section.id} at line ${section.line}: duplicate section id`] : []),
	...contractProblems(section.body).map(({ line, problem }) => `Test Contract ${section.id} line ${line}: ${problem}`),
];

/** Which sections this finalization approves: the named slices when `slices` names any,
    else every section no approved copy holds verbatim. */
const approvingNow = (artifactPath, slices) => {
	if (slices.length) return (section) => slices.includes(section.id);
	const approved = approvedKeys(artifactPath);
	return (section) => !approved.has(sectionKey(section));
};

/** Finalization Test Contract checks: unreadable entries are errors in a section being
    approved now, warnings in any other (approved text of an append-only brief is never
    edited). A named slice without a section is an error. */
function testContractChecks(artifactPath, text, slices = []) {
	const { sections, errors } = readContracts(text);
	const warnings = [];
	const ids = sections.map((section) => section.id);
	for (const id of slices.filter((slice) => !ids.includes(slice))) errors.push(`no Test Contract section for --slice ${id}`);
	const isNew = approvingNow(artifactPath, slices);
	for (const section of sections) {
		const duplicate = ids.indexOf(section.id) !== ids.lastIndexOf(section.id);
		(isNew(section) ? errors : warnings).push(...sectionMessages(section, duplicate));
	}
	return { errors, warnings };
}

/** Errors for the `lane` / `lane_reasons` frontmatter pair; absent fields are valid. */
function laneErrors(fm) {
	if (!Object.hasOwn(fm, "lane")) {
		return Object.hasOwn(fm, "lane_reasons") ? ["lane_reasons without lane"] : [];
	}
	const lane = fm.lane.trim();
	const errors = [];
	if (laneOf(lane) === null) errors.push(`invalid lane: ${lane} (expected fast or normal)`);
	if (/^(?:\[\s*\])?$/.test((fm.lane_reasons ?? "").trim())) errors.push(`missing lane_reasons for lane: ${lane}`);
	return errors;
}

/** Normalized body hash — CRLF and trailing whitespace ignored so formatting churn is not flagged. */
const bodyHash = (body) => createHash("sha256").update(body.replace(/\r\n/g, "\n").trimEnd()).digest("hex");

/** The `content_hash` an artifact's text has (its body's hash), as a stamp writes it (S17). */
export const contentHashOf = (text) => bodyHash(splitFrontmatter(text).body);

/** Required frontmatter fields left empty: the universal core plus the artifact kind's extras. */
function missingFieldErrors(artifactPath, fm) {
	const required = [...CORE_REQUIRED, ...(KIND_EXTRA_REQUIRED[artifactKind(artifactPath)] ?? [])];
	return required.filter((key) => !fm[key] || fm[key].trim() === "").map((key) => `missing frontmatter field: ${key}`);
}

/** A declared parent (a real path, not a token) that does not exist. */
function parentErrors(fm, root) {
	if (!fm.parent || /[{}]/.test(fm.parent)) return [];
	const parentPath = isAbsolute(fm.parent) ? fm.parent : join(root, fm.parent);
	return existsSync(parentPath) ? [] : [`parent artifact not found: ${fm.parent}`];
}

/** A recorded `content_hash` that no longer matches the body. */
function hashErrors(fm, body) {
	const recorded = (fm.content_hash ?? "").trim();
	if (recorded === "" || bodyHash(body) === recorded) return [];
	return ["content_hash mismatch: body edited after finalization (re-stamp if intentional)"];
}

export function validateArtifact(artifactPath, root, { verifyHash = true, finalizing = false, slices = [] } = {}) {
	const errors = [];
	const warnings = [];
	if (!existsSync(artifactPath)) return { errors: [`file not found: ${artifactPath}`] };

	const text = readFileSync(artifactPath, "utf-8");
	const { fm, body } = splitFrontmatter(text);

	// 1. Required frontmatter fields — universal core plus any extras for this artifact kind.
	errors.push(...missingFieldErrors(artifactPath, fm));

	// 1b. Lane fields (candidate-workflow.md **Lanes**): optional, but when present `lane` is one
	//     of the three lanes and carries its reasons. No lane at all reads as `normal` downstream.
	errors.push(...laneErrors(fm));

	// Finalization checks apply when the artifact is already `ready` OR is being flipped to ready
	// now (--finalizing) — the flip gate must run BEFORE the status Edit, so it cannot rely on the
	// status field alone. A plain in-progress draft (no --finalizing) is exempt, so tokens are fine
	// mid-authoring.
	const finalizingOrReady = fm.status === "ready" || finalizing;
	const { fences } = parseFences(body);
	const prose = stripCode(body, fences);

	// 2. Unfilled template tokens in prose. `$`-prefixed braces are JS template-literal
	// syntax quoted from source code (a stray backtick of the span's own run length inside an
	// inline code span still breaks CODE_SPAN's pairing and leaks e.g. `${region}` into "prose") — artifact
	// placeholders are never $-prefixed, so exclude them. Slash-adjacent braces are URL /
	// route templates quoted from the code under review (`/v1/databases/{id}/query`), not
	// artifact placeholders — exclude them too (zero-false-positive beats recall here;
	// a genuinely unfilled path token is nearly always inside a code span anyway).
	if (finalizingOrReady) {
		const tokens = prose.match(/(?<![$/])\{[a-zA-Z][^{}\n]{0,50}\}(?!\/)/g) ?? [];
		for (const t of new Set(tokens)) errors.push(`unfilled template token in prose: ${t}`);
	}

	// 3. Leftover placeholders.
	const placeholders = prose.match(/\b(TODO|TBD|FIXME)\b/g) ?? [];
	for (const p of new Set(placeholders)) errors.push(`placeholder left in prose: ${p}`);

	// 4. Empty code fences.
	for (const { info, lines } of fences) {
		if (lines.join("\n").trim() === "") errors.push(`empty code fence${info ? ` (\`\`\`${info})` : ""}`);
	}

	// 4b. Fence size at finalization (D26): designs and plans hold decisions, not code, so a
	//     fence over 10 inner lines belongs in the repository. Only under --finalizing, never
	//     because `status: ready` — older artifacts stay valid until re-finalized.
	if (finalizing && FENCE_RULE_KINDS.has(artifactKind(artifactPath))) {
		errors.push(...fenceRuleErrors(text, body));
	}

	// 4c. Test Contracts at finalization: every Test line in a section being approved now is
	//     one the slice preflight can check (test-contract-authoring.md, Test line grammar).
	if (finalizing) {
		const contracts = testContractChecks(artifactPath, text, slices);
		errors.push(...contracts.errors);
		warnings.push(...contracts.warnings);
	}

	// 5. Parent artifact exists (only when a parent is declared and is a real path, not a token).
	errors.push(...parentErrors(fm, root));

	// 6. Ready-artifact hash-pin: a content_hash that no longer matches the body means the artifact
	//    was edited after finalization. Git-independent, so it holds even if .rpiv is gitignored.
	if (verifyHash) errors.push(...hashErrors(fm, body));

	return { errors, warnings };
}

/** Write `content_hash:` (last frontmatter field) after checks pass, so later runs detect edits. */
export function stampArtifact(artifactPath) {
	const text = readFileSync(artifactPath, "utf-8");
	const fmEnd = text.indexOf("\n---", 3);
	if (!text.startsWith("---") || fmEnd === -1) throw new Error(`no frontmatter to stamp: ${artifactPath}`);
	const { body } = splitFrontmatter(text);
	const hash = bodyHash(body);
	const fmLines = text
		.slice(0, fmEnd)
		.split("\n")
		.filter((l) => !/^content_hash:\s*/.test(l));
	writeFileSync(artifactPath, `${fmLines.join("\n")}\ncontent_hash: ${hash}${text.slice(fmEnd)}`);
	return hash;
}

// ---- CLI ---------------------------------------------------------------------------------------
if (isMain(import.meta.url)) {
	const args = process.argv.slice(2);
	const stamp = args.includes("--stamp");
	const finalizing = args.includes("--finalizing");
	const rootIdx = args.indexOf("--root");
	const rootValIdx = rootIdx === -1 ? -1 : rootIdx + 1;
	const root = rootIdx !== -1 ? resolve(args[rootValIdx]) : process.cwd();
	// --slice <id> (repeatable): the slices whose Test Contracts this finalization approves.
	const sliceValIdx = args.flatMap((a, i) => (a === "--slice" ? [i + 1] : []));
	const slices = sliceValIdx.map((i) => args[i]).filter((v) => v !== undefined && !v.startsWith("--"));
	const paths = args.filter((a, i) => !a.startsWith("--") && i !== rootValIdx && !sliceValIdx.includes(i));
	if (paths.length === 0 || slices.length !== sliceValIdx.length) {
		process.stderr.write(
			"usage: validate-artifact.mjs <artifact.md> [more.md ...] [--root <dir>] [--finalizing [--slice <id>]...] [--stamp]\n",
		);
		process.exit(2);
	}
	let totalErrors = 0;
	for (const p of paths) {
		const abs = resolve(p);
		// When stamping we are about to rewrite the hash, so don't verify the old one.
		const { errors, warnings = [] } = validateArtifact(abs, root, { verifyHash: !stamp, finalizing, slices });
		for (const w of warnings) process.stderr.write(`WARN ${p}: ${w}\n`);
		for (const e of errors) process.stderr.write(`ERROR ${p}: ${e}\n`);
		totalErrors += errors.length;
		if (stamp && errors.length === 0) {
			const h = stampArtifact(abs);
			process.stdout.write(`stamped ${p}: content_hash ${h.slice(0, 12)}...\n`);
		}
	}
	if (totalErrors > 0) {
		process.stderr.write(`\nvalidate-artifact: ${totalErrors} error(s) — resolve before flipping status: ready\n`);
		process.exit(1);
	}
	process.stdout.write(stamp ? "validate-artifact: OK (stamped)\n" : "validate-artifact: OK\n");
	process.exit(0);
}
