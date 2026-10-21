// tests/history-entries.test.ts
//
// /session said "已绑定会话" and /history immediately answered "暂无可显示的历史".
// The session had 8 messages, so /history was lying.
//
// sessionManager.getEntries() returns SessionEntry[], not AgentMessage[]. A
// message is wrapped one level deeper:
//
//   { type: "message", id, parentId, timestamp, message: { role, content } }
//                                    ^^^^^^ readHistory looked at e.role here
//
// So every entry was filtered out and /history reported an empty history for a
// session that had one.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import piImExtension, { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { setCurrentPi } from "../src/pi-ref.js";

/** One line of a real .jsonl session file, shaped the way pi writes it. */
function entry(role: string, text: string) {
	return {
		type: "message",
		id: `e-${role}-${text}`,
		parentId: null,
		timestamp: 0,
		message: {
			role,
			content: [{ type: "text", text }],
		},
	};
}

const ENTRIES = [
	entry("system", "you are pi"),
	entry("user", "帮我看下这个 bug"),
	entry("assistant", "是 readHistory 读错了形状"),
	entry("user", "那修掉"),
	entry("assistant", "已修"),
	{ type: "model_change", id: "m1", parentId: null, timestamp: 0 },
];

function boot() {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const api = {
		on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, h);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		setModel: () => Promise.resolve(true),
		setThinkingLevel: () => {},
	} as unknown as ExtensionAPI;

	piImExtension(api);
	setCurrentPi(api);

	const ctx = {
		cwd: "/tmp/proj",
		scopedModels: [],
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => "/tmp/proj/s.jsonl",
			getEntries: () => ENTRIES,
		},
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: () => {} },
	};

	return { handlers, ctx };
}

function harness() {
	const sent: string[] = [];
	const c = new ImController(
		{
			async sendText(_chat: string, text: string) {
				sent.push(text);
				return "m";
			},
			async editText() {},
		} as never,
		new PiAgentBridge(async () => {}),
		{ allowlist: ["u1"], channelName: "telegram" },
	);
	attachRuntime(c);
	return { c, sent };
}

let n = 0;
function msg(text: string) {
	n += 1;
	return {
		messageId: `m${n}`,
		chatId: "c1",
		chatType: "p2p" as const,
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piImShared__;
	n = 0;
});

describe("/history reads session entries, not raw messages", () => {
	it("reads role/content off the nested message", async () => {
		const { handlers, ctx } = boot();
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "new" },
			ctx,
		);
		const { c, sent } = harness();

		await c.handleInbound(msg("/history 5"));

		const out = sent.join("\n");
		expect(out).toContain("帮我看下这个 bug");
		expect(out).toContain("是 readHistory 读错了形状");
	});

	it("skips system messages and non-message entries", async () => {
		const { handlers, ctx } = boot();
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "new" },
			ctx,
		);
		const { c, sent } = harness();

		await c.handleInbound(msg("/history 5"));

		const out = sent.join("\n");
		expect(out).not.toContain("you are pi");
		expect(out).not.toContain("m1"); // the model_change entry
	});

	it("honours the cap and returns the newest entries", async () => {
		const { handlers, ctx } = boot();
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "new" },
			ctx,
		);
		const { c, sent } = harness();

		await c.handleInbound(msg("/history 1"));

		const out = sent.join("\n");
		expect(out).toContain("已修");
		expect(out).not.toContain("帮我看下这个 bug");
	});

	it("does not report 'no history' for a session that has messages", async () => {
		const { handlers, ctx } = boot();
		await handlers.get("session_start")?.(
			{ type: "session_start", reason: "new" },
			ctx,
		);
		const { c, sent } = harness();

		await c.handleInbound(msg("/history 5"));

		// The exact wording that made this look like a binding failure.
		expect(sent.join("\n")).not.toMatch(/尚无绑定会话|历史为空/);
	});
});
