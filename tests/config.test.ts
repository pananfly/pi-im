// tests/config.test.ts
import { describe, expect, it } from "vitest";
import { shouldAutoStart } from "../src/config.js";

describe("shouldAutoStart", () => {
	it("defaults true when file flag missing and no env", () => {
		expect(shouldAutoStart("feishu", {}, {})).toBe(true);
	});
	it("env 0 disables", () => {
		expect(
			shouldAutoStart("feishu", { PI_IM_AUTO_START: "0" }, { autoStart: true }),
		).toBe(false);
	});
});
