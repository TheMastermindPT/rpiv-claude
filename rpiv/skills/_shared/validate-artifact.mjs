// validate-artifact.mjs — deterministic finalization lint for .rpiv artifacts.
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/_shared/validate-artifact.mjs" <artifact.md> [more.md ...] [--root <dir>]
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
//   - `status: ready` but body still holds unfilled `{template tokens}` in prose
//   - TODO / TBD / FIXME left in prose
//   - an empty code fence
//   - a `parent:` that points at a file that does not exist
//   - a `content_hash:` that no longer matches the body (a ready artifact edited after finalization)
//
// `--stamp` writes `content_hash:` into an artifact's frontmatter after its checks pass; the
// finalizing skill calls it at the `ready` flip so later verify runs detect post-finalization
// edits. This is git-INDEPENDENT — it works even if .rpiv is gitignored. The body hash normalizes
// CRLF and trailing whitespace so formatting churn is not flagged; a `--stamp` is an explicit
// re-finalization, so it catches casual/accidental edits, not a determined editor who re-stamps.
//
// The repo-wide "CLAUDE.md Standing Decisions block is in sync" check is a sibling gate; run
// `regen-decisions-index.mjs --check` for it (it shares this module's frontmatter parser).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { splitFrontmatter } from "./regen-decisions-index.mjs";

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

/** Remove fenced ```blocks``` and `inline code` so prose scans don't false-positive on code. */
function stripCode(body) {
	return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** All fenced code blocks as { lang, inner } for empty-fence detection. */
function fencedBlocks(body) {
	const out = [];
	const re = /```([^\n]*)\n([\s\S]*?)```/g;
	let m;
	while ((m = re.exec(body)) !== null) out.push({ lang: m[1].trim(), inner: m[2] });
	return out;
}

/** Normalized body hash — CRLF and trailing whitespace ignored so formatting churn is not flagged. */
const bodyHash = (body) => createHash("sha256").update(body.replace(/\r\n/g, "\n").trimEnd()).digest("hex");

export function validateArtifact(artifactPath, root, { verifyHash = true, finalizing = false } = {}) {
	const errors = [];
	if (!existsSync(artifactPath)) return { errors: [`file not found: ${artifactPath}`] };

	const text = readFileSync(artifactPath, "utf-8");
	const { fm, body } = splitFrontmatter(text);

	// 1. Required frontmatter fields — universal core plus any extras for this artifact kind.
	const required = [...CORE_REQUIRED, ...(KIND_EXTRA_REQUIRED[artifactKind(artifactPath)] ?? [])];
	for (const key of required) {
		if (!fm[key] || fm[key].trim() === "") errors.push(`missing frontmatter field: ${key}`);
	}

	// Finalization checks apply when the artifact is already `ready` OR is being flipped to ready
	// now (--finalizing) — the flip gate must run BEFORE the status Edit, so it cannot rely on the
	// status field alone. A plain in-progress draft (no --finalizing) is exempt, so tokens are fine
	// mid-authoring.
	const finalizingOrReady = fm.status === "ready" || finalizing;
	const prose = stripCode(body);

	// 2. Unfilled template tokens in prose. `$`-prefixed braces are JS template-literal
	// syntax quoted from source code (a nested backtick inside an inline code span breaks
	// stripCode's span regex and leaks e.g. `${region}` into "prose") — artifact
	// placeholders are never $-prefixed, so exclude them.
	if (finalizingOrReady) {
		const tokens = prose.match(/(?<!\$)\{[a-zA-Z][^{}\n]{0,50}\}/g) ?? [];
		for (const t of new Set(tokens)) errors.push(`unfilled template token in prose: ${t}`);
	}

	// 3. Leftover placeholders.
	const placeholders = prose.match(/\b(TODO|TBD|FIXME)\b/g) ?? [];
	for (const p of new Set(placeholders)) errors.push(`placeholder left in prose: ${p}`);

	// 4. Empty code fences.
	for (const { lang, inner } of fencedBlocks(body)) {
		if (inner.trim() === "") errors.push(`empty code fence${lang ? ` (\`\`\`${lang})` : ""}`);
	}

	// 5. Parent artifact exists (only when a parent is declared and is a real path, not a token).
	if (fm.parent && !/[{}]/.test(fm.parent)) {
		const parentPath = isAbsolute(fm.parent) ? fm.parent : join(root, fm.parent);
		if (!existsSync(parentPath)) errors.push(`parent artifact not found: ${fm.parent}`);
	}

	// 6. Ready-artifact hash-pin: a content_hash that no longer matches the body means the artifact
	//    was edited after finalization. Git-independent, so it holds even if .rpiv is gitignored.
	if (verifyHash && fm.content_hash && fm.content_hash.trim() !== "") {
		if (bodyHash(body) !== fm.content_hash.trim()) {
			errors.push("content_hash mismatch: body edited after finalization (re-stamp if intentional)");
		}
	}

	return { errors };
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
const isMain = (() => {
	try {
		return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
	} catch {
		return false;
	}
})();
if (isMain) {
	const args = process.argv.slice(2);
	const stamp = args.includes("--stamp");
	const finalizing = args.includes("--finalizing");
	const rootIdx = args.indexOf("--root");
	const rootValIdx = rootIdx === -1 ? -1 : rootIdx + 1;
	const root = rootIdx !== -1 ? resolve(args[rootValIdx]) : process.cwd();
	const paths = args.filter((a, i) => !a.startsWith("--") && i !== rootValIdx);
	if (paths.length === 0) {
		process.stderr.write(
			"usage: validate-artifact.mjs <artifact.md> [more.md ...] [--root <dir>] [--finalizing] [--stamp]\n",
		);
		process.exit(2);
	}
	let totalErrors = 0;
	for (const p of paths) {
		const abs = resolve(p);
		// When stamping we are about to rewrite the hash, so don't verify the old one.
		const { errors } = validateArtifact(abs, root, { verifyHash: !stamp, finalizing });
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
