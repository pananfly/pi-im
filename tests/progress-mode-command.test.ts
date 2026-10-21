// tests/progress-mode-command.test.ts
//
// /feishu card | /feishu text switches how a running turn is rendered, without
// hand-editing feishu.json and without restarting pi or pi-web.
//
// The switch deliberately lands on the NEXT turn: makeRenderer builds one
// renderer per turn and that renderer closes over its own state, so a turn in
// flight finishes in the style it started in. A mid-turn style swap is what
// would produce "half a card, half a plain message".

import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import type { ChannelLike, InboundMessage } from "../src/core/types.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

function harness(opts?: {
	progressMode?: "text" | "card";
	channelName?: string;
	failWrite?: boolean;
}) {
	const text: string[] = [];
	const edits: string[] = [];
	const cards: Record<string, unknown>[] = [];
	const patches: Record<string, unknown>[] = [];
	const calls: string[] = [];

	const channel = {
		async sendText(_c: string, t: string) {
			text.push(t);
			return `mid-${text.length}`;
		},
		// Text mode finishes by editing the placeholder in place, so the answer
		// lands in `edits`, never in `text`. A harness that only records
		// sendText would silently lose it.
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

	const bridge = new PiAgentBridge(async () => {});
	const c = new ImController(channel, bridge, {
		allowlist: ["u1"],
		channelName: opts?.channelName ?? "feishu",
		progressMode: opts?.progressMode ?? "text",
	});

	// Stands in for the extension hook, including its write-then-apply order:
	// a failing write must leave the live mode alone.
	c.runtime = {
		setProgressMode: async (mode) => {
			calls.push(mode);
			if (opts?.failWrite) throw new Error("EACCES: read-only file system");
			c.setProgressMode(mode);
		},
	};

	return { c, text, edits, cards, patches, calls, bridge };
}

/** messageId must differ per message or the deduper eats the second one. */
function msg(text: string): InboundMessage {
	return {
		messageId: text,
		chatId: "c1",
		chatType: "p2p",
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

/** Drive one real turn: tool call + streamed text, then settle. */
async function runTurn(bridge: PiAgentBridge, done: Promise<void>) {
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
		content: [{ type: "text", text: "中间输出" }],
	} as never);
	bridge.settle();
	await done;
}

describe("/feishu progress mode", () => {
	it("switches to card and says so", async () => {
		const { c, text, calls } = harness();

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual(["card"]);
		expect(text.join("\n")).toMatch(/card/);
	});

	it("switches back to plain text", async () => {
		const { c, calls } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/feishu text"));

		expect(calls).toEqual(["text"]);
	});

	it("accepts any casing and surrounding space", async () => {
		const { c, calls } = harness();

		await c.handleInbound(msg("/feishu   CARD  "));

		expect(calls).toEqual(["card"]);
	});

	it("reports the current mode and usage when called with no argument", async () => {
		const { c, text, calls } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/feishu"));

		expect(calls).toEqual([]);
		const body = text.join("\n");
		expect(body).toMatch(/card/);
		expect(body).toMatch(/\/feishu card/);
	});

	it("refuses an unknown argument without touching anything", async () => {
		const { c, text, calls } = harness();

		await c.handleInbound(msg("/feishu foo"));

		expect(calls).toEqual([]);
		expect(text.join("\n")).toMatch(/\/feishu card/);
	});

	it("reports a failed save instead of claiming success", async () => {
		const { c, text, calls } = harness({ failWrite: true });

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual(["card"]);
		expect(text.join("\n")).toMatch(/EACCES/);
		expect(text.join("\n")).not.toMatch(/下一轮/);
	});

	it("refuses rather than lying when nothing can persist the choice", async () => {
		const { c, text } = harness();
		c.runtime = undefined;

		await c.handleInbound(msg("/feishu card"));

		// Silently succeeding here is the worst outcome: the switch would be
		// reported as done and undone by the next restart. Asserted against the
		// failure wording, not just the absence of the success wording — the
		// unimplemented fallback also lacks 下一轮, and would pass a bare
		// negative assertion.
		expect(text.join("\n")).toMatch(/切换失败/);
		expect(text.join("\n")).not.toMatch(/下一轮/);
	});

	it("uses cards from the next turn after the switch", async () => {
		const { c, cards, bridge } = harness();

		await c.handleInbound(msg("/feishu card"));
		await runTurn(bridge, c.handleInbound(msg("干活")));

		expect(cards.length).toBe(1);
	});

	it("lets the turn in flight finish in the style it started in", async () => {
		const { c, edits, cards, bridge } = harness();

		// A turn starts in text mode, then the switch lands while it runs.
		const running = c.handleInbound(msg("干活"));
		await new Promise((r) => setTimeout(r, 5));
		await c.handleInbound(msg("/feishu card"));
		await runTurn(bridge, running);

		// That turn must not turn into a card halfway through.
		expect(cards).toHaveLength(0);
		expect(edits.join("\n")).toContain("中间输出");

		// The one after it does use the card.
		await runTurn(bridge, c.handleInbound(msg("再干活")));
		expect(cards.length).toBe(1);
	});

	it("refuses on Telegram, where there is no card surface at all", async () => {
		const { c, text, calls } = harness({ channelName: "telegram" });

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual([]);
		expect(text.join("\n")).toMatch(/飞书/);
	});

	it("shows the configured mode in /status", async () => {
		const { c, text } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/status"));

		expect(text.join("\n")).toMatch(/card/);
	});

	it("reports the channel it serves, for the hook's file choice", () => {
		expect(harness({ channelName: "telegram" }).c.channelName()).toBe(
			"telegram",
		);
		expect(harness().c.channelName()).toBe("feishu");
	});
});
