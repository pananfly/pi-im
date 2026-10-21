// tests/pi-ref.test.ts
//
// Regression cover for the crash where a Telegram message arriving after a TUI
// session replacement killed pi with:
//   "This extension ctx is stale after session replacement or reload."
//
// pi re-runs the extension factory on every session replacement and permanently
// invalidates the previous ExtensionAPI, so long-lived IM plumbing must resolve
// the API at call time instead of capturing the `pi` it was handed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetCurrentPiForTests,
	getCurrentPi,
	RuntimeNotReadyError,
	StaleExtensionApiError,
	sendViaCurrentPi,
	sendViaCurrentPiWhenReady,
	setCurrentPi,
} from "../src/pi-ref.js";

// `current` is process-global by design; without this each case would inherit
// the previous one's api and quietly stop exercising the fallback.
beforeEach(__resetCurrentPiForTests);

/** Mimics pi's runtime: invalidate() poisons every subsequent call, forever. */
function fakePi(sink: string[]) {
	let stale = false;
	const staleError = () =>
		new Error(
			"This extension ctx is stale after session replacement or reload.",
		);
	const api = {
		// Real pi stubs this too, so pi-ref probes it to tell "bound" from "not".
		getActiveTools() {
			if (stale) throw staleError();
			return ["bash"];
		},
		sendUserMessage(content: string) {
			if (stale) throw staleError();
			sink.push(content);
		},
	};
	return {
		api: api as unknown as ExtensionAPI,
		poison() {
			stale = true;
		},
	};
}

/**
 * Mimics pi's loader: action methods are throwing stubs until the host binds the
 * core (`runner.bindCore`), which happens AFTER the factory has already run.
 */
function fakeUnboundPi(sink: string[]) {
	let bound = false;
	const notReady = () =>
		new Error(
			"Extension runtime not initialized. Action methods cannot be called during extension loading.",
		);
	const api = {
		// getActiveTools is itself a stub before bind, so it doubles as a probe.
		getActiveTools() {
			if (!bound) throw notReady();
			return ["bash"];
		},
		sendUserMessage(content: string) {
			if (!bound) throw notReady();
			sink.push(content);
		},
	};
	return {
		api: api as unknown as ExtensionAPI,
		bind: () => {
			bound = true;
		},
	};
}

describe("current pi resolution", () => {
	it("uses the pi handed to the latest factory invocation", () => {
		const sent: string[] = [];
		const first = fakePi(sent);
		const second = fakePi(sent);

		setCurrentPi(first.api);
		first.poison(); // /new tears the old session down
		setCurrentPi(second.api); // factory re-runs with a fresh api

		expect(() => sendViaCurrentPi("hello")).not.toThrow();
		expect(sent).toEqual(["hello"]);
	});

	it("raises a recognisable error instead of the raw SDK error while pi is mid-swap", () => {
		const sent: string[] = [];
		const pi = fakePi(sent);
		setCurrentPi(pi.api);
		pi.poison();

		// No fresh factory invocation yet: the message lands in the window where
		// the old api is dead and the new one does not exist.
		expect(() => sendViaCurrentPi("hello")).toThrow(StaleExtensionApiError);
	});

	it("does not leak the SDK error message to the user", () => {
		const sent: string[] = [];
		const pi = fakePi(sent);
		setCurrentPi(pi.api);
		pi.poison();

		try {
			sendViaCurrentPi("hello");
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(StaleExtensionApiError);
			expect((e as Error).message).not.toContain("ctx is stale");
			expect((e as Error).cause).toBeInstanceOf(Error);
		}
	});
});

/**
 * pi's loader hands the factory an api whose action methods are throwing stubs,
 * and only replaces them when the runner binds the core — which happens after
 * every extension has loaded. The IM gateway is a process-global singleton that
 * survives session replacement, so a message landing in that window reaches a
 * stub and dies with:
 *   "Extension runtime not initialized. Action methods cannot be called
 *    during extension loading."
 * The gateway cannot wait for that window: the message already arrived.
 */
function fakeLoadingPi(sink: string[], failTimes: number) {
	let remaining = failTimes;
	const api = {
		sendUserMessage(content: string) {
			if (remaining > 0) {
				remaining -= 1;
				throw new Error(
					"Extension runtime not initialized. Action methods cannot be called during extension loading.",
				);
			}
			sink.push(content);
		},
	};
	return api as unknown as ExtensionAPI;
}

/** Instant sleep over a clock only this test advances, so retries cost no time. */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

