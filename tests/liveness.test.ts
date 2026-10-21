// tests/liveness.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CHANNEL_HEALTH_GRACE_MS,
	isChannelHealthy,
} from "../src/core/types.js";
import { livenessKey, registerPiWebLiveness } from "../src/liveness.js";

type Registered = {
	name: string;
	sessionId: string;
	sessionFile?: string;
	isActive: () => boolean;
};

function stubRegistry() {
	const registered: Registered[] = [];
	const symbol = Symbol.for(livenessKey());
	(globalThis as Record<PropertyKey, unknown>)[symbol] = {
		version: 1,
		register: (p: Registered) => {
			registered.push(p);
			return () => {
				registered.splice(registered.indexOf(p), 1);
			};
		},
	};
	return registered;
}

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for(livenessKey())
	];
	vi.restoreAllMocks();
});

describe("liveness", () => {
	it("key stable", () => {
		expect(livenessKey()).toBe("@agegr/pi-web/session-liveness/v1");
	});

	it("registers with the real session id, not a placeholder", () => {
		const registered = stubRegistry();
		registerPiWebLiveness({
			sessionId: "0199-abc",
			sessionFile: "/tmp/s.jsonl",
			isActive: () => true,
		});
		expect(registered).toHaveLength(1);
		expect(registered[0].sessionId).toBe("0199-abc");
		expect(registered[0].sessionFile).toBe("/tmp/s.jsonl");
	});

	// pi-web's validateProvider() throws on an empty sessionId, and that throw
	// would escape into our session_start handler.
	it("falls back to the session file when the manager has no id", () => {
		const registered = stubRegistry();
		registerPiWebLiveness({
			sessionId: "",
			sessionFile: "/tmp/s.jsonl",
			isActive: () => true,
		});
		expect(registered).toHaveLength(1);
		expect(registered[0].sessionId).toBe("/tmp/s.jsonl");
	});

	it("declines to register with no identity at all", () => {
		const registered = stubRegistry();
		registerPiWebLiveness({ sessionId: "", isActive: () => true });
		expect(registered).toHaveLength(0);
	});

	it("no-ops when pi-web is not hosting", () => {
		expect(() =>
			registerPiWebLiveness({ sessionId: "s", isActive: () => true }),
		).not.toThrow();
	});

	it("releases through pi-web's disposer", () => {
		const registered = stubRegistry();
		const release = registerPiWebLiveness({
			sessionId: "s",
			isActive: () => true,
		});
		expect(registered).toHaveLength(1);
		release();
		expect(registered).toHaveLength(0);
	});
});

describe("isChannelHealthy", () => {
	const now = 1_000_000;

	it("treats a channel that cannot report as healthy", () => {
		// It is running; inventing an outage would shut down working sessions.
		expect(isChannelHealthy(undefined, now)).toBe(true);
	});

	it("is unhealthy once stopped", () => {
		expect(
			isChannelHealthy(
				{ state: "stopped", lastOkAtMs: now, lastErrorAtMs: 0 },
				now,
			),
		).toBe(false);
	});

	it("is healthy while connected", () => {
		expect(
			isChannelHealthy(
				{ state: "connected", lastOkAtMs: 0, lastErrorAtMs: now },
				now,
			),
		).toBe(true);
	});

	it("rides out a short reconnecting blip", () => {
		expect(
			isChannelHealthy(
				{ state: "reconnecting", lastOkAtMs: 0, lastErrorAtMs: now - 1_000 },
				now,
			),
		).toBe(true);
	});

	// Both transports retry forever, so an outage never resolves on its own.
	it("gives up once the outage outlasts the grace window", () => {
		expect(
			isChannelHealthy(
				{
					state: "reconnecting",
					lastOkAtMs: 0,
					lastErrorAtMs: now - CHANNEL_HEALTH_GRACE_MS,
				},
				now,
			),
		).toBe(false);
	});
});
