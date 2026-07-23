// tests/bounded-output.test.mjs — contract tests for the shared `---label---` stdout
// grammar (skills/architectural-review/_helpers/bounded-output.mjs). Pins the emitter's
// truncation math (line cap, head-seeded byte cap) and proves the parser round-trips
// REAL emitter output — so a format change breaks loudly at the shared module.

import { describe, expect, it } from "vitest";
import { makeBoundedEmitter, parseBlocks } from "../skills/architectural-review/_helpers/bounded-output.mjs";

describe("line cap truncates with marker", () => {
	it("emits lineCap rows then the truncation marker", () => {
		const em = makeBoundedEmitter(2, Number.POSITIVE_INFINITY);
		em.block("x", ["a", "b", "c"]);
		expect(em.body()).toBe("---x---\na\nb\n(... 1 more truncated ...)\n");
	});
});

describe("byte cap includes head bytes", () => {
	it("counts the block header against the budget — zero rows fit in 16 bytes", () => {
		const em = makeBoundedEmitter(10, 16, "");
		em.block("x", ["12345678", "12345678"]);
		// 8-byte block header + 9-byte first row = 17 > 16 -> zero rows, both truncated
		expect(em.body()).toBe("---x---\n(... 2 more truncated ...)\n");
	});

	it("emits exactly one row at byteCap 17", () => {
		const em = makeBoundedEmitter(10, 17, "");
		em.block("x", ["12345678", "12345678"]);
		expect(em.body()).toBe("---x---\n12345678\n(... 1 more truncated ...)\n");
	});
});

describe("parseBlocks round-trip + header cutoff", () => {
	const emitted = (label, rows) => {
		const em = makeBoundedEmitter(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		em.block(label, rows);
		return em.body();
	};

	it("round-trips real emitter output and stops header detection at the first block", () => {
		const text = `file_count: 17\n${emitted("write-sites", ["table:foo\twriters=1"])}`;
		const { blocks, headers } = parseBlocks(text);
		expect(headers.file_count).toBe("17");
		expect(blocks["write-sites"]).toEqual(["table:foo\twriters=1"]);
		// a colon-bearing row after a block header is a row, not a header
		expect(headers.table).toBeUndefined();
	});

	it("parses CRLF input identically", () => {
		const text = `file_count: 17\n${emitted("write-sites", ["table:foo\twriters=1"])}`;
		const crlf = text.replaceAll("\n", "\r\n");
		expect(parseBlocks(crlf)).toEqual(parseBlocks(text));
	});
});
