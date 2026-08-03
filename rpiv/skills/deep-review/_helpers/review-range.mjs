// review-range.mjs — scope resolution helper for the code-review skill.
//
// LLM-invoked (not render-time substituted). The LLM derives the scope spec
// from `$ARGUMENTS` (or `ask_user_question` clarification) and runs:
//
//   node "${CLAUDE_PLUGIN_ROOT}/skills/deep-review/_helpers/review-range.mjs" "<scope-spec>"
//
// Accepted <scope-spec> values:
//   auto                — empty-scope-default: feature branch vs default branch, first-parent
//   commit              — review the most recent commit (working-tree-style, HEAD)
//   staged              — files staged for commit (git diff --cached)
//   working             — files with unstaged changes only (git diff)
//   modified            — every tracked file differing from HEAD (git diff HEAD; staged + unstaged, no untracked)
//   <hash>              — single commit (~7+ hex chars)
//   <A>..<B>            — range; A is verified ancestor of B, swapped if reversed
//   <h1>,<h2>,<h3>      — comma- or whitespace-separated commit list; helper finds endpoints
//   <branch-name>       — assumed PR branch checked out at HEAD
//
// Output (labeled key/value lines, then `---changed-files---` block):
//
//   default_branch: <name>|(unresolved)
//   strategy:       first-parent|working-tree|explicit-range|unrecognised
//   oldest:         <hash>|(n/a)
//   newest:         <hash>|(n/a)
//   base:           <hash>|(n/a)
//   tip:            <hash>|(n/a)
//   range:          <base>..<tip>|(n/a)
//   fp_flag:        --first-parent|(empty)
//   patch_path:     <gitdir>/code-review-patch.diff   (worktree-safe diff tempfile for the orchestrator's `> <patch_path>` redirect)
//   manifest_changed: yes|no          (any changed file is a dependency manifest/lockfile)
//   manifest_files: <comma list>      (only when manifest_changed: yes)
//   lockstep_self_review: yes|no      (sync-versions.js + uniform packages/*/package.json version + diff touches one)
//   note:           <reason>          (only when strategy=unrecognised)
//   ---changed-files---
//   <deduplicated file list, capped at 2000 entries OR 40 KB whichever first>
//   ---in-scope-files---
//   (identical to changed-files)   — explicit-range / working-tree strategies
//   <file list>                    — first-parent: union of the feature commits' OWN
//                                    diffs (back-merge sidecars drop out); commit-list
//                                    input iterates the user-named hashes instead
//   ---peer-pairs---
//   new_file \t peer_file \t heuristic   — files ADDED by the diff paired with an
//                                    existing peer at HEAD (interface-impl | suffix |
//                                    stem); empty block when no pair matches
//   ---companion-candidates---
//   file \t driver=<changed file> \t support=N \t conf=R — files that historically
//                                    change together with a changed file (recent-history
//                                    co-occurrence) but are ABSENT from this diff: the
//                                    classic "you usually also update X" reviewer assist.
//                                    CANDIDATES for the Quality lens to check, never
//                                    findings. Commits inside the review range cannot
//                                    contribute (their files are all in ChangedFiles).
//
// ChangedFiles cap: 2000 lines OR 40 KB. Footer `(... N more files truncated ...)`
// when hit. Per R-1, helper output is sized for the Pi-bash-tool consumer; this
// helper is LLM-invoked so the 50 KB rpiv-args tail-truncation budget does not
// apply, but the cap keeps output manageable in context.
//
// Load-bearing comments preserved from the original code-review skill:
//   - For first-parent strategies (empty/PR-branch), OLDEST is ALREADY the
//     parent-of-first-feature-commit (computed via git merge-base), so BASE=OLDEST.
//     Do NOT compute BASE=OLDEST^ — that would skip a commit.
//   - For explicit-range strategies (single hash, A..B), BASE=OLDEST^ to include
//     OLDEST's own changes (standard `A..B` excludes A).
//   - For commit-list input, BASE = parent of the OLDEST NAMED commit — the named
//     commits ARE the review set, and `A..B` excludes A, so passing the oldest
//     named commit itself as BASE silently drops its changes.
//   - --first-parent is orthogonal to --no-merges: the former prunes second-parent
//     subtrees from reachability; the latter drops merge commits themselves from
//     the log. Both flags are independently controllable in the consumer's git log.
//   - Always exit 0 (R-8) — unrecognised scope returns strategy=unrecognised with
//     `note:` so the LLM can ask the user via ask_user_question rather than fail.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isTest } from "../../_shared/source-vocab.mjs";

