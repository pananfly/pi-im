// tests/feishu-card.test.ts
//
// The "streaming_card" presentation, modelled on dsh-im's card shell:
//
//   { schema: '2.0', header: { title: plainText(t), template: 'blue' },
//     body: { elements } }
//
// Two collapsible panels (thinking, process details) above a permanent answer
// panel, replaced in place on every update.

import { describe, expect, it } from "vitest";
import {
	buildProgressCard,
	buildProgressCards,
	countMarkdownTables,
	formatDuration,
	MAX_SPILL_CARDS,
	type ProgressState,
	type ProgressStep,
	STEP_CARD_MAX_BYTES,
	STEP_CARD_MAX_TABLES,
	visibleTools,
} from "../src/feishu/card.js";
import type { ToolRun } from "../src/pi-bridge.js";

function state(over: Partial<ProgressState> = {}): ProgressState {
	return {
		activity: "",
		tools: [],
		thinking: [],
		text: "",
		done: false,
		...over,
	};
}

function cardText(s: ProgressState): string {
	return JSON.stringify(buildProgressCard(s));
}

function panels(s: ProgressState): Record<string, unknown>[] {
	return buildProgressCard(s).body.elements.filter(
		(e): e is Record<string, unknown> =>
			typeof e === "object" &&
			e !== null &&
			(e as { tag?: string }).tag === "collapsible_panel",
	);
}

function tool(over: Partial<ToolRun> = {}): ToolRun {
	return { toolCallId: "c1", name: "read", argsPreview: "", ...over };
}

