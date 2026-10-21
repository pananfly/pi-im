// tests/feishu-send.test.ts
//
// Regression cover for the crash that killed pi on the first Feishu reply:
//
//   TypeError: Cannot read properties of undefined (reading 'mentions')
//     at OutboundSender.sendText (@larksuiteoapi/node-sdk/lib/index.js:102112)
//
// channel.sender IS the low-level OutboundSender. Its methods take four
// positional arguments — sendText(to, idType, text, opts) — but we called
// sendText(chatId, text) with two. So `idType` received the message body,
// `text` was undefined, and `opts` was undefined. The transpiled nullish
// coalescing `opts.mentions ?? []` evaluates the property access eagerly, so
// the undefined `opts` threw before any request was made.
//
// The public entry point is send(to, input, opts = {}), which derives the
// receive-id type itself via detectReceiveIdType().

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: unknown) => void;

const { sender, createLarkChannel } = vi.hoisted(() => {
	const h = new Map<string, Handler>();
	const s = {
		send: vi.fn(async (_to: string, _input: unknown) => ({
			messageId: "mid-1",
		})),
		// The four-argument low-level API we must stop calling.
		sendText: vi.fn(async () => ({ messageId: "mid-legacy" })),
		sendImage: vi.fn(async () => ({ messageId: "mid-img" })),
		sendFile: vi.fn(async () => ({ messageId: "mid-file" })),
		editMessage: vi.fn(async () => undefined),
	};
	const channel = {
		on: (name: string, fn: Handler) => {
			h.set(name, fn);
			return () => h.delete(name);
		},
		connect: async () => undefined,
		disconnect: async () => undefined,
		fetchBotIdentity: async () => ({ openId: "ou_bot" }),
		// Real SDK shape: send/editMessage live on the channel, not on sender.
		send: s.send,
		editMessage: s.editMessage,
		updateCard: vi.fn(async () => undefined),
		sender: s,
	};
	return {
		sender: s,
		createLarkChannel: vi.fn(() => channel),
	};
});

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
	return { ...actual, createLarkChannel };
});

const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");

async function booted() {
	const gw = new SdkFeishuGateway({
		appId: "cli_x",
		appSecret: "secret",
		domain: "feishu",
	});
	await gw.start();
	return gw;
}

beforeEach(() => {
	for (const fn of Object.values(sender)) {
		if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
	}
});

describe("feishu outbound calls use the public send() entry point", () => {
	it("sends text through send(chatId, { text })", async () => {
		const gw = await booted();

		await gw.sendText("oc_chat1", "hello there");

		expect(sender.send).toHaveBeenCalledWith("oc_chat1", {
			text: "hello there",
		});
	});

	it("never calls the four-argument sendText, which is what crashed", async () => {
		const gw = await booted();

		await gw.sendText("oc_chat1", "hello there");

		expect(sender.sendText).not.toHaveBeenCalled();
	});

	it("keeps the message body intact instead of dropping it into idType", async () => {
		const gw = await booted();

		await gw.sendText("oc_chat1", "已切换思考档位: high。");

		// The old call put this string in the idType slot and sent nothing.
		const [, input] = sender.send.mock.calls[0] as [string, { text: string }];
		expect(input.text).toBe("已切换思考档位: high。");
	});

	it("returns the message id the SDK reports", async () => {
		const gw = await booted();

		await expect(gw.sendText("oc_chat1", "hi")).resolves.toBe("mid-1");
	});

	it("wraps images in the shape the uploader expects", async () => {
		const gw = await booted();
		const buf = Buffer.from("png");

		await gw.sendImage("oc_chat1", buf, "shot.png");

		expect(sender.send).toHaveBeenCalledWith("oc_chat1", {
			image: { source: buf },
		});
		expect(sender.sendImage).not.toHaveBeenCalled();
	});

	it("wraps files with their filename, which the uploader needs", async () => {
		const gw = await booted();
		const buf = Buffer.from("zip");

		await gw.sendFile("oc_chat1", buf, "out.zip");

		expect(sender.send).toHaveBeenCalledWith("oc_chat1", {
			file: { source: buf, fileName: "out.zip" },
		});
		expect(sender.sendFile).not.toHaveBeenCalled();
	});

	it("still edits in place with the two-argument editMessage", async () => {
		const gw = await booted();

		await gw.editText("oc_chat1", "mid-1", "progress...");

		// editMessage(messageId, text) really is two-argument; leave it alone.
		expect(sender.editMessage).toHaveBeenCalledWith("mid-1", "progress...");
	});

	it("explains an unconnected gateway instead of throwing a TypeError", async () => {
		const gw = new SdkFeishuGateway({
			appId: "cli_x",
			appSecret: "secret",
			domain: "feishu",
		});

		await expect(gw.sendText("oc_chat1", "hi")).rejects.toThrow(
			/飞书网关未连接/,
		);
	});
});
