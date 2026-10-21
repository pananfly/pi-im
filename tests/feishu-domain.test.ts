// tests/feishu-domain.test.ts
//
// Regression cover for the Feishu gateway failing to connect:
//
//   Error: 飞书操作失败: could not resolve bot identity via
//   /open-apis/bot/v3/info — required for channel to function
//
// The SDK's formatDomain() switches on a *numeric* enum:
//
//   Domain[Domain["Feishu"] = 0] = "Feishu";
//   Domain[Domain["Lark"]   = 1] = "Lark";
//     -> default: return domain;   // anything unrecognised is passed through
//
// pi-im passed the string "feishu". It matched neither case, so it fell through
// to `default` and the literal string became the axios baseURL, producing
// 'feishu/open-apis/...' -> ERR_INVALID_URL. fetchBotIdentity() only needs that
// one token, so the real cause (a malformed URL) never appeared in the error
// the user saw — the SDK's classifier rewrote it as a bot-identity problem.

import { Domain } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the spy has to be hoisted with it.
const { createLarkChannel } = vi.hoisted(() => ({
	createLarkChannel: vi.fn((_opts: { domain?: unknown }) => ({
		on: () => {},
		connect: () => Promise.resolve(),
		fetchBotIdentity: () =>
			Promise.resolve({ openId: "ou_x", name: "Ai辅助机器人" }),
		disconnect: () => Promise.resolve(),
	})),
}));

// Keep the real module — especially the real `Domain` enum — so this test
// pins against the shipped SDK rather than a mock that could drift with it.
vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
	return { ...actual, createLarkChannel };
});

const { SdkFeishuGateway } = await import("../src/feishu/gateway.js");

function optsFor(domain: "feishu" | "lark") {
	return { appId: "cli_x", appSecret: "s", domain };
}

function domainPassed(): unknown {
	return createLarkChannel.mock.calls[0]?.[0]?.domain;
}

beforeEach(() => {
	createLarkChannel.mockClear();
});

describe("feishu gateway domain", () => {
	it("passes the SDK's Domain.Feishu enum, not the string 'feishu'", async () => {
		await new SdkFeishuGateway(optsFor("feishu")).start();

		expect(domainPassed()).toBe(Domain.Feishu);
		expect(typeof domainPassed()).not.toBe("string");
	});

	it("passes the SDK's Domain.Lark enum for the lark domain", async () => {
		await new SdkFeishuGateway(optsFor("lark")).start();

		expect(domainPassed()).toBe(Domain.Lark);
		expect(typeof domainPassed()).not.toBe("string");
	});

	// formatDomain() falls through to `default: return domain` for anything it
	// does not recognise, which is exactly how the broken URL was produced.
	it("passes a value formatDomain() actually recognises", async () => {
		await new SdkFeishuGateway(optsFor("feishu")).start();

		const passed = domainPassed();
		const recognised = passed === Domain.Feishu || passed === Domain.Lark;
		expect(recognised).toBe(true);
	});
});
