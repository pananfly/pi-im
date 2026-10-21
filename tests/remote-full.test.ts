// tests/remote-full.test.ts
import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { formatHistoryPreview } from "../src/remote-commands.js";

describe("history preview", () => {
	it("caps at 5 and oldest-first", () => {
		const items = ["a", "b", "c", "d", "e", "f", "g"];
		expect(formatHistoryPreview(items, 99)).toContain("d");
	});
});

function fakeChannel(sent: string[]) {
	return {
		async sendText(_chat: string, text: string) {
			sent.push(text);
			return `mid-${sent.length}`;
		},
		async editText() {},
	};
}

describe("im commands", () => {
	it("/status shows workspace/model/thinking", async () => {
		const sent: string[] = [];
		const bridge = new PiAgentBridge(async () => {});
		const c = new ImController(fakeChannel(sent) as never, bridge, {
			allowlist: ["u1"],
			channelName: "telegram",
		});
		c.runtime = {
			cwd: () => "/tmp/proj",
			sessionFile: () => "/tmp/s.jsonl",
			model: () => ({ id: "m1", name: "M1", provider: "p" }),
			thinking: () => "high",
			contextPercent: () => 42,
			isRunning: () => false,
		};
		await c.handleInbound({
			messageId: "s1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/status",
			timestampMs: Date.now(),
		});
		expect(sent.join("\n")).toContain("/tmp/proj");
		expect(sent.join("\n")).toContain("M1");
		expect(sent.join("\n")).toContain("high");
	});
	it("/models lists numbered models", async () => {
		const sent: string[] = [];
		const bridge = new PiAgentBridge(async () => {});
		const c = new ImController(fakeChannel(sent) as never, bridge, {
			allowlist: ["u1"],
			channelName: "telegram",
		});
		c.runtime = {
			listModels: () => [
				{ id: "a", name: "A" },
				{ id: "b", name: "B", provider: "p" },
			],
			model: () => ({ id: "a", name: "A" }),
		};
		await c.handleInbound({
			messageId: "s2",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/models",
			timestampMs: Date.now(),
		});
		expect(sent.join("\n")).toContain("1. A");
		expect(sent.join("\n")).toContain("2. B");
	});
	it("/thinking with no runtime replies usage", async () => {
		const sent: string[] = [];
		const bridge = new PiAgentBridge(async () => {});
		const c = new ImController(fakeChannel(sent) as never, bridge, {
			allowlist: ["u1"],
			channelName: "telegram",
		});
		c.runtime = {};
		await c.handleInbound({
			messageId: "s3",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/thinking",
			timestampMs: Date.now(),
		});
		expect(sent.join("\n")).toContain("/thinking high");
	});
	it("/steer queues when idle and takes effect in next turn", async () => {
		const sent: string[] = [];
		let ranPrompt = "";
		let bridgeInstance: PiAgentBridge | null = null;
		const bridge = new PiAgentBridge(async (p) => {
			ranPrompt = p;
			bridgeInstance?.captureMessage({
				role: "assistant",
				content: [{ type: "text", text: "好的" }],
			});
			bridgeInstance?.settle();
		});
		bridgeInstance = bridge;
		const c = new ImController(fakeChannel(sent) as never, bridge, {
			allowlist: ["u1"],
			channelName: "telegram",
		});
		await c.handleInbound({
			messageId: "st1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/steer 请用中文回答",
			timestampMs: Date.now(),
		});
		expect(sent.join("\n")).toContain("将在下一轮生效");

		// Run next turn
		await c.handleInbound({
			messageId: "m1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "你好",
			timestampMs: Date.now(),
		});
		expect(ranPrompt).toContain("请用中文回答");
		expect(ranPrompt).toContain("你好");
	});
	it("/send with empty batch replies batchNone without running agent", async () => {
		const sent: string[] = [];
		let runCalled = false;
		const bridge = new PiAgentBridge(async () => {
			runCalled = true;
		});
		const c = new ImController(fakeChannel(sent) as never, bridge, {
			allowlist: ["u1"],
			channelName: "telegram",
		});
		await c.handleInbound({
			messageId: "b1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/batch",
			timestampMs: Date.now(),
		});
		await c.handleInbound({
			messageId: "b2",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "/send",
			timestampMs: Date.now(),
		});
		expect(sent.join("\n")).toContain("无批量任务");
		expect(runCalled).toBe(false);
	});
});
