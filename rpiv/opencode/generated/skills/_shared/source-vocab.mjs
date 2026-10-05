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
// migrations, CI config, container files, env files and sensitive path words —
// so the lane classifier and review-range read one list instead of copies.
//
// Importable-only: no CLI, no isMain.
// Importable: SOURCE_EXT, CITE_EXT, extOf, isSource, isTest, isFixture, TEST_EXCLUDE_RE,
// isManifest, isLockfile, isMigration, isCiConfig, isContainerFile, isEnvFile,
// sensitiveWords, isGenerated, isMedia.

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
// (23 alternatives) and its strict subset MANIFEST_BASENAME_RE — no novelties.
const MANIFEST_NAME_RE =
	/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.(json|jsonc|lock)|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|pipfile(\.lock)?|setup\.(py|cfg)|gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|mix\.(exs|lock)|[^/]+\.csproj|packages\.config|paket\.(dependencies|lock))$/i;
// The lockfile subset of that union.
const LOCKFILE_NAME_RE =
	/^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|cargo\.lock|go\.sum|poetry\.lock|pipfile\.lock|gemfile\.lock|composer\.lock|mix\.lock|paket\.lock)$/i;

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

// `.env`, `.env.<x>`, `<x>.env` — except the placeholder templates (developer
// choice, D15).
const ENV_NAME_RE = /^(\.env(\..+)?|.+\.env)$/i;
const ENV_TEMPLATE_RE = /^\.env(\..+)?\.(example|sample|template)$/i;
/** A real environment file (templates excluded). */
export const isEnvFile = (p) => {
	const base = baseOf(p);
	return ENV_NAME_RE.test(base) && !ENV_TEMPLATE_RE.test(base);
};
// Sensitive path words (FR3 + developer additions, D15) and the other spellings
// each one covers. A token matches a word or form exactly, or its plural (+s/+es)
// — never a prefix: `author`, `tokenizer`, `schemaless`, `secretary` stay out.
const SENSITIVE_FORMS = {
	auth: [
		"authn", "authz", "authentication", "authorization", "authenticate", "authorize", "oauth",
		"authenticated", "authenticator", "authorized", "authorizer",
	],
	security: ["secure", "secured"],
	crypto: [
		"crypt", "cryptography", "cryptographic", "encrypt", "encryption", "encrypted",
		"decrypt", "decryption", "decrypted",
	],
	secret: [],
	credential: ["creds"],
	permission: ["perm", "perms"],
	token: [],
	payment: [],
	migration: ["migrate", "migrated", "migrator"],
	schema: [],
	ipc: [],
	preload: [],
	password: ["passwd"],
	session: [],
	jwt: [],
	cert: ["certificate"],
	ssh: [],
};

// token -> the sensitive word it names.
const SENSITIVE_TOKENS = new Map(
	Object.entries(SENSITIVE_FORMS).flatMap(([word, forms]) =>
		[word, ...forms].flatMap((form) =>
			[form, `${form}s`, `${form}es`].map((token) => [token, word]),
		),
	),
);

/** Lower-cased words of a path: split at separators and camelCase boundaries
    (`authService` → auth, service; `JWTToken` → jwt, token; `parseJWTs` → parse,
    jwts — an acronym keeps its plural `s`). */
const pathTokens = (p) =>
	(p.match(/[A-Z]+s(?![a-z])|[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((t) =>
		t.toLowerCase(),
	);

/** The sensitive words a path names, sorted and de-duplicated. */
export const sensitiveWords = (p) =>
	[...new Set(pathTokens(p).map((t) => SENSITIVE_TOKENS.get(t)).filter(Boolean))].sort();

// Generated/vendored paths and media files (D17 of the risk-lanes design, S5):
// review-range.mjs's former GENERATED_PATH_RE and MEDIA_EXT, moved unchanged so
// review-range and the lane CLI drop the same files. metrics.mjs keeps its own,
// different "generated" rule (D15 note).
const GENERATED_PATH_RE =
	/(^|\/)(\.rpiv\/artifacts|opencode\/generated|coverage|dist|build|node_modules)(\/|$)/i;
const MEDIA_EXT = new Set([
	"avif", "bmp", "gif", "ico", "jpeg", "jpg", "mov", "mp3",
	"mp4", "pdf", "png", "svg", "webm", "webp", "woff", "woff2",
]);
/** A generated or vendored path (build output, coverage, dependencies, artifacts). */
export const isGenerated = (p) => GENERATED_PATH_RE.test(p);
/** A media file (image, video, audio, font, PDF). */
export const isMedia = (p) => MEDIA_EXT.has(extOf(p));