describe("waiting out the extension loading window", () => {
	it("retries and delivers the message exactly once", async () => {
		const sent: string[] = [];
		setCurrentPi(fakeLoadingPi(sent, 3));
		const clock = fakeClock();

		await sendViaCurrentPiWhenReady("hello", {
			timeoutMs: 5_000,
			now: clock.now,
			sleep: clock.sleep,
		});

		// The stub throws before it delivers anything, so retrying cannot
		// double-send. A second entry here would mean a duplicated turn.
		expect(sent).toEqual(["hello"]);
	});

	it("gives up after the budget instead of retrying forever", async () => {
		const sent: string[] = [];
		setCurrentPi(fakeLoadingPi(sent, 1_000));
		let t = 0;

		await expect(
			sendViaCurrentPiWhenReady("hello", {
				timeoutMs: 200,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			}),
		).rejects.toBeInstanceOf(RuntimeNotReadyError);

		expect(sent).toEqual([]);
	});

	it("does not retry a genuine session swap", async () => {
		const sent: string[] = [];
		const pi = fakePi(sent);
		setCurrentPi(pi.api);
		pi.poison();
		let slept = 0;

		await expect(
			sendViaCurrentPiWhenReady("hello", {
				timeoutMs: 5_000,
				now: () => 0,
				sleep: async () => {
					slept += 1;
				},
			}),
		).rejects.toBeInstanceOf(StaleExtensionApiError);

		// A swap never resolves by waiting, so retrying it would just stall the
		// user for the whole budget before saying the same thing.
		expect(slept).toBe(0);
	});

	it("does not retry an error that is neither loading nor stale", async () => {
		setCurrentPi({
			sendUserMessage() {
				throw new Error("rate limited");
			},
		} as unknown as ExtensionAPI);
		let slept = 0;

		await expect(
			sendViaCurrentPiWhenReady("hello", {
				timeoutMs: 5_000,
				now: () => 0,
				sleep: async () => {
					slept += 1;
				},
			}),
		).rejects.toThrow("rate limited");

		expect(slept).toBe(0);
	});
});

/**
 * pi binds each extension's runtime to a session AFTER the factory has run, and
 * it creates a fresh runtime per load path. So the api the factory is handed can
 * be one the host never binds at all — not merely "not bound yet".
 *
 * Publishing that api over a working one is what made the IM gateway bricked: it
 * survived every session while pointing at a dead runtime, and no amount of
 * waiting changed it.
 */
describe("a still-loading api never displaces a working one", () => {
	it("keeps delivering through the previous api", () => {
		const sent: string[] = [];
		const good = fakePi(sent);
		setCurrentPi(good.api); // adopted immediately: no probe on this fake

		// The next factory run hands us an api the host has not bound.
		setCurrentPi(fakeUnboundPi(sent).api);

		sendViaCurrentPi("hello");

		expect(sent).toEqual(["hello"]);
	});

	it("adopts the newer api once the host binds it", () => {
		const sent: string[] = [];
		const good = fakePi(sent);
		setCurrentPi(good.api);
		const newer = fakeUnboundPi(sent);
		setCurrentPi(newer.api);

		newer.bind();
		sendViaCurrentPi("second");

		// The fresh api took over: the older one is never consulted again.
		expect(sent).toEqual(["second"]);
	});

	it("retries only when there is nothing usable to fall back to", async () => {
		const sent: string[] = [];
		const newer = fakeUnboundPi(sent);
		setCurrentPi(newer.api);
		let slept = 0;

		// No previous api ever existed, so waiting is the only thing left to try.
		const done = sendViaCurrentPiWhenReady("hello", {
			timeoutMs: 200,
			now: () => 0,
			sleep: async () => {
				slept += 1;
			},
		});
		newer.bind();
		await done;

		expect(sent).toEqual(["hello"]);
		expect(slept).toBeGreaterThan(0);
	});

	it("drops a candidate the host already disposed of", () => {
		const sent: string[] = [];
		const good = fakePi(sent);
		setCurrentPi(good.api);
		const dead = fakePi(sent);
		dead.poison(); // its session was replaced before we ever saw it
		setCurrentPi(dead.api);

		// Probing it forever would be probing a corpse; drop it and carry on.
		sendViaCurrentPi("hello");

		expect(sent).toEqual(["hello"]);
	});

	it("serves /model and friends from the working api, not the dead one", () => {
		const sent: string[] = [];
		const good = fakePi(sent);
		setCurrentPi(good.api);
		setCurrentPi(fakeUnboundPi(sent).api);

		expect(() =>
			getCurrentPi().sendUserMessage("via getCurrentPi"),
		).not.toThrow();
		expect(sent).toEqual(["via getCurrentPi"]);
	});
});