const CHANGED_FILES_LINE_CAP = 2000;
const CHANGED_FILES_BYTE_CAP = 40 * 1024;
const PEER_CAP_PER_FILE = 2; // each pair costs the peer-comparator two full file reads
const COMPANION_WINDOW = 300; // recent commits mined for co-change
const COMPANION_MIN_SUPPORT = 3; // companion must ride along in at least this many commits
const COMPANION_MIN_CONF = 0.4; // ...and in >= this share of its best driver's commits
const COMPANION_BULK_CAP = 30; // commits touching more files are bulk moves — poison co-change
const COMPANION_ROW_CAP = 10;

const safe = (args, fb = "") => {
	try {
		return execFileSync("git", args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024, // ls-tree/log on big repos exceed the 1 MiB default, which would silently return ""
		}).trim();
	} catch {
		return fb;
	}
};

const isAncestor = (a, b) => {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", a, b], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
};

const refExists = (ref) => {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
};

const resolveDefaultBranch = () => {
	const head = safe(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (head) return head.replace(/^origin\//, "");
	if (refExists("main")) return "main";
	if (refExists("master")) return "master";
	return "(unresolved)";
};

const stripOuterQuotes = (s) =>
	s
		.replace(/^['"]/, "")
		.replace(/['"]$/, "")
		.trim();

const dedupChangedFiles = (raw) => {
	const seen = new Set();
	const lines = raw.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed) seen.add(trimmed);
	}
	return [...seen];
};

const formatChangedFiles = (files) => {
	let out = "";
	let count = 0;
	for (const f of files) {
		const next = `${f}\n`;
		if (out.length + next.length > CHANGED_FILES_BYTE_CAP) break;
		if (count >= CHANGED_FILES_LINE_CAP) break;
		out += next;
		count += 1;
	}
	if (count < files.length) {
		out += `(... ${files.length - count} more files truncated ...)\n`;
	}
	return out;
};

const result = {
	default_branch: resolveDefaultBranch(),
	strategy: "unrecognised",
	oldest: "(n/a)",
	newest: "(n/a)",
	base: "(n/a)",
	tip: "(n/a)",
	range: "(n/a)",
	fp_flag: "(empty)",
	patch_path: safe(["rev-parse", "--git-path", "code-review-patch.diff"]) || ".git/code-review-patch.diff",
	note: "",
	changedFiles: "",
};

const argv = process.argv[2] ?? "";
const scope = stripOuterQuotes(argv);
const lower = scope.toLowerCase();
const defaultBranch = result.default_branch;
let commitListHashes = null; // user-named commit list — InScopeFiles iterates these, not the first-parent walk

const setFirstParent = (oldest, newest) => {
	result.strategy = "first-parent";
	result.oldest = oldest;
	result.newest = newest;
	result.base = oldest;
	result.tip = newest;
	result.range = `${oldest}..${newest}`;
	result.fp_flag = "--first-parent";
};

const setExplicitRange = (oldest, newest) => {
	result.strategy = "explicit-range";
	result.oldest = oldest;
	result.newest = newest;
	const parent = safe(["rev-parse", `${oldest}^`]);
	result.base = parent || oldest;
	result.tip = newest;
	result.range = `${result.base}..${newest}`;
	result.fp_flag = "(empty)";
};

const setWorkingTree = (oldest = "(n/a)", newest = "(n/a)") => {
	result.strategy = "working-tree";
	result.oldest = oldest;
	result.newest = newest;
	result.base = "(n/a)";
	result.tip = "(n/a)";
	result.range = "(n/a)";
	result.fp_flag = "(empty)";
};

const isHexHash = (s) => /^[0-9a-f]{4,40}$/i.test(s);

if (defaultBranch === "(unresolved)" && (lower === "" || lower === "auto")) {
	result.strategy = "unrecognised";
	result.note = "default branch unresolved — pass an explicit scope or run `git remote set-head origin -a`";
} else if (lower === "" || lower === "auto") {
	const oldest = safe(["merge-base", defaultBranch, "HEAD"]);
	if (oldest) setFirstParent(oldest, safe(["rev-parse", "HEAD"]));
	else result.note = `merge-base ${defaultBranch}..HEAD failed`;
} else if (lower === "commit") {
	setWorkingTree(safe(["rev-parse", "HEAD"]), safe(["rev-parse", "HEAD"]));
} else if (lower === "staged" || lower === "working" || lower === "modified") {
	setWorkingTree();
} else if (scope.includes("..") && !scope.includes("...")) {
	const [a, b] = scope.split("..");
	if (refExists(a) && refExists(b)) {
		const aHash = safe(["rev-parse", a]);
		const bHash = safe(["rev-parse", b]);
		if (isAncestor(aHash, bHash)) setExplicitRange(aHash, bHash);
		else if (isAncestor(bHash, aHash)) setExplicitRange(bHash, aHash);
		else result.note = `neither ${a} nor ${b} is an ancestor of the other`;
	} else {
		result.note = `range endpoint(s) do not resolve: ${a}..${b}`;
	}
} else if (/[,\s]/.test(scope)) {
	const entries = scope.split(/[,\s]+/).filter(Boolean);
	const resolvedPairs = entries.map((h) => [h, safe(["rev-parse", "--verify", `${h}^{commit}`])]);
	const bad = resolvedPairs.filter(([, r]) => !r).map(([h]) => h);
	const unique = [...new Set(resolvedPairs.map(([, r]) => r).filter(Boolean))];
	if (bad.length > 0) {
		// An unresolvable entry must fail the whole list — dropping it silently
		// narrows the review to fewer commits than the user named.
		result.note = `commit list has unresolvable entr${bad.length === 1 ? "y" : "ies"}: ${bad.join(", ")}`;
	} else if (unique.length < 2) {
		result.note = `commit list under-specified (need ≥2 distinct commits; got ${unique.length})`;
	} else {
		const topo = safe(["rev-list", "--topo-order", ...unique]).split("\n");
		const present = new Set(unique);
		const ordered = topo.filter((h) => present.has(h));
		// rev-list orders any input; prove the named commits sit on ONE ancestry
		// chain (each older entry an ancestor of the next newer) — otherwise
		// `oldest..newest` silently omits the side branches' changes.
		let linear = ordered.length === unique.length;
		for (let i = 0; linear && i < ordered.length - 1; i += 1) {
			if (!isAncestor(ordered[i + 1], ordered[i])) linear = false;
		}
		const oldestNamed = ordered.at(-1);
		const parent = linear ? safe(["rev-parse", `${oldestNamed}^`]) : "";
		if (!linear) {
			result.note = "commit list not on a single linear ancestry";
		} else if (!parent) {
			result.note = `oldest listed commit ${oldestNamed.slice(0, 12)} is a root commit — pass an explicit range instead`;
		} else {
			commitListHashes = [...unique];
			setFirstParent(parent, ordered[0]);
		}
	}
} else if (isHexHash(scope) && refExists(scope)) {
	const hash = safe(["rev-parse", scope]);
	setExplicitRange(hash, hash);
} else if (refExists(scope)) {
	const oldest = safe(["merge-base", defaultBranch, "HEAD"]);
	if (oldest) setFirstParent(oldest, safe(["rev-parse", "HEAD"]));
	else result.note = `merge-base ${defaultBranch}..HEAD failed for branch ${scope}`;
} else {
	result.note = `scope spec not recognised: ${scope}`;
}

// ChangedFiles + added files per strategy (arrays; the formatted block is derived).
let changedList = [];
let addedRaw = "";
if (result.strategy === "first-parent") {
	changedList = dedupChangedFiles(safe(["log", result.range, "--first-parent", "--name-only", "--pretty=format:"]));
	addedRaw = safe(["log", result.range, "--first-parent", "--no-merges", "--diff-filter=A", "--name-only", "--pretty=format:"]);
} else if (result.strategy === "explicit-range") {
	changedList = dedupChangedFiles(safe(["log", result.range, "--name-only", "--pretty=format:"]));
	addedRaw = safe(["log", result.range, "--no-merges", "--diff-filter=A", "--name-only", "--pretty=format:"]);
} else if (result.strategy === "working-tree") {
	if (lower === "commit") {
		changedList = dedupChangedFiles(safe(["show", "HEAD", "--name-only", "--pretty=format:"]));
		addedRaw = safe(["show", "HEAD", "--diff-filter=A", "--name-only", "--pretty=format:"]);
	} else if (lower === "staged") {
		changedList = dedupChangedFiles(safe(["diff", "--cached", "--name-only"]));
		addedRaw = safe(["diff", "--cached", "--diff-filter=A", "--name-only"]);
	} else if (lower === "modified") {
		// modified: every tracked file that differs from HEAD (staged + unstaged,
		// no untracked). Matches `git diff HEAD` semantics — what would be
		// committed by `git add -u && git commit`.
		changedList = dedupChangedFiles(safe(["diff", "HEAD", "--name-only"]));
		addedRaw = safe(["diff", "HEAD", "--diff-filter=A", "--name-only"]);
	} else {
		// working: unstaged only (matches git's "working tree" definition and
		// the skill's `git diff -U30` patch command — both exclude staged).
		changedList = dedupChangedFiles(safe(["diff", "--name-only"]));
		addedRaw = safe(["diff", "--diff-filter=A", "--name-only"]);
	}
}
result.changedFiles = formatChangedFiles(changedList);

// ---- InScopeFiles (DR Step 1.5, absorbed) -----------------------------------------
// first-parent: the union of the feature commits' OWN diffs — ChangedFiles reflects
// tree-reachability and is inflated on back-merged branches; InScopeFiles is what the
// developer actually authored, and the Step-6 pre-filter drops sidecar findings by it.
// Commit-list input iterates the user-named hashes (non-contiguous-list intent).
// explicit-range / working-tree: identical to ChangedFiles by definition.
let inScopeList = null; // null => identical to changed-files
if (result.strategy === "first-parent") {
	const hashes =
		commitListHashes ??
		safe(["log", result.range, "--first-parent", "--no-merges", "--pretty=%H"]).split("\n").filter(Boolean);
	const set = new Set();
	for (const h of hashes) {
		for (const f of safe(["diff-tree", "--no-commit-id", "--name-only", "-r", h]).split("\n")) {
			const t = f.trim();
			if (t) set.add(t);
		}
	}
	inScopeList = [...set];
	const changedSet = new Set(changedList);
	if (inScopeList.length === changedList.length && inScopeList.every((f) => changedSet.has(f))) {
		inScopeList = null; // no back-merge inflation — collapse to the identity marker
	}
}

// ---- ManifestChanged (DR Step 1.5, absorbed) --------------------------------------
const MANIFEST_RE =
	/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.(json|jsonc|lock)|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|pipfile(\.lock)?|setup\.(py|cfg)|gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|mix\.(exs|lock)|[^/]+\.csproj|packages\.config|paket\.(dependencies|lock))$/i;
const manifestFiles = changedList.filter((f) => MANIFEST_RE.test(f));

// ---- LockstepSelfReview (DR Step 1.5, absorbed) -----------------------------------
const lockstep = (() => {
	const top = safe(["rev-parse", "--show-toplevel"]);
	if (!top || !existsSync(join(top, "scripts/sync-versions.js"))) return false;
	if (!changedList.some((f) => /^packages\/[^/]+\/package\.json$/.test(f))) return false;
	const pkgs = safe(["ls-files", "packages/*/package.json"]).split("\n").filter(Boolean);
	if (pkgs.length < 2) return false;
	const versions = new Set();
	for (const p of pkgs) {
		try {
			versions.add(JSON.parse(readFileSync(join(top, p), "utf-8")).version ?? "(none)");
		} catch {
			return false; // an unparseable member package.json disqualifies lockstep
		}
	}
	return versions.size === 1;
})();

// ---- PeerPairs (DR Step 1.5, absorbed) --------------------------------------------
// Pair each file ADDED by the diff with an existing peer at HEAD. Heuristics, in
// priority order: interface-impl (I<Name>/<Name>.impl/<Name>{Abstract,Base,Protocol}),
// shared suffix from the peer-noun vocabulary, stem similarity (longest common
// substring / SHORTER stem >= 0.6, shorter stem >= 4 chars — the shorter-stem
// denominator is what makes PhysicalProductSubscription <-> Subscription pair, per
// the skill's canonical example). Tests are never peers; capped per new file.
const PEER_SUFFIXES = [
	"Handler", "Service", "Repository", "Aggregate", "Reducer", "Controller", "Resolver",
	"Command", "Query", "Job", "Processor", "Strategy", "Policy", "Event", "Listener",
	"Subscriber", "Publisher", "Exception", "Eligibility", "Ability", "QueryParam",
	"Specification", "Factory", "Builder",
];
const stemOf = (p) => {
	const b = p.slice(p.lastIndexOf("/") + 1);
	const dot = b.lastIndexOf(".");
	return dot <= 0 ? b : b.slice(0, dot);
};
const lcsLen = (a, b) => {
	// longest common substring, O(len(a)*len(b)) — stems are short
	let best = 0;
	let prev = new Array(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i += 1) {
		const cur = new Array(b.length + 1).fill(0);
		for (let j = 1; j <= b.length; j += 1) {
			if (a[i - 1] === b[j - 1]) {
				cur[j] = prev[j - 1] + 1;
				if (cur[j] > best) best = cur[j];
			}
		}
		prev = cur;
	}
	return best;
};
const suffixOf = (stem) => PEER_SUFFIXES.find((s) => stem.endsWith(s) && stem !== s) ?? null;
const interfaceImpl = (a, b) =>
	(a.startsWith("I") && /^[A-Z]/.test(a.slice(1)) && a.slice(1) === b) ||
	(b.startsWith("I") && /^[A-Z]/.test(b.slice(1)) && b.slice(1) === a) ||
	a === `${b}.impl` || b === `${a}.impl` ||
	["Abstract", "Base", "Protocol"].some((suf) => a === `${b}${suf}` || b === `${a}${suf}`);
const peerPairs = [];
if (addedRaw && result.strategy !== "unrecognised") {
	const added = dedupChangedFiles(addedRaw).filter((f) => !isTest(f));
	const headFiles = added.length > 0 ? safe(["ls-tree", "-r", "HEAD", "--name-only"]).split("\n").filter(Boolean) : [];
	const addedSet = new Set(dedupChangedFiles(addedRaw));
	for (const nf of added) {
		const ns = stemOf(nf);
		const candidates = [];
		for (const pf of headFiles) {
			if (pf === nf || addedSet.has(pf) || isTest(pf)) continue;
			const ps = stemOf(pf);
			if (interfaceImpl(ns, ps)) {
				candidates.push({ pf, heuristic: "interface-impl", rank: 0 });
				continue;
			}
			const nSuf = suffixOf(ns);
			if (nSuf && nSuf === suffixOf(ps) && ns !== ps) {
				candidates.push({ pf, heuristic: `suffix:${nSuf}`, rank: 1 });
				continue;
			}
			const a = ns.toLowerCase();
			const b = ps.toLowerCase();
			const shorter = Math.min(a.length, b.length);
			if (shorter >= 4 && lcsLen(a, b) / shorter >= 0.6) {
				candidates.push({ pf, heuristic: "stem", rank: 2 });
			}
		}
		candidates.sort((x, y) => x.rank - y.rank || x.pf.localeCompare(y.pf));
		for (const c of candidates.slice(0, PEER_CAP_PER_FILE)) {
			peerPairs.push(`${nf}\t${c.pf}\t${c.heuristic}`);
		}
	}
}

// ---- Companion candidates (DR "you usually also update X", absorbed) --------------
// Mine recent history for files that co-change with the diff's files but are absent
// from it. conf = P(companion | its strongest driver) over the window; bulk commits
// are skipped (a 50-file rename would make everything a companion of everything).
const companions = [];
if (changedList.length > 0 && result.strategy !== "unrecognised") {
	const raw = safe(["log", "--no-merges", `-n${COMPANION_WINDOW}`, "--name-only", "--pretty=format:%H"]);
	const commits = [];
	let cur = null;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (/^[0-9a-f]{40}$/.test(t)) {
			cur = [];
			commits.push(cur);
		} else if (t && cur) cur.push(t);
	}
	const changedSet = new Set(changedList);
	const headSet = new Set(safe(["ls-tree", "-r", "HEAD", "--name-only"]).split("\n").filter(Boolean));
	const driverAppearances = new Map();
	const co = new Map();
	for (const files of commits) {
		if (files.length === 0 || files.length > COMPANION_BULK_CAP) continue;
		const touched = files.filter((f) => changedSet.has(f));
		if (touched.length === 0) continue;
		for (const t of touched) driverAppearances.set(t, (driverAppearances.get(t) ?? 0) + 1);
		for (const f of files) {
			if (changedSet.has(f) || !headSet.has(f)) continue;
			if (!co.has(f)) co.set(f, { support: 0, drivers: new Map() });
			const e = co.get(f);
			e.support += 1;
			for (const t of touched) e.drivers.set(t, (e.drivers.get(t) ?? 0) + 1);
		}
	}
	const rows = [];
	for (const [f, e] of co) {
		let driver = null;
		let conf = 0;
		for (const [d, n] of e.drivers) {
			const c = n / (driverAppearances.get(d) ?? 1);
			if (c > conf || (c === conf && (driver === null || d < driver))) {
				conf = c;
				driver = d;
			}
		}
		if (e.support >= COMPANION_MIN_SUPPORT && conf >= COMPANION_MIN_CONF) {
			rows.push({ f, support: e.support, conf, driver });
		}
	}
	rows.sort((a, b) => b.conf - a.conf || b.support - a.support || a.f.localeCompare(b.f));
	for (const r of rows.slice(0, COMPANION_ROW_CAP)) {
		companions.push(`${r.f}\tdriver=${r.driver}\tsupport=${r.support}\tconf=${r.conf.toFixed(2)}`);
	}
}

const lines = [
	`default_branch: ${result.default_branch}`,
	`strategy:       ${result.strategy}`,
	`oldest:         ${result.oldest}`,
	`newest:         ${result.newest}`,
	`base:           ${result.base}`,
	`tip:            ${result.tip}`,
	`range:          ${result.range}`,
	`fp_flag:        ${result.fp_flag}`,
	`patch_path:     ${result.patch_path}`,
	`manifest_changed: ${manifestFiles.length > 0 ? "yes" : "no"}`,
];
if (manifestFiles.length > 0) lines.push(`manifest_files: ${manifestFiles.join(", ")}`);
lines.push(`lockstep_self_review: ${lockstep ? "yes" : "no"}`);
if (result.strategy === "unrecognised" && result.note) {
	lines.push(`note:           ${result.note}`);
}
lines.push("---changed-files---");
const tail = [
	"---in-scope-files---",
	inScopeList === null ? "(identical to changed-files)\n" : formatChangedFiles(inScopeList),
	"---peer-pairs---",
	peerPairs.length > 0 ? `${peerPairs.join("\n")}\n` : "",
	"---companion-candidates---",
	companions.length > 0 ? `${companions.join("\n")}\n` : "",
];
process.stdout.write(`${lines.join("\n")}\n${result.changedFiles}${tail.join("\n")}`);
