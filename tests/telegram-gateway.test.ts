// tests/telegram-gateway.test.ts
import { describe, expect, it } from "vitest";
import { shouldRespondInGroup } from "../src/telegram/gateway.js";

describe("tg group rule", () => {
	it("mention required", () => {
		expect(shouldRespondInGroup("hello", false, false)).toBe(false);
		expect(shouldRespondInGroup("@bot hello", true, false)).toBe(true);
	});
});
