// tests/ui-bridge-shared-state.test.ts
//
// 宿主会重新求值扩展模块(切工作区、开新会话都会),于是本模块会有两份实例,
// 各自持有一份模块级状态。曾经的现场:提问写进新的那份 pending,回答却到旧的
// 那份里查,回复序号后机器人一声不响——既不确认,也不继续。
//
// 这里用 `vi.resetModules()` + 重新 import 复现"两份实例",钉住状态必须共享。

import { beforeEach, describe, expect, it, vi } from "vitest";

function turn(sent: string[]) {
	return {
		channel: "feishu",
		chatId: "c1",
		send: async (_chatId: string, text: string) => {
			sent.push(text);
		},
		locale: () => "zh" as const,
	};
}

beforeEach(() => {
	// 每例都从干净的全局状态开始,避免实例间互相污染。
	delete (globalThis as Record<string, unknown>).__piImUiBridgeState__;
	vi.resetModules();
});

describe("ui bridge state across module instances", () => {
	it("an answer from a re-evaluated module resolves a question asked by the old one", async () => {
		const first = await import("../src/ui-bridge.js");
		const sent: string[] = [];
		const ui = {
			custom: vi.fn((..._args: unknown[]) => "panel"),
			select: vi.fn((..._args: unknown[]) => "native-select"),
			confirm: vi.fn((..._args: unknown[]) => false),
			input: vi.fn((..._args: unknown[]) => "native-input"),
			editor: vi.fn((..._args: unknown[]) => "native-editor"),
		};
		first.installImUiBridge(ui, "interactive", true);

		const answer = first.runAsImTurn(turn(sent), async () =>
			ui.select("技术栈选哪个?", [
				"Python",
				"TypeScript / Node.js",
				"Kotlin / Java",
				"由你推荐",
			]),
		);
		// 问题确实转成了 IM 消息,而不是落到原生对话框上。
		await Promise.resolve();
		expect(sent.join("\n")).toContain("技术栈选哪个?");

		// 宿主重新求值扩展:清掉模块注册表再 import,拿到的就是新的一份实例。
		vi.resetModules();
		const second = await import("../src/ui-bridge.js");
		expect(second.hasPendingUiPrompt).not.toBe(first.hasPendingUiPrompt);

		// 关键:旧实例挂起的提问,新实例看得见、答得上。
		expect(second.hasPendingUiPrompt("feishu", "c1")).toBe(true);
		expect(
			second.consumeUiAnswer("feishu", "c1", "2", "zh", async () => undefined),
		).toBe(true);
		await expect(answer).resolves.toBe("TypeScript / Node.js");
		expect(second.hasPendingUiPrompt("feishu", "c1")).toBe(false);
	});

	it("custom text typed into one instance reaches the next question of the other", async () => {
		const first = await import("../src/ui-bridge.js");
		const sent: string[] = [];
		const ui = {
			custom: vi.fn((..._args: unknown[]) => "panel"),
			select: vi.fn((..._args: unknown[]) => "native-select"),
			confirm: vi.fn((..._args: unknown[]) => false),
			input: vi.fn((..._args: unknown[]) => "native-input"),
			editor: vi.fn((..._args: unknown[]) => "native-editor"),
		};
		first.installImUiBridge(ui, "interactive", true);

		// 选择里没有这个选项,于是它成为"自定义答案"。
		const chosen = first.runAsImTurn(turn(sent), async () =>
			ui.select("技术栈选哪个?", [
				"Python",
				"TypeScript / Node.js",
				"✏️ Type custom response...",
			]),
		);
		await Promise.resolve();
		expect(
			first.consumeUiAnswer(
				"feishu",
				"c1",
				"Rust",
				"zh",
				async () => undefined,
			),
		).toBe(true);
		await expect(chosen).resolves.toBe("✏️ Type custom response...");

		// 新实例接手的下一个 input 直接拿到刚才那段文字,不再重复追问。
		vi.resetModules();
		const second = await import("../src/ui-bridge.js");
		expect(second.consumeUiAnswer).not.toBe(first.consumeUiAnswer);
		await expect(
			second.runAsImTurn(turn(sent), async () => ui.input("技术栈?", "")),
		).resolves.toBe("Rust");
	});
});
