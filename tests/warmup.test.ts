// tests/warmup.test.ts
import { describe, expect, it } from "vitest";
// @ts-expect-error - untyped .mjs helper, runtime-tested
import { buildWarmupBody } from "../scripts/pi-web-warmup.mjs";

describe("warmup", () => {
	it("builds ensure_session", () => {
		expect(buildWarmupBody("/tmp/x")).toEqual({
			cwd: "/tmp/x",
			type: "ensure_session",
		});
	});
});