describe("feishu progress card", () => {
	it("uses the dsh-im card shell", () => {
		const card = buildProgressCard(state());
		expect(card.schema).toBe("2.0");
		expect(card.header?.template).toBe("blue");
		expect(Array.isArray(card.body.elements)).toBe(true);
	});

	it("shows queued position in the header while waiting", () => {
		expect(cardText(state({ queued: 3 }))).not.toBe(cardText(state()));
		expect(
			JSON.stringify(buildProgressCard(state({ queued: 3 })).header),
		).toContain("3");
	});

	it("puts the tool rows and the answer in separate collapsible panels", () => {
		const found = panels(
			state({ tools: [tool({ name: "bash", argsPreview: "npm test" })] }),
		);
		expect(found).toHaveLength(1);
		expect(JSON.stringify(found[0])).toContain("工具摘要");
		expect(JSON.stringify(found[0])).toContain("npm test");
		// The answer stays outside the panel: the panel is the skimmable part.
		expect(
			buildProgressCard(state({ text: "答案" })).body.elements,
		).toContainEqual({ tag: "markdown", content: "答案" });
	});

	it("renders the dsh-im panel chrome", () => {
		const [panel] = panels(state({ tools: [tool()] }));
		// Without the rotating arrow a collapsible panel reads as a static box,
		// so the user never learns it opens.
		expect((panel.header as Record<string, unknown>).icon_position).toBe(
			"right",
		);
		expect((panel.header as Record<string, unknown>).icon_expanded_angle).toBe(
			-180,
		);
		expect(panel.background_color).toBe("grey-50");
		expect(panel.border).toEqual({ color: "grey", corner_radius: "8px" });
	});

	it("uses dsh-im's panel defaults while running", () => {
		const [thinking, tools] = panels(
			state({ thinking: ["先看看代码"], tools: [tool()], text: "答案" }),
		);
		// dsh-im opens the tool summary and folds thinking while running; the
		// card is re-patched wholesale, so user expansion cannot outlive a tick
		// either way — the only choice is which default to pick.
		expect(thinking.expanded).toBe(false);
		expect(tools.expanded).toBe(true);
		expect(JSON.stringify([thinking, tools])).toContain("先看看代码");
	});

	it("folds every panel into one process-details wrapper once done", () => {
		const found = panels(
			state({ thinking: ["先看看代码"], tools: [tool()], done: true }),
		);
		// One collapsed wrapper holding the two inner panels, so a finished card
		// stays a single line tall instead of two stacked boxes.
		expect(found).toHaveLength(1);
		expect(found[0].expanded).toBe(false);
		expect(JSON.stringify(found[0].header)).toContain("过程详情");
		expect(JSON.stringify(found[0])).toContain("先看看代码");
	});

	it("tags markdown `markdown`, never `lark_md`", () => {
		// Under schema 2.0 Feishu rejects the whole card with ErrCode 200621
		// ("type of element is not supported tag: lark_md"), which is the 1.0 tag
		// dsh-im's markdown() helper emits. Verified against a live bot.
		const json = JSON.stringify(
			buildProgressCards(state({ thinking: ["想法"], text: "答案" })),
		);
		expect(json).not.toContain("lark_md");
		expect(json).toContain('"tag":"markdown"');
	});

	it("shows the streaming answer text", () => {
		expect(cardText(state({ text: "正在分析问题…" }))).toContain(
			"正在分析问题",
		);
	});

	it("gives each tool a row with its args, duration and outcome", () => {
		const body = cardText(
			state({
				activity: "bash",
				tools: [
					tool({
						toolCallId: "a",
						name: "read",
						argsPreview: "src/app.ts",
						durationMs: 1200,
					}),
					tool({
						toolCallId: "b",
						name: "bash",
						argsPreview: "npm test",
						durationMs: 4200,
					}),
				],
			}),
		);
		expect(body).toContain("src/app.ts");
		expect(body).toContain("1.2s");
		expect(body).toContain("4.2s");
		expect(body).toContain("✅");
	});

	it("marks a failure and shows its first output line, unlike a success", () => {
		const failed = cardText(
			state({
				tools: [
					tool({
						name: "bash",
						argsPreview: "npm test",
						isError: true,
						errorText: "exit 1: 3 tests failed",
					}),
				],
			}),
		);
		expect(failed).toContain("❌");
		expect(failed).toContain("exit 1: 3 tests failed");
		// A successful tool's output is not inlined: a dozen `ls` listings would
		// bury the answer the card exists to deliver.
		expect(cardText(state({ tools: [tool({ name: "bash" })] }))).not.toContain(
			"no output",
		);
	});

	it("switches the header to a finished state and drops the spinner", () => {
		const running = buildProgressCard(
			state({ activity: "read", text: "答案" }),
		);
		const done = buildProgressCard(
			state({ activity: "read", text: "答案", done: true }),
		);
		expect(running.header?.template).not.toBe(done.header?.template);
		expect(JSON.stringify(done)).toContain("答案");
	});

	it("never emits an element list with a leading separator and no content", () => {
		// An empty card renders as a blank box in Feishu; the placeholder text
		// must always be present instead.
		expect(cardText(state())).toContain("处理中");
	});

	it("keeps a failure visible when the tool list overflows", () => {
		const tools: ToolRun[] = [
			tool({
				toolCallId: "old-fail",
				name: "bash",
				isError: true,
				errorText: "boom",
			}),
			...Array.from({ length: 20 }, (_, i) =>
				tool({ toolCallId: `t${i}`, name: "read" }),
			),
		];
		const { shown, omitted } = visibleTools(tools);
		// 21 calls, 12 slots; the one failure from the cut head is pulled back,
		// so 9 - 1 calls are dropped entirely.
		expect(shown).toHaveLength(13);
		expect(shown.map((t) => t.toolCallId)).toContain("old-fail");
		expect(omitted).toBe(8);
		expect(cardText(state({ tools }))).toContain("另有 8 次工具调用");
	});

	it("keeps every card under the byte budget by spilling into extra ones", () => {
		// Feishu caps a card near 30KB and rejects the whole write past it, which
		// would freeze the card on its previous content — the tail of the answer
		// would simply never appear.
		const text = Array.from({ length: 4000 }, (_, i) => `第${i}行答`).join(
			"\n",
		);
		const built = buildProgressCards(state({ text, done: true }));
		expect(built.length).toBeGreaterThan(1);
		for (const card of built) {
			expect(
				Buffer.byteLength(JSON.stringify(card), "utf8"),
			).toBeLessThanOrEqual(STEP_CARD_MAX_BYTES);
		}
		// Nothing is dropped: the whole answer survives the split.
		const json = JSON.stringify(built);
		expect(json).toContain("第0行答");
		expect(json).toContain("第3999行答");
	});

	it("marks every card but the last as sealed history", () => {
		const built = buildProgressCards(
			state({
				text: Array.from({ length: 6000 }, (_, i) => `第${i}行`).join("\n"),
				done: true,
			}),
		);
		expect(built.length).toBeGreaterThan(1);
		expect(built.at(-1)?.header?.template).toBe("green");
		for (const card of built.slice(0, -1)) {
			expect(card.header?.template).toBe("grey");
			expect(card.header?.title.content).toContain("续");
		}
	});

	it("counts GFM tables toward Feishu's four-per-element limit", () => {
		const table = (n: number) => `| 列${n} |\n| --- |\n| 值${n} |`;
		// Five tables is the exact case dsh-im's `5` budget would have let
		// through, and the case Feishu rejects: the rich-text component takes at
		// most four.
		const five = Array.from({ length: 5 }, (_, i) => table(i + 1)).join("\n\n");
		expect(countMarkdownTables(five)).toBe(5);
		const split = buildProgressCards(state({ text: five, done: true }));
		expect(split.length).toBeGreaterThan(1);
		expect(
			Math.max(...split.map((c) => countMarkdownTables(JSON.stringify(c)))),
		).toBeLessThanOrEqual(STEP_CARD_MAX_TABLES);

		const eight = Array.from({ length: 8 }, (_, i) => table(i + 1)).join(
			"\n\n",
		);
		const built = buildProgressCards(state({ text: eight, done: true }));
		expect(built.length).toBeGreaterThan(1);
		const perCard = built.map((c) => countMarkdownTables(JSON.stringify(c)));
		expect(Math.max(...perCard)).toBeLessThanOrEqual(STEP_CARD_MAX_TABLES);
	});

	it("cuts a single line that cannot be split further", () => {
		// One line, no newline to break at: the only way under the cap is to cut
		// it, and the cut has to say so rather than look like a whole answer.
		const built = buildProgressCards(
			state({ text: "答".repeat(60_000), done: true }),
		);
		expect(built).toHaveLength(1);
		expect(
			Buffer.byteLength(JSON.stringify(built[0]), "utf8"),
		).toBeLessThanOrEqual(STEP_CARD_MAX_BYTES);
		expect(JSON.stringify(built[0])).toContain("已截断");
	});

	it("renders the English locale", () => {
		const card = buildProgressCard(
			state({ tools: [tool()], thinking: ["reasoning"], done: true }),
			"en",
		);
		const body = JSON.stringify(card);
		expect(body).toContain("Process details");
		expect(body).toContain("Thinking");
		expect(card.header?.title.content).toBe("✅ Done");
	});

	it("groups consecutive steps of the same kind into collapsible panels", () => {
		const steps: ProgressStep[] = [
			{
				kind: "tool",
				tool: tool({ toolCallId: "t1", name: "read", argsPreview: "a.ts" }),
			},
			{
				kind: "tool",
				tool: tool({ toolCallId: "t2", name: "bash", argsPreview: "ls" }),
			},
			{ kind: "thinking", text: "根据读取结果进行分析" },
			{
				kind: "tool",
				tool: tool({ toolCallId: "t3", name: "write", argsPreview: "b.ts" }),
			},
		];
		const card = buildProgressCard(
			state({ steps, text: "处理中", done: false }),
		);
		const p = card.body.elements.filter(
			(e): e is Record<string, unknown> =>
				typeof e === "object" &&
				e !== null &&
				(e as { tag?: string }).tag === "collapsible_panel",
		);
		expect(p).toHaveLength(3);
		expect((p[0].header as Record<string, unknown>).title).toEqual({
			tag: "plain_text",
			content: "🛠️ 工具摘要 · 2 次",
		});
		expect((p[1].header as Record<string, unknown>).title).toEqual({
			tag: "plain_text",
			content: "💭 思考 · 1 段",
		});
		expect((p[2].header as Record<string, unknown>).title).toEqual({
			tag: "plain_text",
			content: "🛠️ 工具摘要 · 1 次",
		});
	});

	it("appends completion note at the very bottom of the card when done", () => {
		const card = buildProgressCard(state({ text: "最终结果", done: true }));
		const lastElement = card.body.elements.at(-1);
		expect(lastElement).toEqual({ tag: "markdown", content: "---\n✅ 已完成" });
	});

	it("appends localized completion note in English locale", () => {
		const card = buildProgressCard(
			state({ text: "Final result", done: true }),
			"en",
		);
		const lastElement = card.body.elements.at(-1);
		expect(lastElement).toEqual({
			tag: "markdown",
			content: "---\n✅ Completed",
		});
	});

	it("always stays single-card during running even with large text", () => {
		const longText = "大量流式输出\n".repeat(2000);
		const cards = buildProgressCards(state({ text: longText, done: false }));
		expect(cards).toHaveLength(1);
		expect(cards[0].header?.template).toBe("blue");
	});

	it("truncates thinking text exceeding the character cap", () => {
		const hugeThinking = "很多思考内容".repeat(1000);
		const card = buildProgressCard(
			state({ thinking: [hugeThinking], done: true }),
		);
		expect(JSON.stringify(card)).toContain("已截断");
	});

	it("caps completion spill cards at MAX_SPILL_CARDS", () => {
		const massive = Array.from(
			{ length: 15_000 },
			(_, i) => `第${i}行超长输出`,
		).join("\n");
		const cards = buildProgressCards(state({ text: massive, done: true }));
		expect(cards.length).toBeLessThanOrEqual(MAX_SPILL_CARDS);
		expect(cards.length).toBe(MAX_SPILL_CARDS);
	});
});

describe("tool duration formatting", () => {
	it("hides durations too short to be meaningful", () => {
		expect(formatDuration(undefined)).toBe("");
		expect(formatDuration(0)).toBe("");
		expect(formatDuration(99)).toBe("");
	});

	it("scales the unit as the call gets longer", () => {
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(600_000)).toBe("10m");
		expect(formatDuration(3_725_000)).toBe("1h 2m");
	});
});
