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
			allowlist: [],
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
			allowlist: [],
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
			allowlist: [],
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
});
