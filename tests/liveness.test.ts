import { describe, expect, it } from "vitest";
import { livenessKey } from "../src/liveness.js";

describe("liveness", () => {
	it("key stable", () => {
		expect(livenessKey()).toBe("@agegr/pi-web/session-liveness/v1");
	});
});
