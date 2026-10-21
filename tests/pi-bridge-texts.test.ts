// tests/pi-bridge-texts.test.ts
//
// Regression cover for the reply arriving N times, once per streaming update.
//
// pi emits `message_update` for every chunk and each one carries the whole
// assistant message so far, then a final `message_end` with the completed text.
// Both paths funnel into captureMessage(), which appended — so a five-character
// reply rendered as five lines of "OK".
//
// The bug stayed invisible while editText silently no-op'd (the frozen
// "收到,处理中…" hid the final message entirely). Fixing editText exposed it.

import { describe, expect, it } from "vitest";
import { PiAgentBridge } from "../src/pi-bridge.js";

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

const noop = {
	onText: () => {},
	onThinking: () => {},
	onToolStart: () => {},
	onToolEnd: () => {},
};

describe("bridge reply text", () => {
	it("renders a streamed reply once, not once per update", async () => {
		const bridge = new PiAgentBridge(async () => {
			bridge.captureStreamingMessage(assistant("O"));
			bridge.captureStreamingMessage(assistant("OK"));
			bridge.captureStreamingMessage(assistant("OK"));
			bridge.captureMessage(assistant("OK"));
			bridge.settle();
		});

		const out = await bridge.run("hello", noop);

		expect(out).toBe("OK");
	});

	it("keeps each turn's text separate", async () => {
		const bridge = new PiAgentBridge(async () => {
			bridge.captureStreamingMessage(assistant("第一"));
			bridge.captureMessage(assistant("第一段"));
			bridge.captureMessage(assistant("第二段"));
			bridge.settle();
		});

		const out = await bridge.run("hi", noop);

		expect(out).toBe("第一段\n第二段");
	});

	it("reports the growing text live while streaming", async () => {
		const seen: string[] = [];
		const bridge = new PiAgentBridge(async () => {
			bridge.captureStreamingMessage(assistant("O"));
			bridge.captureStreamingMessage(assistant("OK"));
			bridge.settle();
		});

		await bridge.run("hi", {
			onText: (t) => seen.push(t),
			onThinking: () => {},
			onToolStart: () => {},
			onToolEnd: () => {},
		});

		// run() fires one last onText with the finished answer; the live updates
		// before it must be the growing text, never an accumulation of it.
		expect(seen.slice(0, -1)).toEqual(["O", "OK"]);
	});

	it("handles a reply that never streamed", async () => {
		const bridge = new PiAgentBridge(async () => {
			bridge.captureMessage(assistant("一次性"));
			bridge.settle();
		});

		expect(await bridge.run("hi", noop)).toBe("一次性");
	});

	it("starts each run with a clean slate", async () => {
		let first = true;
		const bridge = new PiAgentBridge(async () => {
			if (first) {
				first = false;
				bridge.captureMessage(assistant("旧"));
			} else {
				bridge.captureMessage(assistant("新"));
			}
			bridge.settle();
		});

		await bridge.run("one", noop);
		expect(await bridge.run("two", noop)).toBe("新");
	});
});
