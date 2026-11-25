// source-vocab.mjs — the single owner of the language/file vocabulary shared across
// BOTH skills' helpers (shared-vocab-union): which extensions count as reviewable
// source, which extensions a citation can point at, and which paths are tests.
//
// Extracted when two copies were found with OPPOSITE language postures: the AR
// helpers' source set spans ten non-JS languages (source-set.mjs) while the
// citation grammar's extension whitelist was JS/web-only — so on a Python/Go
// target the prose-cite ambiguity gates silently no-oped. The values here are the
// UNION of the prior copies; `skills/architectural-review/_helpers/source-set.mjs`
// re-exports them so its consumers (metrics, mutation, semantic, layer-rules)
// keep their import path.
//
// It also owns the RISK vocabulary (D15 of the risk-lanes design, S3): dependency
// manifests and lockfiles (the union of review-range.mjs's two former regexes),
// migrations, CI config, container files and env files —
// so the lane classifier and review-range read one list instead of copies.
//
// Importable-only: no CLI, no isMain.
// Importable: SOURCE_EXT, CITE_EXT, extOf, isSource, isTest, isFixture, isTestTree,
// isPythonTest, isTestData, isPythonTestSupport, TEST_EXCLUDE_RE,
// isManifest, isLockfile, isMigration, isCiConfig, isContainerFile, LANE_CONFIG_FILE,
// isLaneConfig, isEnvFile, isGenerated, isMedia, isToolHome, COSMIC_SESSIONS.

/** Extensions that count as reviewable source code (metrics, mutation, semantic). */
export const SOURCE_EXT = new Set([
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
	"py", "go", "rs", "java", "kt", "cs", "rb", "php", "swift", "scala",
]);

/**
 * Extensions a `file.ext:line` citation can point at: every source extension PLUS
 * the non-code citation targets the old citation-grammar whitelist carried
 * (SQL, styles, config, docs). Strict union of the two prior copies — no novelties.
 */
export const CITE_EXT = new Set([
	...SOURCE_EXT,
	"sql", "css", "scss", "json", "yaml", "yml", "toml", "md",
]);

/** Lower-cased extension of a path ("" when none). */
export const extOf = (p) => {
	const b = p.slice(p.lastIndexOf("/") + 1);
	const dot = b.lastIndexOf(".");
	return dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
};

/** True if the path's extension is a reviewable source extension. */
export const isSource = (p) => SOURCE_EXT.has(extOf(p));

/**
 * True if the path is a test file by ANY supported language's convention — not just
 * the JS/TS `.test./.spec./__tests__` idioms. The per-language FILE patterns are
 * unambiguous; generic `test/`/`tests/`/`spec/` DIRECTORY matching is deliberately
 * NOT included (a JS repo's `test/` utilities dir would silently reclassify and move
 * every metrics baseline) — `src/test/` is the one directory convention included
 * because it is the Maven/Gradle standard and collides with nothing.
 */
export const isTest = (p) =>
	/\.(test|spec)\.[a-z]+$/i.test(p) || // JS/TS: foo.test.ts, foo.spec.js
	/(^|\/)__tests__\//.test(p) || // JS/TS: __tests__ trees
	/_tests?\.(go|py|rb|ex|exs)$/i.test(p) || // Go/Python/Ruby/Elixir: foo_test.go, foo_test.py
	/(^|\/)test_[^/]*\.py$/i.test(p) || // Python: test_foo.py
	/Tests?\.(java|kt|kts|cs|scala|swift|php)$/.test(p) || // JVM/C#/Swift/PHP: FooTest.java, FooTests.cs (case-sensitive — else contest.java classifies)
	/_spec\.rb$/i.test(p) || // Ruby: foo_spec.rb
	/(^|\/)src\/test\//.test(p); // Maven/Gradle standard test tree

/**
 * True if the path lives in a conventional test-SUPPORT directory: e2e harnesses,
 * fixture or mock trees. Deliberately separate from isTest — that names files a
 * runner EXECUTES, this names files that exist to FEED tests, where near-identical
 * shapes are the point rather than a defect.
 */
export const isFixture = (p) =>
	/(^|\/)(e2e|fixtures?|__fixtures__|__mocks__|mocks|testing)(\/|$)/i.test(p);

