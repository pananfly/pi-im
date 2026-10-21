// tests/auto-adopt.test.ts
//
// Why this exists: `/new`, `/workspace` and `/session` sent from IM all need an
// ExtensionCommandContext, and a command context only exists inside a *command
// handler* — createContext() (what session_start hands us) deliberately omits
// newSession/switchSession/fork. So `shared.cmdCtx` stayed null until the user
// remembered to type /tg status, which then had to be repeated after every
// session replacement because the old ctx goes stale.
//
// The only route to a real command ctx is pi's own command dispatch: a "/name"
// payload is turned into createCommandContext() before anything else
// (agent-session.js:1635 _tryExecuteExtensionCommand). Sending that payload
// through sendUserMessage therefore hands us the genuine article — and because
// the command is handled, prompt() returns early, so no user message is appended
// and no model turn starts.
//
// The fakePi below models exactly that dispatch, including the early return.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import piImExtension from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

const ADOPT_CMD = "_piim-adopt";

let sessionStarts = 0;

/**
 * pi's real behaviour: prompt() sees a leading "/" and dispatches to a
 * registered extension command with a command-capable context — but ONLY when
 * expandPromptTemplates is set. sendUserMessage defaults it to false
 * (agent-session.js:1871), and with it false a "/name" payload is an ordinary
 * user message that reaches the model. Anything dispatched with the flag off
 * lands in `leakedToModel` so the test can assert it never happens.
 */
function fakePi() {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const commands = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const leakedToModel: string[] = [];

	const dispatch = (text: string, file = "/tmp/proj/s.jsonl") => {
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		const args = space === -1 ? "" : text.slice(space + 1);
		const handler = commands.get(name);
		if (!handler) return; // not a command -> would fall through to the model
		void handler(args, {
			// A command context is createContext() PLUS these. The test only cares
			// that they are present, which is the whole point of the adopt command.
			newSession: () => Promise.resolve({ cancelled: false }),
			switchSession: () => Promise.resolve({ cancelled: false }),
			fork: () => Promise.resolve({ cancelled: false }),
			navigateTree: () => Promise.resolve({ cancelled: false }),
			reload: () => Promise.resolve(),
			waitForIdle: () => Promise.resolve(),
			isIdle: () => true,
			sessionManager: { getSessionFile: () => file },
			cwd: "/tmp/proj",
			ui: { notify: () => {} },
		});
	};

	const api = {
		on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, h);
		},
		registerCommand: (
			name: string,
			o: { handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands.set(name, o.handler);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		sendUserMessage: (
			content: string,
			options?: { expandPromptTemplates?: boolean },
		) => {
			const expand = options?.expandPromptTemplates ?? false;
			if (typeof content === "string" && content.startsWith("/")) {
				if (expand) dispatch(content);
				else leakedToModel.push(content);
			}
		},
		sendMessage: () => {},
		setModel: () => Promise.resolve(true),
		setThinkingLevel: () => {},
	};

	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		commands,
		dispatch,
		leakedToModel,
	};
}

function boot() {
	const pi = fakePi();
	piImExtension(pi.api);
	return pi;
}

async function startSession(pi: ReturnType<typeof fakePi>, reason = "new") {
	sessionStarts++;
	await pi.handlers.get("session_start")?.(
		{ type: "session_start", reason },
		{
			cwd: "/tmp/proj",
			sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
			isIdle: () => true,
			ui: { notify: () => {} },
		},
	);
}

beforeEach(() => {
	// pi-im keeps its state on globalThis so the IM gateways survive session
	// replacement. In tests that leaks between cases: adopt a ctx in one and the
	// next one passes without doing anything. Reset it per test.
	delete (globalThis as Record<string, unknown>).__piImShared__;
	sessionStarts = 0;
});

describe("automatic command-context adoption", () => {
	it("registers a silent adopt command", () => {
		const pi = boot();
		expect(pi.commands.has(ADOPT_CMD)).toBe(true);
	});

	it("never leaks the adopt payload to the model as a user message", async () => {
		// Regression: sendUserMessage defaults expandPromptTemplates to false, so
		// without the explicit opt-in the "/_piim-adopt" text was appended to the
		// session as a real user message and sent to the model.
		const pi = boot();
		await startSession(pi);

		expect(pi.leakedToModel).toEqual([]);
	});

	it("stores the command ctx so later session control uses it", async () => {
		const pi = boot();
		// A different session file than session_start reported: if the adopt
		// handler stored the ctx, holderFile moves with it.
		await pi.handlers.get("session_start")?.(
			{ type: "session_start", reason: "new" },
			{
				cwd: "/tmp/proj",
				sessionManager: {
					getSessionFile: () => "/tmp/proj/from-session-start.jsonl",
				},
				modelRegistry: { getAvailable: () => [] },
				scopedModels: [],
				isIdle: () => true,
				ui: { notify: () => {} },
			},
		);
		await new Promise((r) => setTimeout(r, 10));

		// The silent round trip must carry the holder's identity: an adopt
		// dispatch from some other session is ignored by design.
		pi.dispatch("/_piim-adopt", "/tmp/proj/from-session-start.jsonl");
		await new Promise((r) => setTimeout(r, 10));

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
		const { attachRuntime } = await import("../src/extension.js");
		attachRuntime(c);
		// The holder is the session session_start reported; the adopt round trip
		// only supplies the command-capable ctx for it.
		expect(c.runtime?.sessionFile?.()).toBe(
			"/tmp/proj/from-session-start.jsonl",
		);
		expect(c.runtime?.canControlSession?.()).toBe(true);
	});

	it("re-claims the context on every session replacement, not just startup", async () => {
		const pi = boot();
		const seen: string[] = [];
		const spy = (name: string) => {
			const orig = pi.commands.get(name);
			pi.commands.set(name, async (a, c) => {
				seen.push(name);
				return orig?.(a, c);
			});
		};
		spy(ADOPT_CMD);

		await startSession(pi, "startup");
		await startSession(pi, "new");
		await startSession(pi, "new");

		// Every session_start must re-claim: the previous command ctx is stale by
		// then, which is exactly what broke /new before.
		expect(seen.length).toBeGreaterThanOrEqual(sessionStarts);
	});

	it("lets IM /new work right after startup, with no /tg status typed", async () => {
		const pi = boot();
		await startSession(pi, "startup");

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
		const { attachRuntime } = await import("../src/extension.js");
		attachRuntime(c);

		// Before adoption this throws the "run /tg status first" error.
		await expect(c.runtime?.newSession?.()).resolves.toBe(true);
		expect(sent.join("\n")).not.toContain("/tg status");
	});

	it("reports session-control readiness in /status, so a silent break is visible", async () => {
		const pi = boot();
		const { attachRuntime } = await import("../src/extension.js");

		const askStatus = async (id: string) => {
			const sent: string[] = [];
			const c = new ImController(
				{
					async sendText(_chat: string, t: string) {
						sent.push(t);
						return "m";
					},
					async editText() {},
				} as never,
				new PiAgentBridge(async () => {}),
				{ allowlist: ["u1"], channelName: "telegram" },
			);
			attachRuntime(c);
			await c.handleInbound({
				messageId: id,
				chatId: "c1",
				chatType: "p2p",
				senderId: "u1",
				text: "/status",
				timestampMs: Date.now(),
			});
			return sent.join("\n");
		};

		// Fresh process: nothing has claimed a command ctx yet.
		expect(await askStatus("s1")).toContain("未就绪");

		await startSession(pi, "startup");
		await new Promise((r) => setTimeout(r, 10));

		expect(await askStatus("s2")).toContain("已就绪");
	});
});
