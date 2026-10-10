// tests/feishu-gateway.test.ts
import { describe, expect, it } from "vitest";
import { parseMention } from "../src/feishu/gateway.js";

describe("feishu mention", () => {
	it("detects at", () => {
		expect(parseMention('<at user_id="ou_x">x</at> hi', "ou_bot")).toBe(false);
	});
});
