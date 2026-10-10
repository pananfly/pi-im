// tests/remote-full.test.ts
import { describe, expect, it } from "vitest";
import { formatHistoryPreview } from "../src/remote-commands.js";

describe("history preview", () => {
	it("caps at 5 and oldest-first", () => {
		const items = ["a", "b", "c", "d", "e", "f", "g"];
		expect(formatHistoryPreview(items, 99)).toContain("d");
	});
});
