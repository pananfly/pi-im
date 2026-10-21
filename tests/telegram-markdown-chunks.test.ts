// tests/telegram-markdown-chunks.test.ts
//
// The guarantee under test is that a chunk boundary is never visible in the
// rendered message: a code fence that fits is never cut, a table that fits is
// never cut, and nothing is ever dropped.

import { describe, expect, it } from "vitest";
import {
	chunkForTelegram,
	chunkMarkdown,
	escapeMarkdownV2,
	hardCut,
	TELEGRAM_TEXT_LIMIT,
} from "../src/telegram/markdown-chunks.js";

const units = (s: string): number => s.length;

describe("telegram markdown chunking", () => {
	it("leaves a short answer alone", () => {
		expect(chunkMarkdown("短答案")).toEqual(["短答案"]);
	});

	it("keeps every chunk within Telegram's UTF-16 cap", () => {
		const text = Array.from({ length: 4000 }, (_, i) => `第${i}行答案`).join(
			"\n",
		);
		const chunks = chunkMarkdown(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(units(chunk)).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
		}
	});

	it("loses nothing across the split", () => {
		// The bug this replaces did `slice(0, 4000)` and discarded the rest, so
		// the first and last line both have to survive.
		const text = Array.from({ length: 3000 }, (_, i) => `第${i}行`).join("\n");
		const joined = chunkMarkdown(text).join("\n");
		expect(joined).toContain("第0行");
		expect(joined).toContain("第2999行");
	});

	it("never splits a code fence that fits", () => {
		const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const text = `前言\n\n\`\`\`python\n${body}\n\`\`\`\n\n后记`;
		const chunks = chunkMarkdown(text, TELEGRAM_TEXT_LIMIT);
		expect(chunks).toHaveLength(1);
		// One opening fence, one closing: neither was cut.
		expect((text.match(/```/g) ?? []).length).toBe(2);
		expect(chunks[0]).toContain("```python");
		expect(chunks[0]).toContain("```");
	});

	it("re-fences a code block too big for one message", () => {
		// Cutting the tail of a fence without re-opening it makes Telegram
		// render the remainder as prose — the single most visible way a naive
		// split betrays itself.
		const body = Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n");
		const chunks = chunkMarkdown(`\`\`\`js\n${body}\n\`\`\``, 400);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(units(chunk)).toBeLessThanOrEqual(400);
			// Every piece is a complete fence: opening and closing markers.
			expect(chunk.startsWith("```js")).toBe(true);
			expect(chunk.endsWith("```")).toBe(true);
		}
	});

	it("repeats the header when a table has to be split", () => {
		const rows = Array.from({ length: 200 }, (_, i) => `| ${i} | x |`).join(
			"\n",
		);
		const text = `| 列 | 值 |\n| --- | --- |\n${rows}`;
		const chunks = chunkMarkdown(text, 300);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk).toContain("| 列 | 值 |");
			expect(chunk).toContain("| --- | --- |");
			expect(units(chunk)).toBeLessThanOrEqual(300);
		}
	});

	it("does not mistake a horizontal rule for a table", () => {
		const text = "标题\n\n---\n\n正文";
		expect(chunkMarkdown(text)).toEqual([text]);
	});

	it("re-fences an unterminated fence when it has to split", () => {
		// A model cut off mid-code-block leaves the fence open. If we then split
		// the message, every piece must still be a complete fence — otherwise the
		// tail renders as prose.
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const chunks = chunkMarkdown(`\`\`\`py\n${body}`, 300);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.startsWith("```py")).toBe(true);
			expect(chunk.endsWith("```")).toBe(true);
		}
	});

	it("hard-cuts a single line longer than the limit", () => {
		const chunks = chunkMarkdown("答".repeat(1000), 300);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(units(chunk)).toBeLessThanOrEqual(300);
		// Nothing dropped.
		expect(chunks.join("").replace(/\n…\n/g, "")).toHaveLength(1000);
	});
});

describe("hardCut", () => {
	it("never halves a surrogate pair", () => {
		// An emoji is one code point but two UTF-16 units; cutting at the limit
		// naively produces a lone surrogate that JSON-encodes as invalid text.
		// A well-formed emoji is itself made of surrogates, so the check has to
		// look for a *lone* one rather than any surrogate at all.
		const lone =
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		const pieces = hardCut("👍👍👍👍👍", 4);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) {
			expect(units(piece)).toBeLessThanOrEqual(4);
			expect(piece).not.toMatch(lone);
		}
		expect(pieces.join("")).toBe("👍👍👍👍👍");
	});

	it("emits a code point wider than the limit rather than looping", () => {
		expect(hardCut("👍", 1)).toEqual(["👍"]);
	});
});

describe("MarkdownV2 escaping", () => {
	it("escapes the reserved set outside code", () => {
		expect(escapeMarkdownV2("a_b*c.d-e!f+g")).toBe("a\\_b\\*c\\.d\\-e\\!f\\+g");
	});

	it("escapes only backtick and backslash inside a fence", () => {
		// Telegram rejects any other backslash inside code, so blanket-escaping
		// there would make the message undeliverable rather than merely ugly.
		const out = escapeMarkdownV2("```\na_b*c.d\n```");
		expect(out).toContain("a_b*c.d");
		expect(out).not.toContain("a\\_b");
	});

	it("measures the escaped form, since escaping inflates it", () => {
		const raw = "_".repeat(3000);
		const chunks = chunkForTelegram(raw, "markdownV2", 4096);
		for (const chunk of chunks) expect(units(chunk)).toBeLessThanOrEqual(4096);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it("leaves plain mode untouched", () => {
		expect(chunkForTelegram("a_b*c", "plain", 4096)).toEqual(["a_b*c"]);
	});
});
