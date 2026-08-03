// review-range.test.mjs — scope-resolution tests for review-range.mjs, built on
// throwaway git repos. Pins the commit-list contract (BASE = parent of the oldest
// NAMED commit, so the oldest commit's own changes stay in the review — the
// 2026-08 regression), the unresolvable-entry and non-linear-list refusals, and
// the auto/explicit-range/working-tree strategies. No dependencies; prints "OK".
//
//   node skills/deep-review/_helpers/review-range.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "review-range.mjs");

const git = (repo, ...args) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const commit = (repo, file, msg) => {
	writeFileSync(join(repo, file), `${msg}\n`);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", msg);
	return git(repo, "rev-parse", "HEAD");
};

/** Run the helper, parse the labeled head lines + the three trailing blocks. */
const run = (repo, scope) => {
	const out = execFileSync("node", [HELPER, scope], { cwd: repo, encoding: "utf-8" });
	const [head, rest = ""] = out.split("---changed-files---\n");
	const kv = {};
	for (const line of head.trim().split("\n")) {
		const m = line.match(/^(\w+):\s+(.*)$/);
		if (m) kv[m[1]] = m[2];
	}
	const [changedPart, tail = ""] = rest.split("---in-scope-files---\n");
	const [inScopePart, tail2 = ""] = tail.split("---peer-pairs---\n");
	const [peerPart, companionPart = ""] = tail2.split("---companion-candidates---\n");
	const listOf = (t) =>
		t
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	kv.files = listOf(changedPart);
	kv.inScope = listOf(inScopePart);
	kv.peers = listOf(peerPart);
	kv.companions = listOf(companionPart);
	return kv;
};
const IDENTICAL = "(identical to changed-files)";

