// tests/feishu-edit-card.test.ts
//
// Regression cover for the silent no-op that left every reply stuck on
// "收到,处理中…".
//
// The SDK splits its send surface across two classes:
//   OutboundSender — send / sendText / patchCard / createCardInstance
//   LarkChannel    — send / editMessage / updateCard / recallMessage
//
// `editMessage` exists ONLY on LarkChannel (grep count in OutboundSender: 0).
// pi-im read it off `channel.sender`, so it was always undefined and the guard
// `if (!s.editMessage) return;` returned *without throwing*. The controller's
// `.catch(() => sendText(...))` fallback therefore never fired and the progress
// message was never replaced.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { registered, channel, createLarkChannel } = vi.hoisted(() => {
	type Handler = (payload: unknown) => void;
	const registered = new Map<string, Handler>();
	const channel = {
		on: (name: string, fn: Handler) => {
			registered.set(name, fn);
			return () => registered.delete(name);
		},
		connect: async () => undefined,
		disconnect: async () => undefined,
		fetchBotIdentity: async () => ({ openId: "ou_bot" }),
		// The real split: no editMessage here, it lives on the channel.
		sender: { send: vi.fn(async () => ({ messageId: "mid-1" })) },
		send: vi.fn(async () => ({ messageId: "mid-card" })),
		editMessage: vi.fn(async () => undefined),
		updateCard: vi.fn(async () => undefined),
	};
	return {
		registered,
		channel,
		createLarkChannel: vi.fn(() => channel),
	};
});

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
	return { ...actual, createLarkChannel };
});

async function boot() {
	vi.resetModules();
	const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");
	const gw = new SdkFeishuGateway({
		appId: "cli_x",
		appSecret: "s",
		domain: "feishu",
	});
	await gw.start();
	return gw;
}

beforeEach(() => {
	vi.clearAllMocks();
	registered.clear();
});

describe("feishu message editing", () => {
	it("edits via the channel, where editMessage actually lives", async () => {
		const gw = await boot();

		await gw.editText("oc_chat", "om_msg", "final answer");

		expect(channel.editMessage).toHaveBeenCalledWith("om_msg", "final answer");
		// The old bug: this object has no editMessage at all.
		expect(channel.sender).not.toHaveProperty("editMessage");
	});

	it("throws instead of silently succeeding when the channel cannot edit", async () => {
		// The guard must produce its own message. A bare "undefined is not a
		// function" TypeError would also reject, but it tells the user nothing —
		// and the original bug was precisely a *non*-throwing path.
		const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");
		createLarkChannel.mockReturnValueOnce({
			...channel,
			editMessage: undefined,
		} as never);

		const gw = new SdkFeishuGateway({
			appId: "cli_x",
			appSecret: "s",
			domain: "feishu",
		});
		await gw.start();

		await expect(gw.editText("oc_chat", "om_msg", "x")).rejects.toThrow(
			/不支持 editMessage/,
		);
	});
});

describe("feishu interactive cards", () => {
	it("sends a card through send(), not sender.send()", async () => {
		const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");
		const gw = new SdkFeishuGateway({
			appId: "cli_x",
			appSecret: "s",
			domain: "feishu",
		});
		await gw.start();

		const id = await gw.sendCard("oc_chat", {
			schema: "2.0",
			header: { title: { tag: "plain_text", content: "t" } },
			body: { elements: [] },
		});

		expect(channel.send).toHaveBeenCalledWith(
			"oc_chat",
			expect.objectContaining({ card: expect.any(Object) }),
		);
		expect(id).toBe("mid-card");
	});

	it("replaces a card in place via updateCard", async () => {
		const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");
		const gw = new SdkFeishuGateway({
			appId: "cli_x",
			appSecret: "s",
			domain: "feishu",
		});
		await gw.start();

		await gw.updateCard("om_card", { schema: "2.0", body: { elements: [] } });

		expect(channel.updateCard).toHaveBeenCalledWith("om_card", {
			schema: "2.0",
			body: { elements: [] },
		});
	});
});
