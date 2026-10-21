// tests/feishu-parse.test.ts
//
// 一个真实事故的回归测试:用户在飞书里回 "2",机器人一声不响。
// 原因是 "2" 本身是合法 JSON —— `JSON.parse("2")` 成功、取 `.text` 得到
// undefined,文本被当成空串,整条消息在解析层就被丢了。
// 序号回复是最常见的输入,所以这条通道必须钉死。

import { describe, expect, it } from "vitest";
import { toInboundMessageForTests } from "../src/feishu/gateway.js";

const event = (content: unknown, extra: Record<string, unknown> = {}) => ({
	messageId: "om_1",
	chatId: "oc_1",
	chatType: "p2p",
	senderId: "ou_1",
	content,
	rawContentType: "text",
	createTime: 1792535891548,
	...extra,
});

const textOf = (content: unknown, extra?: Record<string, unknown>) =>
	toInboundMessageForTests(event(content, extra))?.text;

describe("feishu pickText", () => {
	it("keeps bare-JSON scalars, which is exactly how digits arrive", () => {
		for (const body of ["1", "2", "5", "0", "true", "false", "null"]) {
			expect(textOf(body)).toBe(body);
		}
	});

	it("unwraps the JSON-wrapped text form", () => {
		expect(textOf('{"text":"2"}')).toBe("2");
		expect(textOf('{"text":"继续之前的提问"}')).toBe("继续之前的提问");
	});

	it("keeps ordinary prose", () => {
		expect(textOf("继续之前的提问")).toBe("继续之前的提问");
		expect(textOf("/status")).toBe("/status");
		expect(textOf("怎么选?{不确定}")).toBe("怎么选?{不确定}");
	});

	it("still returns null for content that carries no prompt text", () => {
		// 图片/富文本内容的 content 是结构化 JSON,没有 text 字段。
		expect(toInboundMessageForTests(event('{"image_key":"img_v2_abc"}'))).toBe(
			null,
		);
		expect(toInboundMessageForTests(event(""))).toBe(null);
	});

	it("keeps the rest of the message intact", () => {
		const m = toInboundMessageForTests(event("2"));
		expect(m).toMatchObject({
			messageId: "om_1",
			chatId: "oc_1",
			chatType: "p2p",
			senderId: "ou_1",
			text: "2",
			mentionBot: false,
			timestampMs: 1792535891548,
		});
	});
});
