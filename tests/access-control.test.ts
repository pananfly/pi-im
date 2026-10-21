// tests/access-control.test.ts
//
// The bot drives a pi session that holds bash/read/write/edit. An empty
// allowlist used to mean "everyone is allowed", so a configured bot with no
// allowlist was a remote-code-execution hole: anyone who found the bot token
// could shell out on the host.
//
// Empty now means "nobody". `["*"]` is the explicit opt-out, so "I forgot to
// configure this" can never silently reopen the door.

import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

function harness(allowlist: string[], channelName = "telegram") {
	const sent: string[] = [];
	const c = new ImController(
		{
			async sendText(_chat: string, text: string) {
				sent.push(text);
				return "m";
			},
			async editText() {},
		} as never,
		new PiAgentBridge(async () => {
			throw new Error("agent must not run for a rejected sender");
		}),
		{ allowlist, channelName },
	);
	return { c, sent };
}

let seq = 0;
function msg(text: string, senderId = "999") {
	return {
		messageId: `m-${seq++}-${text}`,
		chatId: "chat",
		chatType: "p2p" as const,
		senderId,
		text,
		timestampMs: Date.now(),
	};
}

describe("sender allowlist", () => {
	it("rejects everyone when the allowlist is empty", async () => {
		const { c, sent } = harness([]);
		await c.handleInbound(msg("/status"));
		expect(sent.join("\n")).not.toContain("pi-im");
		expect(sent).toHaveLength(1);
	});

	it('treats ["*"] as an explicit allow-all', async () => {
		const { c, sent } = harness(["*"]);
		c.runtime = { cwd: () => "/tmp/proj" };
		await c.handleInbound(msg("/status"));
		expect(sent.join("\n")).toContain("/tmp/proj");
	});

	it("admits a listed sender", async () => {
		const { c, sent } = harness(["111"]);
		c.runtime = { cwd: () => "/tmp/proj" };
		await c.handleInbound(msg("/status", "111"));
		expect(sent.join("\n")).toContain("/tmp/proj");
	});

	it("rejects an unlisted sender even when others are listed", async () => {
		const { c, sent } = harness(["111"]);
		await c.handleInbound(msg("/status", "222"));
		expect(sent.join("\n")).not.toContain("/tmp/proj");
	});

	it("tells a rejected sender their own id and how to get in", async () => {
		const { c, sent } = harness([]);
		await c.handleInbound(msg("/status", "424242"));
		const out = sent.join("\n");
		expect(out).toContain("424242"); // their own id, so they need no client lookup
		expect(out).toContain("/tg allow"); // and the exact command to run
	});

	it("names the feishu command when rejecting on feishu", async () => {
		const { c, sent } = harness([], "feishu");
		await c.handleInbound(msg("/status", "777"));
		expect(sent.join("\n")).toContain("/feishu allow");
	});

	// Otherwise the owner unlocks the bot from the TUI, still gets refused,
	// and has no way to tell that a restart is the missing step.
	it("admits a sender added after start, without a restart", async () => {
		const { c, sent } = harness([]);
		c.runtime = { cwd: () => "/tmp/proj" };

		await c.handleInbound(msg("/status", "111"));
		expect(sent.join("\n")).not.toContain("/tmp/proj");

		c.setAllowlist(["111"]); // what /tg allow does
		sent.length = 0;
		await c.handleInbound(msg("/status", "111"));

		expect(sent.join("\n")).toContain("/tmp/proj");
	});

	it("stops admitting a sender removed after start", async () => {
		const { c, sent } = harness(["111"]);
		c.runtime = { cwd: () => "/tmp/proj" };

		c.setAllowlist([]); // what /tg deny does
		await c.handleInbound(msg("/status", "111"));

		expect(sent.join("\n")).not.toContain("/tmp/proj");
	});
});
