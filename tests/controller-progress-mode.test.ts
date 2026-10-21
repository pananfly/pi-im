// tests/controller-progress-mode.test.ts
//
// progressMode: "text" (default) | "card". The card mode must post one card and
// then replace it in place — never send a new message per update.

import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import type { ChannelLike, InboundMessage } from "../src/core/types.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

function harness(progressMode: "text" | "card") {
	const text: string[] = [];
	const cards: Record<string, unknown>[] = [];
	const edits: string[] = [];
	const patches: Record<string, unknown>[] = [];

	const channel = {
		async sendText(_c: string, t: string) {
			text.push(t);
			return `mid-${text.length}`;
		},
		async editText(_c: string, _m: string, t: string) {
			edits.push(t);
		},
		async sendCard(_c: string, card: Record<string, unknown>) {
			cards.push(card);
			return `mid-card-${cards.length}`;
		},
		async updateCard(_m: string, card: Record<string, unknown>) {
			patches.push(card);
		},
	} as unknown as ChannelLike;

	// Emits activity + text while "running", so the renderer has something to
	// refresh with before the answer arrives.
	const bridge = new PiAgentBridge(async () => {});
	const c = new ImController(channel, bridge, {
		allowlist: ["u1"],
		channelName: "feishu",
		progressMode,
	});

	return { c, text, cards, edits, patches, bridge };
}

function msg(text: string): InboundMessage {
	return {
		messageId: "m1",
		chatId: "c1",
		chatType: "p2p",
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

async function runTurn(c: ImController, bridge: PiAgentBridge, prompt: string) {
	const done = c.handleInbound(msg(prompt));
	// Let the bridge's send land before streaming activity into it.
	await new Promise((r) => setTimeout(r, 5));
	bridge.captureToolStart("tc-1", "bash", { command: "npm test" });
	bridge.captureToolEnd(
		"tc-1",
		{ content: [{ type: "text", text: "ok" }] },
		false,
		1200,
	);
	bridge.captureMessage({
		role: "assistant",
		content: [{ type: "thinking", thinking: "先跑测试" }],
	} as never);
	bridge.captureMessage({
		role: "assistant",
		content: [{ type: "text", text: "中间输出" }],
	} as never);
	bridge.settle();
	await done;
}

describe("progressMode card", () => {
	it("posts one card and patches it in place", async () => {
		const { c, text, cards, patches, bridge } = harness("card");

		await runTurn(c, bridge, "干活");

		expect(cards.length).toBe(1);
		expect(patches.length).toBeGreaterThan(0);
		// The placeholder must not also go out as a text message.
		expect(text).toHaveLength(0);
	});

	it("shows the tools and the answer in the card", async () => {
		const { c, cards, patches, bridge } = harness("card");

		await runTurn(c, bridge, "干活");

		const last = patches[patches.length - 1] ?? cards[0];
		const json = JSON.stringify(last);
		expect(json).toContain("bash");
		// The answer panel holds the text; the tools panel holds the tool list.
		expect(json).toContain("中间输出");
	});

	it("carries the tool's args, duration and thinking through to the card", async () => {
		const { c, cards, patches, bridge } = harness("card");

		await runTurn(c, bridge, "干活");

		const json = JSON.stringify(patches[patches.length - 1] ?? cards[0]);
		expect(json).toContain("npm test");
		expect(json).toContain("1.2s");
		expect(json).toContain("先跑测试");
	});

	it("does not print tool lines twice", async () => {
		// Tools and thinking each own a panel now, so the bridge's return value
		// carries prose only — otherwise the final card lists every call twice.
		const { c, cards, patches, bridge } = harness("card");

		await runTurn(c, bridge, "干活");

		const json = JSON.stringify(patches[patches.length - 1] ?? cards[0]);
		expect(json).not.toContain("- tool bash");
		// The prose lands once: in the answer block, never restated in a panel.
		expect(json.match(/中间输出/g)).toHaveLength(1);
	});

	it("falls back to text mode without touching cards", async () => {
		const { c, text, cards, patches, bridge } = harness("text");

		await runTurn(c, bridge, "干活");

		expect(cards).toHaveLength(0);
		expect(patches).toHaveLength(0);
		expect(text[0]).toContain("处理中");
	});

	it("still delivers the answer when the channel cannot patch cards", async () => {
		const sent: string[] = [];
		const channel = {
			async sendText(_c: string, t: string) {
				sent.push(t);
				return "mid-1";
			},
			// sendCard exists (so card mode is chosen) but updateCard throws.
			async sendCard() {
				return "mid-card";
			},
			async updateCard() {
				throw new Error("patch unsupported");
			},
			async editText() {
				throw new Error("edit unsupported");
			},
		} as unknown as ChannelLike;
		const bridge = new PiAgentBridge(async () => {});
		const c = new ImController(channel, bridge, {
			allowlist: ["u1"],
			channelName: "feishu",
			progressMode: "card",
		});

		await runTurn(c, bridge, "干活");

		// The answer must still reach the user by some route.
		expect(sent.join("\n")).toContain("中间输出");
	});

	it("spills an oversized answer into extra cards and patches each of them", async () => {
		const cards: Record<string, unknown>[] = [];
		const patches: string[] = [];
		const channel = {
			async sendText() {
				return "mid-1";
			},
			async sendCard(_c: string, card: Record<string, unknown>) {
				cards.push(card);
				return `mid-card-${cards.length}`;
			},
			async updateCard(id: string) {
				patches.push(id);
			},
			async editText() {},
		} as unknown as ChannelLike;
		const bridge = new PiAgentBridge(async () => {});
		const c = new ImController(channel, bridge, {
			allowlist: ["u1"],
			channelName: "feishu",
			progressMode: "card",
		});

		const done = c.handleInbound(msg("干活"));
		await new Promise((r) => setTimeout(r, 5));
		// Well past one card: Feishu rejects the whole write past ~30KB, so the
		// tail has to go into further messages rather than be lost.
		bridge.captureMessage({
			role: "assistant",
			content: [
				{
					type: "text",
					text: Array.from({ length: 4000 }, (_, i) => `第${i}行`).join("\n"),
				},
			],
		} as never);
		bridge.settle();
		await done;

		expect(cards.length).toBeGreaterThan(1);
		for (const card of cards) {
			expect(
				Buffer.byteLength(JSON.stringify(card), "utf8"),
			).toBeLessThanOrEqual(24_000);
		}
		expect(patches).toContain("mid-card-1");
	});
});
