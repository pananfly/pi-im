// tests/steer-progress.test.ts
import { describe, expect, it } from "vitest";
import { PiAgentBridge } from "../src/pi-bridge.js";

describe("steer + live progress", () => {
	it("steer() only active during run, observer gets live callbacks", async () => {
		const b = new PiAgentBridge(async () => {});
		expect(b.isActive()).toBe(false);
		expect(b.steer("x")).toBe(false);
		const seen: string[] = [];
		const acts: string[] = [];
		const p = b.run("hi", {
			onText: (t) => seen.push(t),
			onActivity: (a) => acts.push(a),
		});
		expect(b.isActive()).toBe(true);
		expect(b.steer("more")).toBe(true);
		b.captureToolStart("read");
		expect(acts).toContain("tool read");
		b.captureMessage({
			role: "assistant",
			content: [{ type: "text", text: "part" }],
		});
		expect(seen).toContain("part");
		expect(b.drainSteer()).toEqual(["more"]);
		b.settle();
		const out = await p;
		expect(out).toContain("part");
		expect(b.isActive()).toBe(false);
	});
	it("steerSend delivers via steer channel", async () => {
		const delivered: Array<{ t: string; o?: unknown }> = [];
		const b = new PiAgentBridge(
			async () => {},
			async (t) => {
				delivered.push({ t });
				return true;
			},
		);
		const p = b.run("hi", { onText: () => {}, onActivity: () => {} });
		expect(b.steer("s1")).toBe(true);
		b.settle();
		await p;
		expect(delivered.map((d) => d.t)).toEqual(["s1"]);
	});
});
