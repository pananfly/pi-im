// tests/ui-bridge.test.ts
//
// A UI prompt raised by a tool (ask_user and friends) must reach the IM chat
// that started the turn, and the chat reply must resolve that exact prompt —
// not start a second agent turn. These tests pin both halves: the UI patch and
// the controller's inbound interception.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImController } from "../src/controller.js";
import type { ChannelLike, InboundMessage } from "../src/core/types.js";
import piImExtension from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import {
	type BridgedUi,
	consumeUiAnswer,
	currentImTurn,
	hasPendingUiPrompt,
	type ImTurn,
	installImUiBridge,
	pickOption,
	resetUiBridgeForTests,
	runAsImTurn,
} from "../src/ui-bridge.js";

interface FakeUi extends BridgedUi {
	custom: (...args: unknown[]) => unknown;
	select: (...args: unknown[]) => unknown;
	confirm: (...args: unknown[]) => unknown;
	input: (...args: unknown[]) => unknown;
	editor: (...args: unknown[]) => unknown;
}

function fakeUi(): FakeUi {
	return {
		custom: vi.fn(() => "panel"),
		select: vi.fn(() => "original-select"),
		confirm: vi.fn(() => false),
		input: vi.fn(() => "original-input"),
		editor: vi.fn(() => "original-editor"),
	};
}

function turn(sent: string[]): ImTurn {
	return {
		channel: "feishu",
		chatId: "c1",
		send: async (_chatId, text) => {
			sent.push(text);
		},
		locale: () => "zh",
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	resetUiBridgeForTests();
	delete (globalThis as Record<string, unknown>).__piImShared__;
});

afterEach(() => {
	vi.useRealTimers();
	resetUiBridgeForTests();
});

describe("pickOption", () => {
	const options = ["alpha", "beta", "gamma"];

	it("accepts 1-based numbers and full-width digits", () => {
		expect(pickOption(options, "2")).toBe("beta");
		expect(pickOption(options, "２")).toBe("beta");
		expect(pickOption(options, "(3)")).toBe("gamma");
		expect(pickOption(options, "9")).toBeUndefined();
	});

	it("accepts the label, a prefix, or a case variant", () => {
		expect(pickOption(options, "gamma")).toBe("gamma");
		expect(pickOption(options, "BET")).toBe("beta");
		expect(pickOption(options, "b")).toBeUndefined();
	});
});

