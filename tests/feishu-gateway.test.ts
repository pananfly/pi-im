// tests/feishu-gateway.test.ts
import { describe, expect, it } from "vitest";
import { parseMention } from "../src/feishu/gateway.js";

describe("feishu mention", () => {
	it("ignores @someone-else, matches own bot id", () => {
		expect(parseMention('<at user_id="ou_x">x</at> hi', "ou_bot")).toBe(false);
		expect(parseMention('<at user_id="ou_bot">bot</at> hi', "ou_bot")).toBe(
			true,
		);
		expect(parseMention("hello ou_bot do x", "ou_bot")).toBe(true);
		expect(parseMention("plain hello", "ou_9")).toBe(false);
		expect(parseMention("", "ou_9")).toBe(false);
	});
});