const repo = mkdtempSync(join(tmpdir(), "review-range-"));
try {
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t.test");
	git(repo, "config", "user.name", "t");
	git(repo, "config", "commit.gpgsign", "false");

	const c1 = commit(repo, "a.txt", "C1 root");
	const c2 = commit(repo, "b.txt", "C2");
	const c3 = commit(repo, "c.txt", "C3");
	const c4 = commit(repo, "d.txt", "C4");
	// Side branch off the root — NOT an ancestor/descendant of C3.
	git(repo, "checkout", "-q", "-b", "side", c1);
	const x1 = commit(repo, "x.txt", "X1 side");
	// Feature branch off C2, two commits; stays checked out for the auto tests.
	git(repo, "checkout", "-q", "-b", "feat", c2);
	commit(repo, "f1.txt", "F1 feat");
	const f2 = commit(repo, "f2.txt", "F2 feat");

	// ── auto / empty / branch-name: first-parent from merge-base(main, HEAD) ──
	{
		for (const scope of ["auto", "", "feat"]) {
			const r = run(repo, scope);
			assert.equal(r.strategy, "first-parent", `scope "${scope}" is first-parent`);
			assert.equal(r.base, c2, `scope "${scope}" base = merge-base (C2)`);
			assert.equal(r.tip, f2, `scope "${scope}" tip = F2`);
			assert.equal(r.fp_flag, "--first-parent", `scope "${scope}" carries the fp flag`);
			assert.ok(r.files.includes("f1.txt") && r.files.includes("f2.txt"), `scope "${scope}" lists both feature files`);
			assert.ok(!r.files.includes("b.txt"), `scope "${scope}" excludes the merge-base commit's own files`);
		}
		assert.ok(run(repo, "auto").patch_path.includes("code-review-patch.diff"), "patch_path is emitted");
		console.log("OK — auto/empty/branch resolve first-parent from the merge-base.");
	}

	// ── commit list: BASE = parent of the oldest NAMED commit (regression pin) ──
	{
		for (const scope of [`${c2},${c3}`, `${c2} ${c3}`]) {
			const r = run(repo, scope);
			assert.equal(r.strategy, "first-parent", "commit list is first-parent");
			assert.equal(r.base, c1, "base = C2^ (parent of the oldest NAMED commit)");
			assert.equal(r.range, `${c1}..${c3}`, "range spans parent-of-oldest..newest");
			assert.ok(r.files.includes("b.txt"), "the OLDEST named commit's own changes are IN scope (the bug)");
			assert.ok(r.files.includes("c.txt"), "the newest named commit's changes are in scope");
			assert.ok(!r.files.includes("d.txt"), "commits after the newest named stay out of scope");
			assert.deepEqual(r.inScope, [IDENTICAL], "named commits' own diffs == changed set → identity marker");
		}
		console.log("OK — commit list includes the oldest named commit's changes (comma + whitespace forms).");
	}

	// ── commit-list refusals: every degrade is a DISTINCT note, never a silent narrow ──
	{
		const root = run(repo, `${c1},${c3}`);
		assert.equal(root.strategy, "unrecognised", "root-commit list refuses");
		assert.match(root.note, /root commit/, "root-commit note names the reason");

		const bad = run(repo, `${c2},deadbeef`);
		assert.equal(bad.strategy, "unrecognised", "unresolvable entry refuses the WHOLE list");
		assert.match(bad.note, /unresolvable entry: deadbeef/, "note names the bad entry");

		const forked = run(repo, `${c3},${x1}`);
		assert.equal(forked.strategy, "unrecognised", "cross-branch list refuses");
		assert.match(forked.note, /linear ancestry/, "non-linear note");

		const dup = run(repo, `${c2},${c2}`);
		assert.equal(dup.strategy, "unrecognised", "duplicate-only list refuses");
		assert.match(dup.note, /under-specified/, "under-specified note");

		const prose = run(repo, "please review my changes");
		assert.equal(prose.strategy, "unrecognised", "prose refuses");
		assert.match(prose.note, /unresolvable entr/, "prose lands on the unresolvable-entries note");
		console.log("OK — commit-list refusals (root / unresolvable / non-linear / duplicate / prose).");
	}

	// ── explicit range + single hash: BASE = OLDEST^ so OLDEST stays included ──
	{
		for (const scope of [`${c2}..${c4}`, `${c4}..${c2}`]) {
			const r = run(repo, scope);
			assert.equal(r.strategy, "explicit-range", `"${scope}" is explicit-range`);
			assert.equal(r.range, `${c1}..${c4}`, `"${scope}" range = OLDEST^..newest (reversed input swapped)`);
			assert.equal(r.fp_flag, "(empty)", "explicit range carries no fp flag");
			for (const f of ["b.txt", "c.txt", "d.txt"]) assert.ok(r.files.includes(f), `"${scope}" includes ${f}`);
		}
		const single = run(repo, c3);
		assert.equal(single.strategy, "explicit-range", "single hash is explicit-range");
		assert.equal(single.range, `${c2}..${c3}`, "single-hash range = hash^..hash");
		assert.deepEqual(single.files, ["c.txt"], "single hash lists exactly its own files");
		console.log("OK — explicit range and single hash include OLDEST's own changes.");
	}

	// ── working-tree strategies + manifest/lockstep flags ──
	{
		git(repo, "checkout", "-q", "main");
		const head = run(repo, "commit");
		assert.equal(head.strategy, "working-tree", "commit is working-tree");
		assert.deepEqual(head.files, ["d.txt"], "commit lists HEAD's files");
		assert.deepEqual(head.inScope, [IDENTICAL], "working-tree in-scope = changed by definition");

		appendFileSync(join(repo, "a.txt"), "edit\n");
		const working = run(repo, "working");
		assert.deepEqual(working.files, ["a.txt"], "working lists the unstaged edit");
		assert.equal(working.manifest_changed, "no", "a.txt is not a manifest");
		assert.equal(working.lockstep_self_review, "no", "no sync-versions.js → no lockstep");
		assert.deepEqual(run(repo, "staged").files, [], "staged is empty before git add");
		git(repo, "add", "a.txt");
		assert.deepEqual(run(repo, "staged").files, ["a.txt"], "staged lists the staged edit");
		assert.deepEqual(run(repo, "working").files, [], "working is empty once fully staged");
		assert.deepEqual(run(repo, "modified").files, ["a.txt"], "modified lists staged+unstaged vs HEAD");
		git(repo, "reset", "-q", "--hard");

		commit(repo, "package.json", '{"name":"t","version":"1.0.0"}');
		appendFileSync(join(repo, "package.json"), "\n");
		const manifest = run(repo, "working");
		assert.equal(manifest.manifest_changed, "yes", "touched package.json flips the gate");
		assert.equal(manifest.manifest_files, "package.json", "manifest file named");
		git(repo, "reset", "-q", "--hard");
		console.log("OK — working-tree strategies + manifest gate (commit / staged / working / modified).");
	}

	// ── InScopeFiles: back-merge inflation drops sidecar files ──
	{
		git(repo, "checkout", "-q", "feat");
		git(repo, "merge", "-q", "main", "-m", "back-merge main");
		commit(repo, "f3.txt", "F3 after back-merge");
		const r = run(repo, "auto");
		assert.equal(r.strategy, "first-parent", "back-merged feature branch still first-parent");
		for (const f of ["c.txt", "d.txt", "package.json"]) {
			assert.ok(r.files.includes(f), `ChangedFiles inflated by the back-merge sidecar ${f}`);
		}
		assert.deepEqual([...r.inScope].sort(), ["f1.txt", "f2.txt", "f3.txt"],
			"InScopeFiles = the feature commits' OWN diffs — sidecars dropped");
		console.log("OK — in-scope-files drops back-merge sidecars (InScopeFiles ⊊ ChangedFiles).");
	}

	// ── PeerPairs: added file paired with an existing suffix peer at HEAD ──
	{
		git(repo, "checkout", "-q", "main");
		commit(repo, "OrderService.ts", "peer service");
		commit(repo, "OrderService.test.ts", "peer test");
		const added = commit(repo, "PaymentService.ts", "new service");
		const r = run(repo, added);
		assert.deepEqual(r.peers, ["PaymentService.ts\tOrderService.ts\tsuffix:Service"],
			"added file pairs with the suffix peer; the peer's TEST file is never a peer");
		assert.deepEqual(run(repo, "commit").peers, r.peers, "working-tree `commit` scope finds the same pair");
		const noAdds = run(repo, `${c2},${c3}`);
		assert.deepEqual(noAdds.peers, [], "modified-only scopes emit no pairs");
		console.log("OK — peer-pairs (suffix heuristic, test exclusion, added-only gate).");
	}

	// ── Companion candidates: co-change history flags the missing usual partner ──
	{
		for (let i = 0; i < 3; i += 1) {
			writeFileSync(join(repo, "pair-a.txt"), `a${i}\n`);
			writeFileSync(join(repo, "pair-b.txt"), `b${i}\n`);
			git(repo, "add", ".");
			git(repo, "commit", "-q", "-m", `pair change ${i}`);
		}
		appendFileSync(join(repo, "pair-a.txt"), "solo edit\n");
		const r = run(repo, "working");
		assert.deepEqual(r.companions, ["pair-b.txt\tdriver=pair-a.txt\tsupport=3\tconf=1.00"],
			"the historical partner absent from the diff is flagged as a companion candidate");
		git(repo, "reset", "-q", "--hard");
		appendFileSync(join(repo, "d.txt"), "unrelated edit\n");
		assert.deepEqual(run(repo, "working").companions, [], "no co-change history → no companions");
		git(repo, "reset", "-q", "--hard");
		console.log("OK — companion-candidates (co-change support/conf, absent-partner detection).");
	}
} finally {
	rmSync(repo, { recursive: true, force: true });
}

console.log("OK");
