// tests/cross-channel-busy.test.ts
//
// Regression cover for the cross-channel "本地 Pi 会话正在切换" report.
//
// Telegram and Feishu are two ImControllers, each holding its OWN
// SerialMessageQueue (src/controller.ts: `queue = new SerialMessageQueue()`),
// but both call getBridge(), which hands back one process-global
// PiAgentBridge. So a task started on Telegram is still streaming when a
// Feishu message arrives and drives that same bridge again.
//
// pi runs exactly one prompt at a time. AgentSession.prompt() throws
//   "Agent is already processing. Specify streamingBehavior ('steer' or
//    'followUp') to queue the message."
// when a second one lands without a streamingBehavior. sendViaCurrentPi()
// wrapped EVERY error into StaleExtensionApiError, so this ordinary collision
// reached the user as "本地 Pi 会话正在切换" — a session swap that never happened.
//
// And because the throw escaped run() before its cleanup, the bridge stayed at
// running=true forever, so every later message failed identically.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiAgentBridge } from "../src/pi-bridge.js";
import {
	StaleExtensionApiError,
	sendViaCurrentPi,
	setCurrentPi,
} from "../src/pi-ref.js";

function assistant(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

const noop = {
	onText: () => {},
	onThinking: () => {},
	onToolStart: () => {},
	onToolEnd: () => {},
};

/** The exact error pi throws when a second prompt hits a streaming session. */
const ALREADY_PROCESSING =
	"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

describe("bridge state after a rejected send", () => {
	it("stops being active when the send fails", async () => {
		const bridge = new PiAgentBridge(async () => {
			throw new Error(ALREADY_PROCESSING);
		});

		await expect(bridge.run("hello", noop)).rejects.toThrow();
		expect(bridge.isActive()).toBe(false);
	});
});

describe("concurrent runs across channels", () => {
	it("keeps the in-flight run's text when another channel sends", async () => {
		const sent: string[] = [];
		const bridge = new PiAgentBridge(async (prompt) => {
			sent.push(prompt);
			// Telegram: pi has streamed part of the reply and is still busy.
			bridge.captureStreamingMessage(assistant("first-half "));
		});

		const telegram = bridge.run("tg", noop);

		// Every streaming chunk carries the whole message so far.
		bridge.captureStreamingMessage(assistant("first-half second-half"));

		// The Feishu message collides with it.
		const feishu = bridge.run("feishu", noop).then(
			() => null,
			(e: unknown) => e as Error,
		);

		bridge.settle();

		expect(await telegram).toBe("first-half second-half");
		// Duck-typed so this test needs no import of the not-yet-existing class.
		expect((await feishu)?.name).toBe("BridgeBusyError");
		// pi accepts one prompt at a time: the collision must be refused
		// before anything reaches the session, not merely reported afterwards.
		expect(sent).toEqual(["tg"]);
	});
});

describe("session-swap reporting", () => {
	it("does not claim a session swap for an ordinary send failure", () => {
		const api = {
			sendUserMessage() {
				throw new Error(ALREADY_PROCESSING);
			},
		};
		setCurrentPi(api as unknown as ExtensionAPI);

		try {
			sendViaCurrentPi("hello");
			expect.unreachable("the send should have thrown");
		} catch (e) {
			expect(e).not.toBeInstanceOf(StaleExtensionApiError);
			expect((e as Error).message).toBe(ALREADY_PROCESSING);
		}
	});

	it("still reports a genuine stale api as a session swap", () => {
		const api = {
			sendUserMessage() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
		};
		setCurrentPi(api as unknown as ExtensionAPI);

		expect(() => sendViaCurrentPi("hello")).toThrow(StaleExtensionApiError);
	});
});
