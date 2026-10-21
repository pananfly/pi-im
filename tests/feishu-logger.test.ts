// tests/feishu-logger.test.ts
//
// The Lark SDK defaults to LoggerLevel.info writing straight to the global
// console, so every connection dumped "[info]: ws client ready" plus a
// multi-line "configure long connection in the developer console" banner into
// the user's TUI. We never passed loggerLevel/logger, so we inherited that.
//
// PI_IM_FEISHU_LOG raises it back for debugging; the default is "warn" so the
// SDK's own problems stay visible while its routine chatter does not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createLarkChannel, captured } = vi.hoisted(() => {
	const captured: { logger?: Record<string, unknown>; loggerLevel?: number } =
		{};
	return {
		captured,
		createLarkChannel: vi.fn((opts: Record<string, unknown>) => {
			captured.logger = opts.logger as Record<string, unknown>;
			captured.loggerLevel = opts.loggerLevel as number;
			return {
				on: vi.fn(() => () => {}),
				connect: vi.fn(async () => {}),
				disconnect: vi.fn(async () => {}),
			};
		}),
	};
});

vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
	return { ...actual, createLarkChannel };
});

const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");

async function start() {
	const gw = new SdkFeishuGateway({
		appId: "cli_x",
		appSecret: "s",
		domain: "feishu",
	});
	await gw.start();
	return gw;
}

const origEnv = process.env.PI_IM_FEISHU_LOG;
beforeEach(() => {
	delete process.env.PI_IM_FEISHU_LOG;
	captured.logger = undefined;
	captured.loggerLevel = undefined;
});

afterEach(() => {
	if (origEnv === undefined) delete process.env.PI_IM_FEISHU_LOG;
	else process.env.PI_IM_FEISHU_LOG = origEnv;
	vi.restoreAllMocks();
});

describe("feishu SDK logging", () => {
	it("quiets the SDK's routine info chatter by default", async () => {
		await start();
		// LoggerLevel.warn === 2 in the SDK's numeric enum.
		expect(captured.loggerLevel).toBe(2);
	});

	it("supplies its own logger so SDK output is tagged, not raw console noise", async () => {
		await start();
		for (const level of ["error", "warn", "info", "debug"]) {
			expect(typeof captured.logger?.[level], level).toBe("function");
		}
	});

	it("honours PI_IM_FEISHU_LOG for debugging", async () => {
		process.env.PI_IM_FEISHU_LOG = "debug";
		await start();
		// LoggerLevel.debug === 4.
		expect(captured.loggerLevel).toBe(4);
	});

	it("treats an unrecognised level as warn rather than crashing", async () => {
		process.env.PI_IM_FEISHU_LOG = "nonsense";
		await start();
		expect(captured.loggerLevel).toBe(2);
	});

	it("can silence the SDK entirely", async () => {
		process.env.PI_IM_FEISHU_LOG = "off";
		await start();
		// LoggerLevel.fatal === 0.
		expect(captured.loggerLevel).toBe(0);
	});

	it("routes SDK errors to console.error with a pi-im prefix", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await start();
		(captured.logger?.error as (...a: unknown[]) => void)("boom");
		expect(err).toHaveBeenCalled();
		expect(String(err.mock.calls[0]?.[0])).toContain("[pi-im:feishu]");
	});

	it("never throws when the SDK logs during teardown", async () => {
		await start();
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(() =>
			(captured.logger?.info as (...a: unknown[]) => void)("x"),
		).not.toThrow();
		spy.mockRestore();
	});
});