/**
 * True if the path exists FOR tests in any form: isTest, isFixture, a `test/`, `tests/` or
 * `spec/` directory, or a fixture-named file (`users.fixture.ts`, `user-fixtures.ts`).
 * Broader than isTest ON PURPOSE and kept separate from it — the generic test directories
 * isTest deliberately leaves out would move metrics' test-theater counts, mutation
 * eligibility and the depcruise exclude. For classifying duplication: test support
 * copying production code is a test finding, not an architecture one.
 */
export const isTestTree = (p) =>
	isTest(p) ||
	isFixture(p) ||
	/(^|\/)(tests?|specs?)\//i.test(p) ||
	/[._-]fixtures?\.[a-z]+$/i.test(p);

/**
 * True for a `.py` file isTest accepts outside a Maven/Gradle `src/test/` tree, where
 * `.py` files are resources. pytest runs any file it is handed by path, so every `.py`
 * file rpiv calls a test counts: `test_*.py`, `*_test.py`, `*_tests.py`, `x.test.py`,
 * and any `.py` file under `__tests__/`.
 * Narrower than isTest; reprove-red counts a slice's Python runner tests with it.
 */
export const isPythonTest = (p) =>
	isTest(p) && extOf(p) === "py" && !/(^|\/)src\/test\//.test(p);

/**
 * True for a path in a test-DATA folder: `fixtures`, `fixture` or `__fixtures__`.
 * Narrower than isFixture, which also takes `e2e/`, `testing/`, `mocks/` and
 * `__mocks__/` — folders that hold real tests, not data a test reads.
 */
export const isTestData = (p) =>
	/(^|\/)(fixtures?|__fixtures__)(\/|$)/i.test(p);

/**
 * True for a path a Python run's scratch copy takes from the slice (D19 of the
 * Python-support design, S2-scratch-copy): any file named exactly `conftest.py`, any
 * path isTest accepts, and any path isTestTree accepts that has no `src` folder in it.
 * isTestTree's folder rule also matches production packages (`src/demo/test/utils.py`),
 * so inside a `src` folder only tests and `conftest.py` count.
 */
export const isPythonTestSupport = (p) =>
	/(^|\/)conftest\.py$/.test(p) ||
	isTest(p) ||
	(isTestTree(p) && !/(^|\/)src\//.test(p));

// Regex-source STRING for the generated .dependency-cruiser.cjs (layer-rules), kept
// byte-identical to the prior inline literal so the generated CI config is unchanged.
// Narrower than isTest ON PURPOSE: dependency-cruiser only cruises JS/TS, so the
// non-JS conventions above would be dead weight in a generated config.
export const TEST_EXCLUDE_RE = "\\.(test|spec)\\.[a-z]+$|(^|/)__tests__/";

// ---- risk vocabulary (D15, S3) -------------------------------------------------

/** A path with `/` separators, so one rule serves Windows paths too. */
const slashed = (p) => p.replace(/\\/g, "/");

/** The file name of a path ("a/b/C.txt" → "C.txt"). */
const baseOf = (p) => slashed(p).slice(slashed(p).lastIndexOf("/") + 1);

// Dependency manifests and lockfiles: the union of review-range.mjs's MANIFEST_RE
// (23 alternatives) and its strict subset MANIFEST_BASENAME_RE, plus uv's `uv.lock`
// (D15 of the Python-support design, S2-scratch-copy).
const MANIFEST_NAME_RE =
	/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.(json|jsonc|lock)|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|pipfile(\.lock)?|setup\.(py|cfg)|gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|mix\.(exs|lock)|[^/]+\.csproj|packages\.config|paket\.(dependencies|lock))$/i;
// The lockfile subset of that union, `uv.lock` included.
const LOCKFILE_NAME_RE =
	/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|cargo\.lock|go\.sum|poetry\.lock|uv\.lock|pipfile\.lock|gemfile\.lock|composer\.lock|mix\.lock|paket\.lock)$/i;

/** True for a dependency manifest or lockfile, in any directory, any case. */
export const isManifest = (p) => MANIFEST_NAME_RE.test(baseOf(p));
/** True for a dependency lockfile (a subset of isManifest). */
export const isLockfile = (p) => LOCKFILE_NAME_RE.test(baseOf(p));