describe("installImUiBridge", () => {
	it("leaves browser prompts alone when no IM turn is active", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		expect(ui.custom()).toBe("panel");
		expect(await ui.select("T", options())).toBe("original-select");
		expect(await ui.confirm("T", "M")).toBe(false);
	});

	it("declines custom UI only inside an IM turn, so extensions degrade", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		await runAsImTurn(turn(sent), async () => {
			expect(ui.custom()).toBeUndefined();
			expect(currentImTurn()?.chatId).toBe("c1");
		});
		expect(currentImTurn()).toBeUndefined();
		expect(ui.custom()).toBe("panel");
	});

	it("patches TUI-hosted sessions too, so a chat turn still gets asked", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "tui");
		await runAsImTurn(turn([]), async () => {
			expect(ui.custom()).toBeUndefined();
		});
		// a turn typed in the terminal is not an IM turn: the panel stays local
		expect(ui.custom()).toBe("panel");
	});

	it("forwards a TUI-hosted select to the chat and takes the reply", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "tui");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.select("Pick one", options()));
		await tick();
		expect(sent[0]).toContain("1) alpha");
		expect(consumeUiAnswer("feishu", "c1", "1", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("alpha");
	});

	// The "only one IM turn is running" fallback is a process-wide fact. Pi Web
	// keeps one `ctx.ui` per session, so only the holder's is patched — but a
	// prompt raised *in that patched session* with no AsyncLocalStorage context
	// (a detached tool callback) would otherwise claim whatever turn is in flight.
	it("leaves another session's prompt on its own panel", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "tui", true, { file: "/sessions/mine.jsonl" });
		const sent: string[] = [];
		const t = { ...turn(sent), session: { file: "/sessions/other.jsonl" } };
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = runAsImTurn(t, () => held);
		await tick();

		// Detached from the turn's async chain: the store is empty here.
		expect(ui.custom()).toBe("panel");
		expect(await ui.select("Pick", options())).toBe("original-select");
		expect(sent).toEqual([]);

		release();
		await running;
	});

	it("still collects a detached prompt that belongs to this session", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "tui", true, { file: "/sessions/mine.jsonl" });
		const sent: string[] = [];
		const t = { ...turn(sent), session: { file: "/sessions/mine.jsonl" } };
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = runAsImTurn(t, () => held);
		await tick();

		const answer = ui.select("Pick", options());
		await tick();
		expect(sent[0]).toContain("Pick");
		expect(consumeUiAnswer("feishu", "c1", "2", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("beta");

		release();
		await running;
	});

	it("stays permissive when either side has no session identity", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "tui", true, null);
		const sent: string[] = [];
		const t = { ...turn(sent), session: { file: "/sessions/other.jsonl" } };
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = runAsImTurn(t, () => held);
		await tick();

		// A host that cannot name its session must not go silent.
		expect(ui.custom()).toBeUndefined();
		const answer = ui.select("Pick", options());
		await tick();
		expect(sent[0]).toContain("Pick");
		expect(consumeUiAnswer("feishu", "c1", "1", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("alpha");

		release();
		await running;
	});

	it("does not patch a host that reports no UI", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc", false);
		await runAsImTurn(turn([]), async () => {
			expect(ui.custom()).toBe("panel");
		});
	});

	it("sends select options numbered and resolves the chosen label", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () =>
			ui.select("Which one?", options()),
		);
		await tick();
		expect(sent[0]).toContain("Which one?");
		expect(sent[0]).toContain("1) alpha");
		expect(sent[0]).toContain("回复序号 1-3");

		expect(consumeUiAnswer("feishu", "c1", "2", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("beta");
		expect(sent.at(-1)).toBe("✅ 已提交:beta");
	});

	it("accepts the option text and rejects an unknown index without consuming the prompt", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.select("Pick", options()));
		await tick();
		// A known command is not an answer: it must still run, and the question
		// must stay answerable afterwards.
		expect(consumeUiAnswer("feishu", "c1", "/status", "zh", t.send)).toBe(
			false,
		);
		expect(hasPendingUiPrompt("feishu", "c1")).toBe(true);
		// A bad index is consumed (it was trying to answer) and yields a hint.
		expect(consumeUiAnswer("feishu", "c1", "9", "zh", t.send)).toBe(true);
		expect(sent.at(-1)).toContain("1-3");
		expect(consumeUiAnswer("feishu", "c1", "gamma", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("gamma");
	});

	it("hides the freeform row and treats a typed reply as the custom answer", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const opts = ["alpha", "beta", "✏️ Type custom response..."];
		const answer = runAsImTurn(t, async () => ui.select("Pick", opts));
		await tick();
		expect(sent[0]).not.toContain("Type custom response");
		expect(sent[0]).toContain("1) alpha");
		expect(sent[0]).toContain("2) beta");
		expect(sent[0]).toContain("想自己写答案");

		expect(consumeUiAnswer("feishu", "c1", "my own words", "zh", t.send)).toBe(
			true,
		);
		await expect(answer).resolves.toBe("✏️ Type custom response...");
		expect(sent.at(-1)).toBe("✅ 已提交:my own words");

		// ask_user now asks for the freeform text; the stash answers it silently
		// instead of asking a second, nearly-identical question.
		const asked = sent.length;
		const input = runAsImTurn(t, async () =>
			ui.input("(1/2) Pick", "Type your answer..."),
		);
		await expect(input).resolves.toBe("my own words");
		expect(sent.length).toBe(asked);
	});

	it("points an out-of-range number back at the visible options", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const opts = ["alpha", "beta", "✏️ Type custom response..."];
		const answer = runAsImTurn(t, async () => ui.select("Pick", opts));
		await tick();
		expect(consumeUiAnswer("feishu", "c1", "5", "zh", t.send)).toBe(true);
		expect(sent.at(-1)).toContain("1-2");
		expect(hasPendingUiPrompt("feishu", "c1")).toBe(true);
		expect(consumeUiAnswer("feishu", "c1", "2", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("beta");
	});

	it("resolves input with the whole message", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.input("Name?", "e.g. bob"));
		await tick();
		expect(sent[0]).toContain("Name?");
		expect(sent[0]).toContain("e.g. bob");
		expect(consumeUiAnswer("feishu", "c1", "hello world", "zh", t.send)).toBe(
			true,
		);
		await expect(answer).resolves.toBe("hello world");
	});

	it("maps yes/no for confirm and re-asks on anything else", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.confirm("Delete?", "sure?"));
		await tick();
		expect(consumeUiAnswer("feishu", "c1", "maybe", "zh", t.send)).toBe(true);
		expect(sent.at(-1)).toContain("是");
		expect(consumeUiAnswer("feishu", "c1", "否", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe(false);
	});

	it("cancels with /cancel or ESC", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.select("Pick", options()));
		await tick();
		expect(consumeUiAnswer("feishu", "c1", "esc", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBeUndefined();
		expect(sent.at(-1)).toBe("已取消这个提问。");
	});

	it("replaces an unanswered prompt instead of letting two share one reply", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const first = runAsImTurn(t, async () => ui.select("First", options()));
		await tick();
		const second = runAsImTurn(t, async () => ui.select("Second", options()));
		await tick();
		await expect(first).resolves.toBeUndefined();
		expect(consumeUiAnswer("feishu", "c1", "1", "zh", t.send)).toBe(true);
		await expect(second).resolves.toBe("alpha");
	});

	it("reminds a group to @-mention before answering", async () => {
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = { ...turn(sent), group: true };
		const answer = runAsImTurn(t, async () => ui.select("Pick", options()));
		await tick();
		expect(sent[0]).toContain("@我");
		expect(consumeUiAnswer("feishu", "c1", "1", "zh", t.send)).toBe(true);
		await expect(answer).resolves.toBe("alpha");
	});

	it("nudges once when a long-deadline question goes unanswered", async () => {
		vi.useFakeTimers();
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () =>
			ui.select("Pick", options(), { timeout: 300_000 }),
		);
		await vi.advanceTimersByTimeAsync(150_000 + 10);
		expect(sent.some((m) => m.includes("还在等你回答"))).toBe(true);
		expect(hasPendingUiPrompt("feishu", "c1")).toBe(true);
		await vi.advanceTimersByTimeAsync(150_000);
		await expect(answer).resolves.toBeUndefined();
	});

	it("expires an unanswered prompt and says so", async () => {
		vi.useFakeTimers();
		const ui = fakeUi();
		installImUiBridge(ui, "rpc");
		const sent: string[] = [];
		const t = turn(sent);
		const answer = runAsImTurn(t, async () => ui.select("Pick", options()));
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10);
		await expect(answer).resolves.toBeUndefined();
		expect(sent.join("\n")).toContain("已自动取消");
		expect(hasPendingUiPrompt("feishu", "c1")).toBe(false);
	});
});

