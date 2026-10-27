// tests/migration-kind.test.mjs — contract tests for skills/_shared/migration-kind.mjs:
// which migration changes are additive (lane normal) and which stay risky (rigorous).

import { describe, expect, it } from "vitest";
import { diffLines, migrationKind } from "../skills/_shared/migration-kind.mjs";

const added = (...lines) => ({ added: lines, deleted: 0 });

describe("migrationKind", () => {
	it("reads additive-only SQL as additive", () => {
		const cases = [
			added("CREATE INDEX idx_users_email ON users (email);"),
			added("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON a (b);"),
			added(
				"CREATE TABLE `bookings` (",
				"\t`id` integer PRIMARY KEY NOT NULL,",
				"\t`user_id` integer REFERENCES users(id)",
				");",
				"--> statement-breakpoint",
				"CREATE INDEX `bookings_user_idx` ON `bookings` (`user_id`);",
			),
			added("ALTER TABLE users ADD COLUMN nickname text;"),
			added("ALTER TABLE `users` ADD `avatar` text; -- shown on profile"),
		];
		for (const change of cases) {
			expect
				.soft(
					migrationKind("db/migrations/0002_x.sql", change),
					change.added.join(" "),
				)
				.toBe("additive");
		}
	});

	it("keeps anything that rewrites, removes or constrains data risky", () => {
		const cases = [
			added("DROP INDEX idx_a;"),
			added("UPDATE users SET role = 'member';"),
			added("CREATE UNIQUE INDEX idx_a ON a (b);"),
			added(
				"ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'member';",
			),
			added("ALTER TABLE users ADD COLUMN code text UNIQUE;"),
			added("ALTER TABLE users ADD CONSTRAINT users_code_key UNIQUE (code);"),
			added("ALTER TABLE users ALTER COLUMN name SET NOT NULL;"),
			added("CREATE INDEX idx_a ON a (b);", "DELETE FROM a;"),
			added("INSERT INTO roles VALUES ('admin');"),
			// Editing an existing migration is never additive.
			{ added: ["CREATE INDEX idx_a ON a (b);"], deleted: 1 },
			// Nothing to judge.
			added(),
			added("-- only a comment"),
		];
		for (const change of cases) {
			expect
				.soft(
					migrationKind("db/migrations/0002_x.sql", change),
					change.added.join(" "),
				)
				.toBe("risky");
		}
	});

	it("keeps a non-SQL migration risky", () => {
		expect(
			migrationKind(
				"db/migrations/0002_x.ts",
				added("CREATE INDEX idx_a ON a (b);"),
			),
		).toBe("risky");
	});
});

describe("diffLines", () => {
	it("reads added and deleted lines from hunks only, never from headers", () => {
		const diff = [
			"diff --git a/m.sql b/m.sql",
			"--- a/m.sql",
			"+++ b/m.sql",
			"@@ -1,0 +1,2 @@",
			"+CREATE INDEX idx_a ON a (b);",
			"+-- a comment",
			"@@ -5 +6,0 @@",
			"--- removed comment",
			"",
		].join("\n");
		expect(diffLines(diff)).toEqual({
			added: ["CREATE INDEX idx_a ON a (b);", "-- a comment"],
			deleted: 1,
		});
	});
});
