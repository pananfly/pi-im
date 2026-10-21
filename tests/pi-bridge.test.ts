// tests/pi-bridge.test.ts
import { describe, expect, it } from "vitest";
import { PiAgentBridge } from "../src/pi-bridge.js";

const silent = {
	onText: () => {},
	onThinking: () => {},
	onToolStart: () => {},
	onToolEnd: () => {},
};

describe("PiAgentBridge", () => {
	it("resolves on settle with captured text", async () => {
		const b = new PiAgentBridge(async () => {});
		const p = b.run("hello", silent);
		b.captureMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		} as never);
		b.settle();
		await expect(p).resolves.toContain("hi");
	});
});
