// tests/telegram-gateway.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	shouldRespondInGroup,
	TelegramGateway,
} from "../src/telegram/gateway.js";

describe("tg group rule", () => {
	it("mention required", () => {
		expect(shouldRespondInGroup("hello", false, false)).toBe(false);
		expect(shouldRespondInGroup("@bot hello", true, false)).toBe(true);
	});
});

describe("tg gateway health", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is stopped before start", () => {
		expect(new TelegramGateway({ botToken: "t" }).getHealth().state).toBe(
			"stopped",
		);
	});

	// The poll loop retries forever, so the object outliving the outage must not
	// read as a working gateway.
	it("reports reconnecting while the API is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const gateway = new TelegramGateway({ botToken: "t" });
		await gateway.start();
		await vi.waitFor(() =>
			expect(gateway.getHealth().state).toBe("reconnecting"),
		);
		expect(gateway.getHealth().lastError).toBe("offline");
		await gateway.stop();
	});

	it("reports connected once a poll round trip lands", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: [] }),
			})),
		);
		const gateway = new TelegramGateway({ botToken: "t" });
		await gateway.start();
		await vi.waitFor(() => expect(gateway.getHealth().state).toBe("connected"));
		await gateway.stop();
		expect(gateway.getHealth().state).toBe("stopped");
	});

	it("recovers to connected after an outage", async () => {
		let fail = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				if (fail) throw new Error("offline");
				return {
					ok: true,
					status: 200,
					json: async () => ({ ok: true, result: [] }),
				};
			}),
		);
		const gateway = new TelegramGateway({ botToken: "t" });
		await gateway.start();
		await vi.waitFor(() =>
			expect(gateway.getHealth().state).toBe("reconnecting"),
		);
		fail = false;
		// The retry backoff is 3 s, so recovery cannot land inside waitFor's
		// default second.
		await vi.waitFor(
			() => expect(gateway.getHealth().state).toBe("connected"),
			{
				timeout: 6000,
			},
		);
		await gateway.stop();
	});

	// A revoked token comes back as an ordinary 401 with a parseable body, so
	// reading health off "did the round trip complete" would call it healthy and
	// pin the session alive on a bot that can never answer again.
	it("treats an HTTP error response as an outage, not a working bot", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				json: async () => ({ ok: false, description: "Unauthorized" }),
			})),
		);
		const gateway = new TelegramGateway({ botToken: "t" });
		await gateway.start();
		await vi.waitFor(() =>
			expect(gateway.getHealth().state).toBe("reconnecting"),
		);
		expect(gateway.getHealth().lastError).toContain("401");
		await gateway.stop();
	});

	// Without a floor on the success path, an API that answers instantly turns
	// the loop into a hot microtask spin: it starves the event loop and allocates
	// until the process is killed.
	it("paces the success path instead of spinning when the API answers instantly", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				calls++;
				return {
					ok: true,
					status: 200,
					json: async () => ({ ok: true, result: [] }),
				};
			}),
		);
		const gateway = new TelegramGateway({ botToken: "t" });
		await gateway.start();
		await new Promise((r) => setTimeout(r, 100));
		const afterFirstWindow = calls;
		await new Promise((r) => setTimeout(r, 100));
		await gateway.stop();
		// One poll per MIN_POLL_INTERVAL_MS floor, not thousands per window.
		expect(calls - afterFirstWindow).toBeLessThanOrEqual(2);
	});
});

describe("tg delivery failures", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	/** Bot API answers errors as HTTP 200 with `ok:false` about half the time. */
	const stubApi = (
		handler: (method: string, body: Record<string, unknown>) => unknown,
	) => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const method = String(url).split("/").pop() ?? "";
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				calls.push({ method, body });
				const result = handler(method, body);
				return {
					ok: true,
					status: 200,
					json: async () => result,
				};
			}),
		);
		return calls;
	};

	it("throws when the API answers ok:false", async () => {
		// The old code answered with Date.now() as a message id here, and that
		// bogus id then failed on editMessageText just as silently.
		stubApi(() => ({ ok: false, description: "chat not found" }));
		const gw = new TelegramGateway({ botToken: "t" });
		await expect(gw.sendText("42", "hi")).rejects.toThrow("chat not found");
	});

	it("throws on a non-2xx response too", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				json: async () => ({}),
			})),
		);
		const gw = new TelegramGateway({ botToken: "t" });
		await expect(gw.sendText("42", "hi")).rejects.toThrow("401");
	});

	it("spills an over-long answer into follow-ups instead of truncating", async () => {
		const calls = stubApi(() => ({
			ok: true,
			result: { message_id: calls.length },
		}));
		const gw = new TelegramGateway({ botToken: "t" });
		const answer = Array.from({ length: 2000 }, (_, i) => `第${i}行`).join(
			"\n",
		);
		const ids = await gw.finishText("42", "7", answer);
		expect(ids.length).toBeGreaterThan(1);
		expect(calls.filter((c) => c.method === "sendMessage").length).toBe(
			ids.length - 1,
		);
		// The tail must actually arrive, not be sliced off.
		const sent = calls
			.filter((c) => c.method === "sendMessage")
			.map((c) => String(c.body.text))
			.join("\n");
		expect(sent).toContain("第1999行");
	});

	it("falls back to a fresh send when the edit fails", async () => {
		// A placeholder can age out or be deleted mid-turn; the answer still has
		// to reach the user.
		stubApi((method) =>
			method === "editMessageText"
				? { ok: false, description: "message to edit not found" }
				: { ok: true, result: { message_id: 99 } },
		);
		const gw = new TelegramGateway({ botToken: "t" });
		const ids = await gw.finishText("42", "7", "答案");
		expect(ids).toEqual(["99"]);
	});

	it("reports a rejected upload instead of swallowing it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 413,
				json: async () => ({}),
			})),
		);
		const gw = new TelegramGateway({ botToken: "t" });
		await expect(gw.sendFile("42", Buffer.from("x"), "a.txt")).rejects.toThrow(
			"413",
		);
	});
});