function options(): string[] {
	return ["alpha", "beta", "gamma"];
}

function msg(text: string, id: string): InboundMessage {
	return {
		messageId: id,
		chatId: "c1",
		chatType: "p2p",
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("controller answer routing", () => {
	it("consumes a chat reply as the answer instead of starting a new turn", async () => {
		const sent: string[] = [];
		const channel = {
			async sendText(_c: string, t: string) {
				sent.push(t);
				return `mid-${sent.length}`;
			},
			async editText() {},
		} as unknown as ChannelLike;

		const ui = fakeUi();
		installImUiBridge(ui, "rpc");

		let asks = 0;
		let sendCalls = 0;
		const bridge = new PiAgentBridge(async () => {
			sendCalls += 1;
			// Runs inside the controller's runAsImTurn, exactly like a tool call.
			asks += 1;
			void ui.select("Choose", ["alpha", "beta"]);
		});
		const c = new ImController(channel, bridge, {
			allowlist: ["u1"],
			channelName: "feishu",
		});

		const firstTurn = c.handleInbound(msg("do it", "m1"));
		await waitFor(() => sent.some((t) => t.includes("Choose")));

		await c.handleInbound(msg("2", "m2"));
		expect(sendCalls).toBe(1);
		expect(asks).toBe(1);
		expect(sent.some((t) => t.includes("已提交:beta"))).toBe(true);

		bridge.settle();
		await firstTurn;
	});

	it("does not intercept a reply when no question is pending", async () => {
		const sent: string[] = [];
		const channel = {
			async sendText(_c: string, t: string) {
				sent.push(t);
				return `mid-${sent.length}`;
			},
			async editText() {},
		} as unknown as ChannelLike;
		let turns = 0;
		const bridge = new PiAgentBridge(async () => {
			turns += 1;
			bridge.settle();
		});
		const c = new ImController(channel, bridge, {
			allowlist: ["u1"],
			channelName: "feishu",
		});
		await c.handleInbound(msg("hello", "m1"));
		await c.handleInbound(msg("2", "m2"));
		expect(turns).toBe(2);
	});
});

describe("holder installation", () => {
	it("patches the holder's ui at session_start and leaves other sessions alone", async () => {
		const pi = fakePi();
		piImExtension(pi.api);

		const holderUi = fakeUi();
		await startSession(pi, holderUi, "/tmp/proj/a.jsonl", "/tmp/proj");
		const sent: string[] = [];
		await runAsImTurn(turn(sent), async () => {
			expect(holderUi.custom()).toBeUndefined();
		});

		// A session another workspace opened in the browser is not adopted, so its
		// ask_user keeps rendering in the browser.
		const otherUi = fakeUi();
		await startSession(pi, otherUi, "/tmp/other/b.jsonl", "/tmp/other");
		await runAsImTurn(turn(sent), async () => {
			expect(otherUi.custom()).toBe("panel");
		});
	});
});

function fakePi(): {
	api: import("@earendil-works/pi-coding-agent").ExtensionAPI;
	handlers: Map<string, (e: unknown, c: unknown) => unknown>;
} {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const api = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
		sendMessage: () => {},
		setModel: async () => true,
	};
	return {
		api: api as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI,
		handlers,
	};
}

async function startSession(
	pi: ReturnType<typeof fakePi>,
	ui: FakeUi,
	file: string,
	cwd: string,
): Promise<void> {
	await pi.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		{
			cwd,
			mode: "rpc",
			ui,
			sessionManager: {
				getSessionFile: () => file,
				getSessionId: () => file,
			},
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
			isIdle: () => true,
		},
	);
	await tick();
}
