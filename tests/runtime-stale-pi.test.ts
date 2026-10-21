// tests/runtime-stale-pi.test.ts
//
// Regression cover for "切换模型失败: This extension ctx is stale after session
// replacement or reload."
//
// ImController.runtime is long-lived: it is attached once when the IM gateway
// starts and then called for every /model, /thinking, /status ... for the life of
// the process. pi, however, dies with the session — every newSession/switchSession
// re-runs the extension factory and permanently invalidates the previous API.
//
// So the runtime must resolve the API at call time. Capturing a `pi` into the
// runtime is what made /model blow up after a session switch — attachRuntime()
// therefore takes no api at all, which makes the bug structurally impossible.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import piImExtension, { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { StaleExtensionApiError, setCurrentPi } from "../src/pi-ref.js";

const STALE =
	"This extension ctx is stale after session replacement or reload.";

/** Mimics pi: invalidate() poisons every subsequent call, forever. */
function fakePi() {
	let stale = false;
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const guard =
		<T>(fn: (self: never) => T) =>
		() => {
			if (stale) throw new Error(STALE);
			return fn(undefined as never);
		};
	const api = {
		on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, h);
		},
		registerCommand: () => {},
		sendUserMessage: guard(() => undefined),
		setModel: guard(() => Promise.resolve(true)),
		setThinkingLevel: guard(() => undefined),
	};
	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		poison: () => {
			stale = true;
		},
	};
}

function fakeCtx() {
	return {
		cwd: "/tmp/proj",
		scopedModels: [],
		isIdle: () => true,
		sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
		modelRegistry: {
			getAvailable: () => [{ id: "m1", name: "M1", provider: "p" }],
		},
		ui: { notify: () => {} },
	};
}

/** Run the real factory so shared.latestCtx is populated the way pi does it. */
async function bootWithSession(pi: ReturnType<typeof fakePi>) {
	piImExtension(pi.api);
	setCurrentPi(pi.api);
	const h = pi.handlers.get("session_start");
	expect(h).toBeTypeOf("function");
	await h?.({ type: "session_start" }, fakeCtx());
}

function makeController() {
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
		{ allowlist: [], channelName: "telegram" },
	);
	return { c, sent };
}

describe("runtime outlives the pi it was attached with", () => {
	it("switches the model through the pi handed to the latest factory run", async () => {
		const first = fakePi();
		await bootWithSession(first);
		const { c } = makeController();
		attachRuntime(c);

		// /new tears the old session down; the factory re-runs with a fresh api.
		first.poison();
		const second = fakePi();
		await bootWithSession(second);

		await expect(c.runtime?.switchModel?.("m1")).resolves.toMatchObject({
			id: "m1",
		});
	});

	it("reports a retryable error instead of leaking the SDK stale message", async () => {
		const pi = fakePi();
		await bootWithSession(pi);
		const { c } = makeController();
		attachRuntime(c);

		pi.poison(); // mid-swap: old api dead, no fresh factory run yet

		await expect(c.runtime?.switchModel?.("m1")).rejects.toThrow(
			StaleExtensionApiError,
		);
		await expect(c.runtime?.switchModel?.("m1")).rejects.not.toThrow(
			/ctx is stale/,
		);
	});

	it("sets the thinking level through the current pi too", async () => {
		const pi = fakePi();
		await bootWithSession(pi);
		const { c } = makeController();
		attachRuntime(c);

		pi.poison();
		const second = fakePi();
		await bootWithSession(second);

		// Reports the level that took effect, not merely "it did not throw".
		expect(c.runtime?.setThinking?.("high")).toMatchObject({
			ok: true,
			level: "high",
		});
	});
});
