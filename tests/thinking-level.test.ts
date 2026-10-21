// tests/thinking-level.test.ts
//
// /thinking max replied "已切换思考档位: max" while /status showed `high`.
//
// pi silently clamps the level to what the model declares in thinkingLevelMap:
//
//   agent-session.js:2054
//     const effectiveLevel = availableLevels.includes(level)
//       ? level : this._clampThinkingLevel(level, availableLevels);
//     this.agent.state.thinkingLevel = effectiveLevel;
//
//   pi-ai/models.js:679  getSupportedThinkingLevels
//     if (level === "xhigh" || level === "max") return mapped !== undefined;
//
// setThinkingLevel returns void, so pi-im had nothing to read back — it echoed
// the requested string and declared success. The reply must report the level
// that actually took effect, and say so when the request was clamped.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import type { InboundMessage } from "../src/core/types.js";
import piImExtension, { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { StaleExtensionApiError } from "../src/pi-ref.js";

/** Mirrors pi-ai/models.js EXTENDED_THINKING_LEVELS. */
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Mirrors getSupportedThinkingLevels(model). */
function supportedLevels(map?: Record<string, string | null>): string[] {
	return ALL_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		// xhigh/max are opt-in: absent from the map means unsupported.
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Mirrors clampThinkingLevel(model, level). */
function clamp(supported: string[], level: string): string {
	if (supported.includes(level)) return level;
	const idx = ALL_LEVELS.indexOf(level);
	if (idx === -1) return supported[0] ?? "off";
	for (let i = idx; i < ALL_LEVELS.length; i++) {
		if (supported.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
	}
	for (let i = idx - 1; i >= 0; i--) {
		if (supported.includes(ALL_LEVELS[i])) return ALL_LEVELS[i];
	}
	return supported[0] ?? "off";
}

let thinkingMap: Record<string, string | null> | undefined;
let currentThinking = "high";
let setThinkingRejects: "stale" | null = null;

function fakePi() {
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
		setThinkingLevel: (lv: string) => {
			if (setThinkingRejects === "stale") {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			}
			// pi clamps silently and stores the clamped value.
			currentThinking = clamp(supportedLevels(thinkingMap), lv);
		},
	};
	return { api: api as unknown as ExtensionAPI, handlers };
}

function fakeCtx() {
	return {
		cwd: "/tmp/proj",
		scopedModels: [],
		isIdle: () => true,
		sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
		modelRegistry: { getAvailable: () => [] },
		model: {
			id: "m1",
			name: "M1",
			reasoning: true,
			thinkingLevelMap: thinkingMap,
		},
		get thinkingLevel() {
			return currentThinking;
		},
		ui: { notify: () => {} },
	};
}

async function boot() {
	const pi = fakePi();
	piImExtension(pi.api);
	const { setCurrentPi } = await import("../src/pi-ref.js");
	setCurrentPi(pi.api);
	await pi.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		fakeCtx(),
	);
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

let inboundSeq = 0;
function inbound(text: string): InboundMessage {
	inboundSeq += 1;
	return {
		messageId: `m${inboundSeq}`,
		chatId: "c1",
		chatType: "p2p" as const,
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piImShared__;
	inboundSeq = 0;
	thinkingMap = undefined;
	currentThinking = "high";
	setThinkingRejects = null;
});

describe("/thinking tells the truth about clamping", () => {
	it("reports the level pi actually applied, never the requested one", async () => {
		// This model declares nothing extra, so max is unsupported.
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking max"));

		const out = sent.join("\n");
		expect(c.runtime?.thinking?.()).toBe("high");
		// The reply must not claim the switch landed on max.
		expect(out).not.toMatch(/已切换思考档位: max/);
		expect(out).toContain("high");
	});

	it("says explicitly that the request was clamped", async () => {
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking max"));

		expect(sent.join("\n")).toMatch(/max/); // names what you asked for
		expect(sent.join("\n")).toMatch(/high/); // and what you got
	});

	it("does not claim clamping when the level was supported", async () => {
		thinkingMap = { xhigh: "xhigh", max: "max" };
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking max"));

		const out = sent.join("\n");
		expect(c.runtime?.thinking?.()).toBe("max");
		expect(out).toMatch(/已切换思考档位: max/);
		expect(out).not.toMatch(/夹取|clamp/i);
	});

	it("lists only the levels the current model supports", async () => {
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking"));

		const out = sent.join("\n");
		// xhigh/max are opt-in and undeclared here.
		expect(out).not.toContain("xhigh");
		expect(out).not.toContain("max");
		expect(out).toContain("high");
	});

	it("shows xhigh and max once the model opts in", async () => {
		thinkingMap = { xhigh: "xhigh", max: "max" };
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking"));

		const out = sent.join("\n");
		expect(out).toContain("xhigh");
		expect(out).toContain("max");
	});

	it("reports a stale context as retryable, not as an invalid level", async () => {
		const { c, sent } = await boot();
		setThinkingRejects = "stale";
		await c.handleInbound(inbound("/thinking high"));

		const out = sent.join("\n");
		// Not "无法设置思考档位" — the level is valid, the handle is stale.
		expect(out).not.toMatch(/无法设置思考档位/);
		expect(out).toMatch(/重发|retry|切换/i);
	});

	it("surfaces an invalid level with the levels that do work", async () => {
		const { c, sent } = await boot();
		await c.handleInbound(inbound("/thinking bogus"));

		const out = sent.join("\n");
		expect(out).toMatch(/bogus/);
		expect(out).toContain("high");
	});
});

describe("StaleExtensionApiError is still distinguished", () => {
	it("does not leak the raw SDK message", async () => {
		const { c, sent } = await boot();
		setThinkingRejects = "stale";
		await c.handleInbound(inbound("/thinking high"));
		expect(sent.join("\n")).not.toContain("ctx is stale");
	});

	it("is the error type used for stale failures", () => {
		expect(StaleExtensionApiError).toBeDefined();
	});
});