/** A migration: a `migration(s)` directory or a `.sql` file — the one rule
    review-range.mjs imports. */
export const isMigration = (p) =>
	/(^|\/)migrations?\//i.test(slashed(p)) || extOf(slashed(p)) === "sql";

const CI_PATH_RE =
	/(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/.+|azure-pipelines\.ya?ml|Jenkinsfile|\.travis\.yml|bitbucket-pipelines\.yml|\.buildkite\/.+)$/;
/** A CI pipeline definition. */
export const isCiConfig = (p) => CI_PATH_RE.test(slashed(p));

const CONTAINER_NAME_RE =
	/^(dockerfile(\..+)?|.+\.dockerfile|containerfile|docker-compose[^/]*\.ya?ml|compose(\.[^/]+)?\.ya?ml|\.dockerignore)$/i;
/** A container build or compose file. */
export const isContainerFile = (p) => CONTAINER_NAME_RE.test(baseOf(p));

/** The repo-root file of per-repository lane thresholds (D9, D33). */
export const LANE_CONFIG_FILE = ".rpiv-lanes.json";

/** The Cosmic Ray session files looked for at a project root, in order (D52 of the
    Python-support design, S8-cosmic-ray): read by mutation.mjs, reported by tool-probe. */
export const COSMIC_SESSIONS = ["cosmic-ray.sqlite", "session.sqlite"];
/** The root lane thresholds file itself — never a nested or look-alike name (D33). */
export const isLaneConfig = (p) =>
	slashed(p).replace(/^\.\//, "") === LANE_CONFIG_FILE;

// `.env`, `.env.<x>`, `<x>.env` — except the placeholder templates (developer
// choice, D15).
const ENV_NAME_RE = /^(\.env(\..+)?|.+\.env)$/i;
const ENV_TEMPLATE_RE = /^\.env(\..+)?\.(example|sample|template)$/i;
/** A real environment file (templates excluded). */
export const isEnvFile = (p) => {
	const base = baseOf(p);
	return ENV_NAME_RE.test(base) && !ENV_TEMPLATE_RE.test(base);
};
// Generated/vendored paths and media files (D17 of the risk-lanes design, S5):
// review-range.mjs's former GENERATED_PATH_RE and MEDIA_EXT, so review-range and
// the lane CLI drop the same files. metrics.mjs keeps its own, different
// "generated" rule (D15 note). Target repos add tool-written files: migration
// metadata (`<migrations|drizzle>/meta/`), codegen output (`__generated__/`,
// `*.gen.*`, `*.generated.*`) and minified bundles — reviewing them only produces
// false peers and inflated line counts.
const GENERATED_PATH_RE =
	/(^|\/)(\.rpiv\/artifacts|opencode\/generated|coverage|dist|build|node_modules|__generated__|(migrations?|drizzle)\/meta)(\/|$)/i;
const GENERATED_NAME_RE = /\.(gen|generated|min)\.[a-z0-9]+$/i;
const MEDIA_EXT = new Set([
	"avif", "bmp", "gif", "ico", "jpeg", "jpg", "mov", "mp3",
	"mp4", "pdf", "png", "svg", "webm", "webp", "woff", "woff2",
]);
/** A generated or vendored path (build output, coverage, dependencies, artifacts). */
export const isGenerated = (p) =>
	GENERATED_PATH_RE.test(p) || GENERATED_NAME_RE.test(p);
/** A media file (image, video, audio, font, PDF). */
export const isMedia = (p) => MEDIA_EXT.has(extOf(p));

// The tool's own folder: artifacts, evidence (review rounds, mutant scripts, logs),
// decisions and guidance. Wider than GENERATED_PATH_RE's `.rpiv/artifacts` on
// purpose: evidence is not generated (it stays reviewable), but no file in here is
// product code, even one with a source extension (odin#14).
const TOOL_HOME_RE = /(^|\/)\.rpiv(\/|$)/;
/** A path inside the tool's own `.rpiv/` folder. */
export const isToolHome = (p) => TOOL_HOME_RE.test(slashed(p));
