// tests/pi-bridge-events.test.ts
//
// What a turn's progress has to carry for the Feishu card's two panels: each
// thinking block once, each tool call with its args, duration and outcome —
// and nothing from a turn this bridge does not own.

import { describe, expect, it } from "vitest";
import {
	PiAgentBridge,
	type ProgressObserver,
	previewToolArgs,
	summarizeToolError,
	type ToolOutcome,
	type ToolRun,
} from "../src/pi-bridge.js";

function collector() {
	const texts: string[] = [];
	const thinking: string[] = [];
	const started: ToolRun[] = [];
	const ended: Array<{ id: string; outcome: ToolOutcome }> = [];
	const observer: ProgressObserver = {
		onText: (t) => texts.push(t),
		onThinking: (t) => thinking.push(t),
		onToolStart: (run) => started.push(run),
		onToolEnd: (id, outcome) => ended.push({ id, outcome }),
	};
	return { texts, thinking, started, ended, observer };
}

const assistant = (blocks: Record<string, unknown>[]) =>
	({ role: "assistant", content: blocks }) as unknown;

describe("thinking capture", () => {
	it("reports a streamed block once, however many chunks carry it", async () => {
		const c = collector();
		const bridge = new PiAgentBridge(async () => {
			bridge.captureStreamingMessage(
				assistant([{ type: "thinking", thinking: "先想" }]),
			);
			bridge.captureStreamingMessage(
				assistant([{ type: "thinking", thinking: "先想一" }]),
			);
			bridge.captureStreamingMessage(
				assistant([{ type: "thinking", thinking: "先想一下" }]),
			);
			bridge.captureMessage(
				assistant([
					{ type: "thinking", thinking: "先想一下" },
					{ type: "text", text: "好了" },
				]),
			);
			bridge.settle();
		});

		await bridge.run("hi", c.observer);

		// The first two deltas are real changes; the repeat that came with the
		// settled message is not, and repeating it would stack copies in the card.
		expect(c.thinking).toEqual(["先想", "先想一", "先想一下"]);
	});

	it("keeps thinking out of the returned answer", async () => {
		const bridge = new PiAgentBridge(async () => {
			bridge.captureMessage(
				assistant([{ type: "thinking", thinking: "不该出现在答复里" }]),
			);
			bridge.settle();
		});

		expect(await bridge.run("hi", collector().observer)).toBe("(空回复)");
	});
});

describe("tool capture", () => {
	it("pairs a call with its duration and outcome", async () => {
		const c = collector();
		const bridge = new PiAgentBridge(async () => {
			bridge.captureToolStart("tc-1", "bash", { command: "npm test" });
			bridge.captureToolEnd("tc-1", "exit 1", true, 4200);
			bridge.settle();
		});

		await bridge.run("hi", c.observer);

		expect(c.started).toEqual([
			{ toolCallId: "tc-1", name: "bash", argsPreview: "npm test" },
		]);
		expect(c.ended).toEqual([
			{
				id: "tc-1",
				outcome: { durationMs: 4200, isError: true, errorText: "exit 1" },
			},
		]);
	});

	it("reports no error detail for a successful call", async () => {
		const c = collector();
		const bridge = new PiAgentBridge(async () => {
			bridge.captureToolStart("tc-1", "read", { path: "a.ts" });
			bridge.captureToolEnd("tc-1", "some output", false, 30);
			bridge.settle();
		});

		await bridge.run("hi", c.observer);

		expect(c.ended[0].outcome).toEqual({ durationMs: 30, isError: false });
	});

	it("ignores an end for a call it never saw start", async () => {
		const c = collector();
		const bridge = new PiAgentBridge(async () => {
			bridge.captureToolEnd("tc-ghost", "boom", true);
			bridge.settle();
		});

		await bridge.run("hi", c.observer);

		expect(c.ended).toEqual([]);
	});

	it("ignores another session's tools while this bridge is idle", async () => {
		// pi-web runs other sessions in the same process; their tool events reach
		// this handler too, and recording them would put them in this chat's card.
		const c = collector();
		const bridge = new PiAgentBridge(async () => {});
		bridge.captureToolStart("tc-other", "bash", { command: "rm -rf /" });
		bridge.captureMessage(assistant([{ type: "text", text: "别人的回复" }]));

		expect(c.started).toEqual([]);
		expect(c.texts).toEqual([]);
	});

	it("does not carry one turn's tools into the next", async () => {
		let turn = 0;
		const c = collector();
		const bridge = new PiAgentBridge(async () => {
			turn++;
			if (turn === 1)
				bridge.captureToolStart("tc-1", "read", { path: "old.ts" });
			bridge.settle();
		});

		await bridge.run("one", c.observer);
		await bridge.run("two", c.observer);

		expect(c.started.map((t) => t.toolCallId)).toEqual(["tc-1"]);
		// The first turn's call never got an outcome, and the second turn must not
		// inherit it.
		expect(c.ended).toEqual([]);
	});
});

describe("argument previews", () => {
	it("prefers the argument a reader recognises", () => {
		expect(previewToolArgs({ command: "npm test" })).toBe("npm test");
		expect(previewToolArgs({ path: "src/app.ts" })).toBe("src/app.ts");
		expect(previewToolArgs({ file_path: "b.ts" })).toBe("b.ts");
		expect(previewToolArgs({ pattern: "TODO" })).toBe("TODO");
		expect(previewToolArgs({ query: "select 1" })).toBe("select 1");
		expect(previewToolArgs({ mode: "fast", limit: 10 })).toBe("fast");
	});

	it("keeps a row to one line", () => {
		expect(previewToolArgs({ command: "x".repeat(500) })).toHaveLength(120);
		expect(previewToolArgs({ command: "a\nb   c" })).toBe("a b c");
		expect(previewToolArgs({})).toBe("");
		expect(previewToolArgs(undefined)).toBe("");
	});
});

describe("error summaries", () => {
	it("takes the first non-empty line of whatever shape pi hands back", () => {
		expect(summarizeToolError("exit 1\nstack trace")).toBe("exit 1");
		expect(summarizeToolError({ output: "npm ERR! code E404" })).toBe(
			"npm ERR! code E404",
		);
		expect(
			summarizeToolError({
				content: [
					{ type: "image", data: "…" },
					{ type: "text", text: "no such file" },
				],
			}),
		).toBe("no such file");
	});

	it("stops at the diagnostic line rather than dumping the transcript", () => {
		expect(summarizeToolError("y".repeat(900))).toHaveLength(200);
		expect(summarizeToolError({ nothing: true })).toBe("");
	});
});
