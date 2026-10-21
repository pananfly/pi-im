// tests/feishu-reject.test.ts
//
// Regression cover for "飞书发了消息完全没反应" with nothing in any log.
//
// The SDK gates every inbound message before pi-im ever sees it:
//
//   const decision = this.policy.evaluate(msg);
//   if (!decision.allowed) { this.onReject({ reason }); return; }   // silent drop
//
// registerDispatcherHandlers() wires onReject to the channel's "reject"
// event (index.js:103862). pi-im only ever subscribed to "message", so a
// policy rejection — most often no_mention in a group chat — was dropped
// with no log line, no notification, and no way to tell it apart from
// "Feishu never delivered the event at all". Those two look identical
// from the outside, which is what made this undiagnosable.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: unknown) => void;

/** Handlers the gateway subscribed, keyed by event name. */
const subscribed = new Map<string, Handler>();

const { createLarkChannel } = vi.hoisted(() => ({
	createLarkChannel: vi.fn((_opts: { domain?: unknown }) => ({
		on: (name: string, h: (payload: unknown) => void) => {
			subscribed.set(name, h);
			return () => {
				subscribed.delete(name);
			};
		},
		connect: vi.fn(() => Promise.resolve()),
		disconnect: vi.fn(() => Promise.resolve()),
		fetchBotIdentity: vi.fn(() =>
			Promise.resolve({ openId: "ou_bot", userId: "u_bot" }),
		),
	})),
}));

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
	return { ...actual, createLarkChannel };
});

const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");

beforeEach(() => {
	createLarkChannel.mockClear();
	subscribed.clear();
});

async function booted(domain: "feishu" | "lark" = "feishu") {
	const gw = new SdkFeishuGateway({
		appId: "cli_x",
		appSecret: "s",
		domain,
	});
	await gw.start();
	return gw;
}

describe("feishu gateway surfaces SDK policy rejections", () => {
	it("subscribes to the reject event", async () => {
		await booted();
		expect(subscribed.has("reject")).toBe(true);
	});

	it("still subscribes to message, so wiring reject does not displace it", async () => {
		await booted();
		const handlers = subscribed;
		expect(handlers.has("message")).toBe(true);
		expect(handlers.has("reject")).toBe(true);
	});

	it("keeps the rejection reason and identity instead of dropping them", async () => {
		const gw = await booted();

		const before = gw.getLastReject();
		expect(before).toBeUndefined();

		subscribed.get("reject")?.({
			messageId: "om_1",
			chatId: "oc_1",
			senderId: "ou_sender",
			reason: "no_mention",
		});

		expect(gw.getLastReject()).toMatchObject({
			reason: "no_mention",
			chatId: "oc_1",
			senderId: "ou_sender",
		});
	});

	it("records a rejection even when the payload is malformed", async () => {
		const gw = await booted();

		subscribed.get("reject")?.({ reason: "dm_disabled" });

		expect(gw.getLastReject()).toMatchObject({ reason: "dm_disabled" });
	});
});
