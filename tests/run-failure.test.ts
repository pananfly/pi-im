// tests/run-failure.test.ts
//
// A failing agent run must never reject out of handleInbound. The gateway calls
// `void c.handleInbound(m)`, so a rejection becomes an unhandled rejection and
// takes the whole pi process down. This covers the crash where a message sent
// while pi was swapping sessions killed the host.
import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import { RuntimeNotReadyError, StaleExtensionApiError } from "../src/pi-ref.js";

function fakeChannel(sent: string[], edits: string[]) {
	return {
		async sendText(_chat: string, text: string) {
			sent.push(text);
			return `mid-${sent.length}`;
		},
		async editText(_chat: string, _id: string, text: string) {
			edits.push(text);
		},
	};
}

function inbound(text: string) {
	return {
		messageId: "s1",
		chatId: "c1",
		chatType: "p2p" as const,
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

describe("agent run failure", () => {
	it("reports a stale-api error to the user instead of rejecting", async () => {
		const sent: string[] = [];
		const edits: string[] = [];
		const agent = {
			async run() {
				throw new StaleExtensionApiError();
			},
			isActive: () => false,
			cancel() {},
			settle() {},
			steer: () => false,
			drainSteer: () => [],
			captureMessage() {},
			captureStreamingMessage() {},
			captureToolStart() {},
			captureToolEnd() {},
		};
		const c = new ImController(
			fakeChannel(sent, edits) as never,
			agent as never,
			{
				allowlist: ["u1"],
				channelName: "telegram",
			},
		);

		await expect(c.handleInbound(inbound("hi"))).resolves.toBeUndefined();

		const delivered = [...sent, ...edits].join("\n");
		expect(delivered).toContain("请稍后重发");
	});

	it("does not blame a session swap when nothing is bound at all", async () => {
		const sent: string[] = [];
		const edits: string[] = [];
		const agent = {
			async run() {
				throw new RuntimeNotReadyError();
			},
			isActive: () => false,
			cancel() {},
			settle() {},
			steer: () => false,
			drainSteer: () => [],
			captureMessage() {},
			captureStreamingMessage() {},
			captureToolStart() {},
			captureToolEnd() {},
		};
		const c = new ImController(
			fakeChannel(sent, edits) as never,
			agent as never,
			{ allowlist: ["u1"], channelName: "telegram" },
		);

		await c.handleInbound(inbound("hi"));

		const delivered = [...sent, ...edits].join("\n");
		// "Wait a few seconds and resend" is a lie here: no amount of waiting
		// binds an ExtensionAPI. Say what actually has to happen instead.
		expect(delivered).not.toContain("会话正在切换");
		expect(delivered).toMatch(/尚未就绪|打开会话/);
	});

	it("does not leak the raw SDK error text to the user", async () => {
		const sent: string[] = [];
		const edits: string[] = [];
		const agent = {
			async run() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
			isActive: () => false,
			cancel() {},
			settle() {},
			steer: () => false,
			drainSteer: () => [],
			captureMessage() {},
			captureStreamingMessage() {},
			captureToolStart() {},
			captureToolEnd() {},
		};
		const c = new ImController(
			fakeChannel(sent, edits) as never,
			agent as never,
			{
				allowlist: ["u1"],
				channelName: "telegram",
			},
		);

		await expect(c.handleInbound(inbound("hi"))).resolves.toBeUndefined();

		const delivered = [...sent, ...edits].join("\n");
		expect(delivered).not.toContain("ctx is stale");
		expect(delivered.length).toBeGreaterThan(0);
	});
});
