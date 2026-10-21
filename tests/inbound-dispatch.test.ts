// tests/inbound-dispatch.test.ts
//
// The gateways dispatch inbound messages with `void c.handleInbound(m)`.
//
// `void` discards the promise, so when handleInbound rejects — a channel error,
// a gateway send failure, anything thrown while replying — nothing observes
// the rejection. Node turns that into an unhandled rejection and kills the pi
// process outright. That is why a broken Feishu send took down the whole TUI
// instead of just failing one reply.

import { describe, expect, it, vi } from "vitest";
import { ImController } from "../src/controller.js";
import type { InboundMessage } from "../src/core/types.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

const { dispatchInbound } = await import("../src/extension.js");

function message(): InboundMessage {
	return {
		messageId: "m1",
		chatId: "oc_chat1",
		chatType: "p2p",
		senderId: "ou_user",
		text: "/status",
		timestampMs: Date.now(),
	};
}

function controllerThatThrows(err: Error): ImController {
	const c = new ImController(
		{
			async sendText() {
				return "m";
			},
			async editText() {
				throw err;
			},
		} as never,
		new PiAgentBridge(async () => {}),
		{ allowlist: ["ou_user"], channelName: "feishu" },
	);
	c.runtime = {
		cwd: () => {
			throw err;
		},
	};
	return c;
}

describe("inbound dispatch never leaves a rejection unobserved", () => {
	it("swallows a throwing handler instead of crashing the host", async () => {
		const err = new Error("Cannot read properties of undefined");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		dispatchInbound(controllerThatThrows(err), message(), "feishu");

		// Give the rejected promise a macrotask to surface as unhandled.
		await new Promise((r) => setTimeout(r, 20));
		expect(errSpy).toHaveBeenCalled();
		expect(String(errSpy.mock.calls[0]?.[0])).toContain("feishu");

		errSpy.mockRestore();
	});

	it("still returns immediately so the gateway never blocks on us", () => {
		const c = controllerThatThrows(new Error("boom"));
		const slow = vi.spyOn(c, "handleInbound").mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 500));
		});

		const t0 = Date.now();
		dispatchInbound(c, message(), "telegram");
		expect(Date.now() - t0).toBeLessThan(50);

		slow.mockRestore();
	});
});
