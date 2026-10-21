// tests/feishu-log-filter.test.ts
//
// The SDK's EventDispatcher warns for every event type it has no handler for:
//
//   invoke(data) { if (handles.has(type)) {...} else logger.warn(`no ${type} handle`) }
//
// Feishu pushes whatever the app subscribed to, so enumerating the harmless ones
// (a blacklist) is the wrong default: the next subscribed event warns again.
// Invert it — pi-im declares the events whose loss must stay visible, and the
// logger drops "no <other> handle" by default.
//
// The SDK hands us a single array, not spread strings (LoggerProxy.warn does
// `this.logger.warn(msg)`), which is why raw output looked like
// "[warn]: L'no im.message.message_read_v1 handle'". The filter has to cope with
// that shape or it silently never matches.

import { afterEach, describe, expect, it, vi } from "vitest";

type SdkLogger = {
	warn: (...a: unknown[]) => void;
	error: (...a: unknown[]) => void;
};

/** Exactly how SDK LoggerProxy forwards: one array argument, not spread. */
function sdkWarn(logger: SdkLogger | undefined, message: string): void {
	logger?.warn([message]);
}

/** Boot a gateway with the SDK mocked out, and hand back the logger it got. */
async function boot(
	logLevel?: string,
): Promise<{ logger: SdkLogger | undefined; mod: Record<string, unknown> }> {
	vi.resetModules();
	if (logLevel === undefined) delete process.env.PI_IM_FEISHU_LOG;
	else process.env.PI_IM_FEISHU_LOG = logLevel;

	let captured: SdkLogger | undefined;
	vi.doMock("@larksuiteoapi/node-sdk", async () => ({
		...(await vi.importActual<Record<string, unknown>>(
			"@larksuiteoapi/node-sdk",
		)),
		createLarkChannel: (opts: { logger: SdkLogger }) => {
			captured = opts.logger;
			return {
				on: () => () => undefined,
				connect: async () => undefined,
				disconnect: async () => undefined,
				fetchBotIdentity: async () => ({ openId: "ou_bot" }),
				sender: {
					send: async () => ({ messageId: "mid-1" }),
					editMessage: async () => undefined,
				},
			};
		},
	}));

	const gatewayModule = await import("../src/feishu/gateway.js");
	const { SdkFeishuGateway } = gatewayModule;
	await new SdkFeishuGateway({
		appId: "cli_x",
		appSecret: "s",
		domain: "feishu",
	}).start();
	return { logger: captured, mod: gatewayModule };
}

/** Console text emitted, ignoring the "[pi-im:feishu]" tag argument. */
function captureConsole(): {
	warn: ReturnType<typeof vi.spyOn>;
	error: ReturnType<typeof vi.spyOn>;
	lines: () => string[];
} {
	const lines: string[] = [];
	const record = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	const warn = vi.spyOn(console, "warn").mockImplementation(record);
	const error = vi.spyOn(console, "error").mockImplementation(record);
	return {
		warn,
		error,
		lines: () => lines.map((l) => l.replace("[pi-im:feishu]", "").trim()),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_IM_FEISHU_LOG;
});

describe("SDK 'no handle' log filtering", () => {
	it("stays quiet for subscribed events pi-im does not use", async () => {
		const { logger } = await boot();
		const c = captureConsole();

		sdkWarn(logger, "no im.message.message_read_v1 handle");
		sdkWarn(logger, "no im.chat.access_event.bot_p2p_chat_entered_v1 handle");

		expect(c.lines()).toEqual([]);
	});

	it("keeps the warn when a REQUIRED event loses its handler", async () => {
		const { logger } = await boot();
		const c = captureConsole();

		// If im.message.receive_v1 ever stops being handled the bot goes blind.
		// This is the one warning the inversion must never swallow.
		sdkWarn(logger, "no im.message.receive_v1 handle");

		expect(c.lines().join()).toContain("im.message.receive_v1");
	});

	it("silences event types it has never seen before", async () => {
		const { logger } = await boot();
		const c = captureConsole();

		// Forward compatibility: whatever Feishu subscribes next costs nothing.
		sdkWarn(logger, "no im.some.brand_new_event_v9 handle");
		sdkWarn(logger, "no drive.notice.future_thing_v1 handle");

		expect(c.lines()).toEqual([]);
	});

	it("never filters warnings that are not about a missing handler", async () => {
		const { logger } = await boot();
		const c = captureConsole();

		sdkWarn(logger, "response not include app ticket");
		sdkWarn(logger, "ws client connect timeout");

		expect(c.lines()).toHaveLength(2);
	});

	it("passes the raw stream through when the log level is debug", async () => {
		const { logger } = await boot("debug");
		const c = captureConsole();

		// Explicitly debugging the SDK: verbatim, filtering or not.
		sdkWarn(logger, "no im.message.message_read_v1 handle");

		expect(c.lines().join()).toContain("im.message.message_read_v1");
	});

	it("treats unknown levels as warn, so filtering stays on", async () => {
		const { logger } = await boot("bogus");
		const c = captureConsole();

		sdkWarn(logger, "no im.message.message_read_v1 handle");

		expect(c.lines()).toEqual([]);
	});

	it("keeps SDK errors visible regardless of filtering", async () => {
		const { logger } = await boot();
		const c = captureConsole();

		logger?.error(["bot identity lookup failed"]);

		expect(c.lines().join()).toContain("bot identity");
	});

	it("declares the events pi-im actually depends on", async () => {
		// Anything listed here becomes a warning pi-im refuses to hide.
		const { mod } = await boot();
		expect(mod.REQUIRED_LARK_EVENTS).toContain("im.message.receive_v1");
	});
});
