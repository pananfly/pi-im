# 飞书进度展示切换命令 `/feishu [card|text]` 实现计划

**For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在飞书聊天框发 `/feishu card` / `/feishu text` 即切换进度展示形态,立即写盘并热更新内存,下一轮对话生效,不必手改 `feishu.json`、不必重启 pi / pi-web。

**Architecture:** 控制器侧新增 `/feishu` 命令分支 + 三个只读/只写访问器;`makeRenderer` 本来就每轮读 `this.opts.progressMode`,所以改内存即"下一轮生效",进行中的那一轮持有自己的 renderer 闭包,自然不受影响。落盘由 `PiRuntimeHooks.setProgressMode` 在扩展侧完成,顺序是**先写盘后改内存**。命令名同时进 `remote-commands.KNOWN` 与飞书 `/` 面板 manifest。

**Tech Stack:** TypeScript (ESM, `.js` import 后缀)、Node 22+、vitest、biome、飞书 OpenAPI v7 斜杠命令面板。

Spec: [docs/superpowers/specs/2026-10-11-feishu-progress-mode-command-design.md](../specs/2026-10-11-feishu-progress-mode-command-design.md)

## Global Constraints

- 工作目录: `/Users/pan/Documents/Project/pi-im`(单包,git 仓库)。
- 缩进用 **Tab**(仓库现有风格),格式化由 `npm run check` 里的 biome 兜底。
- ESM:所有相对 import 必须带 `.js` 后缀,即使源文件是 `.ts`。
- 新增 i18n 键必须 **zh 和 en 同时补**:`src/i18n.ts:149` 的 `export type Strings = typeof zh` 让 `const en: Strings` 在编译期强制对齐,漏一个就 typecheck 报错。
- 不要触碰 `dist/`(构建产物)。
- 验证命令(取自 `package.json` scripts,没有 `lint` 这个 script):
  - `npm test` → `vitest run`
  - `npm run typecheck` → `tsc --noEmit`
  - `npm run check` → `biome check . && tsc --noEmit`

### 工作区状态(执行前必读,否则会提交掉不属于本任务的改动)

工作区**当前是脏的**,而且脏的正是本计划要改的那些文件:

- `src/controller.ts`(+309/-…)、`src/extension.ts`(+677)、`src/i18n.ts`(+101)、`src/remote-commands.ts`、`README.md`、`src/config.ts`、`src/core/types.ts`、`src/feishu/gateway.ts`、`src/telegram/gateway.ts`、`src/pi-bridge.ts`、`src/liveness.ts`、`src/commands.ts`、`package.json`、`package-lock.json` 等 **19 个文件、约 +4111/-2010 行**的既有未提交改动。
- `src/feishu/slash-commands.ts`、`src/feishu/card.ts`、`src/pi-ref.ts` 以及 20 多个测试文件是 **untracked**(从未提交过)。
- 换句话说:`progressMode` 卡片、斜杠命令面板、`pi-ref.ts` 这些本功能所依赖的基础设施,**全部还在工作区里没进 git 历史**。

基线已验证(2026-10-11):`npm test` → **36 files / 218 tests passed**,`npm run typecheck` 无错。任何一步跑出红,先怀疑是不是自己改坏的,而不是基线本来就坏。

**因此:本计划的两个 Task 都不自动提交。** 除非用户明确要求,不要执行 `git commit`;即使被要求,也不能 `git add <file>` 整文件 —— 那会把上面 4000+ 行既有改动一并卷进来(例如 `git add src/feishu/slash-commands.ts` 会首次提交那个 325 行的新文件)。用户想提交时,先问他怎么处理这批既有 WIP。

### 与 spec 的一处有意偏离(必须知道,否则会写错)

Spec 3.3 写的是 `attachRuntime(c, channel: ChannelKind)` 加必填第二参数。**实际实现改成不改签名**:在 `ImController` 上加一个 `channelName()` 访问器,让 hook 自己 `const channel = c.channelName()`。

原因:仓库里另有 **6 个测试文件、10 处** 调用 `attachRuntime(c)`(`tests/pi-web-switch.test.ts:150`、`tests/auto-adopt.test.ts:180,222,246`、`tests/history-entries.test.ts:91`、`tests/preferred-model.test.ts:296`、`tests/thinking-level.test.ts:125`、`tests/runtime-stale-pi.test.ts:96,112,128`),外加 `src/extension.ts` 里 4 处生产调用点。加必填参数会让这 6 个测试文件全部 typecheck 失败,纯属无关改动。`channelName()` 方案零改动、不引入隐藏默认值,且和 spec 的意图(按渠道决定写哪个 json)完全一致。

---

## File Structure

| 文件 | 改动 | 单一职责 |
| --- | --- | --- |
| `src/controller.ts` | 改 | 命令面:解析 `/feishu`、渠道守卫、回报文案;`progressMode()` / `setProgressMode()` / `channelName()` 三个访问器;`/status` 加一行 |
| `src/i18n.ts` | 改 | 6 条新文案(zh + en)+ `help` 串加 `/feishu [card|text]` |
| `src/remote-commands.ts` | 改 | `KNOWN` 加 `"/feishu"`(面板一致性的事实源) |
| `src/feishu/slash-commands.ts` | 改 | manifest 加 `feishu` 条目,飞书 `/` 面板可见 |
| `src/extension.ts` | 改 | `PiRuntimeHooks.setProgressMode` 实现:先写盘后改内存 |
| `README.md` | 改 | 命令表 + `progressMode` 字段说明 |
| `tests/progress-mode-command.test.ts` | 新建 | 控制器侧行为(含"下一轮生效""本轮不换风格") |
| `tests/progress-mode-persist.test.ts` | 新建 | 落盘行为(保留其它字段、失败不改内存、按渠道选文件) |

**Task 边界**:`KNOWN` 与 manifest 必须在同一个 task 里改 —— `tests/feishu-slash-commands.test.ts:267` 的断言是 `manifest.sort() === (KNOWN - aliases).sort()`,只改一边会让 `npm test` 在 task 结束处变红。

---

## Task 1: 控制器侧 —— `/feishu` 命令、热切换访问器、文案

**Files:**
- Modify: `src/controller.ts`(`PiRuntimeHooks` 约 33–60 行;`setLocale` 约 87 行后加访问器;`/status` case 约 375–405 行;`case "/session"` 之后、`default:` 之前加新 case)
- Modify: `src/i18n.ts`(`// models` 之前插 zh 组;`en` 里 `modelsEmpty` 之前插 en 组;两处 `help` 串尾)
- Modify: `src/remote-commands.ts:32` 之后
- Modify: `src/feishu/slash-commands.ts`(`PI_IM_SLASH_MANIFEST` 数组末尾,`clear` 条目之后)
- Modify: `README.md:20`、`README.md:51`
- Test: `tests/progress-mode-command.test.ts`(新建)

**Interfaces:**
- Consumes:本任务无前置依赖。
- Produces(供 Task 2 使用):
  - `ImController.progressMode(): ProgressMode`
  - `ImController.setProgressMode(mode: ProgressMode): void`
  - `ImController.channelName(): string`
  - `PiRuntimeHooks.setProgressMode?: (mode: ProgressMode) => Promise<void>`

- [ ] **Step 1: 写失败测试 —— 新建 `tests/progress-mode-command.test.ts`**

```ts
// tests/progress-mode-command.test.ts
//
// /feishu card | /feishu text switches how a running turn is rendered, without
// hand-editing feishu.json and without restarting pi or pi-web.
//
// The switch deliberately lands on the NEXT turn: makeRenderer builds one
// renderer per turn and that renderer closes over its own state, so a turn in
// flight finishes in the style it started in. A mid-turn style swap is what
// would produce "half a card, half a plain message".

import { describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import type { ChannelLike, InboundMessage } from "../src/core/types.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

function harness(opts?: {
	progressMode?: "text" | "card";
	channelName?: string;
	failWrite?: boolean;
}) {
	const text: string[] = [];
	const edits: string[] = [];
	const cards: Record<string, unknown>[] = [];
	const patches: Record<string, unknown>[] = [];
	const calls: string[] = [];

	const channel = {
		async sendText(_c: string, t: string) {
			text.push(t);
			return `mid-${text.length}`;
		},
		// Text mode finishes by editing the placeholder in place, so the answer
		// lands in `edits`, never in `text`. A harness that only records
		// sendText would silently lose it.
		async editText(_c: string, _m: string, t: string) {
			edits.push(t);
		},
		async sendCard(_c: string, card: Record<string, unknown>) {
			cards.push(card);
			return `mid-card-${cards.length}`;
		},
		async updateCard(_m: string, card: Record<string, unknown>) {
			patches.push(card);
		},
	} as unknown as ChannelLike;

	const bridge = new PiAgentBridge(async () => {});
	const c = new ImController(channel, bridge, {
		allowlist: ["u1"],
		channelName: opts?.channelName ?? "feishu",
		progressMode: opts?.progressMode ?? "text",
	});

	// Stands in for the extension hook, including its write-then-apply order:
	// a failing write must leave the live mode alone.
	c.runtime = {
		setProgressMode: async (mode) => {
			calls.push(mode);
			if (opts?.failWrite) throw new Error("EACCES: read-only file system");
			c.setProgressMode(mode);
		},
	};

	return { c, text, edits, cards, patches, calls, bridge };
}

/** messageId must differ per message or the deduper eats the second one. */
function msg(text: string): InboundMessage {
	return {
		messageId: text,
		chatId: "c1",
		chatType: "p2p",
		senderId: "u1",
		text,
		timestampMs: Date.now(),
	};
}

/** Drive one real turn: tool call + streamed text, then settle. */
async function runTurn(bridge: PiAgentBridge, done: Promise<void>) {
	await new Promise((r) => setTimeout(r, 5));
	bridge.captureToolStart("tc-1", "bash", { command: "npm test" });
	bridge.captureToolEnd(
		"tc-1",
		{ content: [{ type: "text", text: "ok" }] },
		false,
		1200,
	);
	bridge.captureMessage({
		role: "assistant",
		content: [{ type: "text", text: "中间输出" }],
	} as never);
	bridge.settle();
	await done;
}

describe("/feishu progress mode", () => {
	it("switches to card and says so", async () => {
		const { c, text, calls } = harness();

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual(["card"]);
		expect(text.join("\n")).toMatch(/card/);
	});

	it("switches back to plain text", async () => {
		const { c, calls } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/feishu text"));

		expect(calls).toEqual(["text"]);
	});

	it("accepts any casing and surrounding space", async () => {
		const { c, calls } = harness();

		await c.handleInbound(msg("/feishu   CARD  "));

		expect(calls).toEqual(["card"]);
	});

	it("reports the current mode and usage when called with no argument", async () => {
		const { c, text, calls } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/feishu"));

		expect(calls).toEqual([]);
		const body = text.join("\n");
		expect(body).toMatch(/card/);
		expect(body).toMatch(/\/feishu card/);
	});

	it("refuses an unknown argument without touching anything", async () => {
		const { c, text, calls } = harness();

		await c.handleInbound(msg("/feishu foo"));

		expect(calls).toEqual([]);
		expect(text.join("\n")).toMatch(/\/feishu card/);
	});

	it("reports a failed save instead of claiming success", async () => {
		const { c, text, calls } = harness({ failWrite: true });

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual(["card"]);
		expect(text.join("\n")).toMatch(/EACCES/);
		expect(text.join("\n")).not.toMatch(/下一轮/);
	});

	it("refuses rather than lying when nothing can persist the choice", async () => {
		const { c, text } = harness();
		c.runtime = undefined;

		await c.handleInbound(msg("/feishu card"));

		// Silently succeeding here is the worst outcome: the switch would be
		// reported as done and undone by the next restart.
		expect(text.join("\n")).not.toMatch(/下一轮/);
	});

	it("uses cards from the next turn after the switch", async () => {
		const { c, cards, bridge } = harness();

		await c.handleInbound(msg("/feishu card"));
		await runTurn(bridge, c.handleInbound(msg("干活")));

		expect(cards.length).toBe(1);
	});

	it("lets the turn in flight finish in the style it started in", async () => {
		const { c, edits, cards, bridge } = harness();

		// A turn starts in text mode, then the switch lands while it runs.
		const running = c.handleInbound(msg("干活"));
		await new Promise((r) => setTimeout(r, 5));
		await c.handleInbound(msg("/feishu card"));
		await runTurn(bridge, running);

		// That turn must not turn into a card halfway through.
		expect(cards).toHaveLength(0);
		expect(edits.join("\n")).toContain("中间输出");

		// The one after it does use the card.
		await runTurn(bridge, c.handleInbound(msg("再干活"));
		expect(cards.length).toBe(1);
	});

	it("refuses on Telegram, where there is no card surface at all", async () => {
		const { c, text, calls } = harness({ channelName: "telegram" });

		await c.handleInbound(msg("/feishu card"));

		expect(calls).toEqual([]);
		expect(text.join("\n")).toMatch(/飞书/);
	});

	it("shows the configured mode in /status", async () => {
		const { c, text } = harness({ progressMode: "card" });

		await c.handleInbound(msg("/status"));

		expect(text.join("\n")).toMatch(/card/);
	});

	it("reports the channel it serves, for the hook's file choice", () => {
		expect(harness({ channelName: "telegram" }).c.channelName()).toBe(
			"telegram",
		);
		expect(harness().c.channelName()).toBe("feishu");
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/progress-mode-command.test.ts`

Expected: FAIL。`ImController.progressMode` / `setProgressMode` / `channelName` 不存在(`TypeError`),`/feishu` 落到 `default:` 分支回 `cmdFallback`,三条文案断言随之失败。

- [ ] **Step 3: 加 i18n 文案(zh + en)**

`src/i18n.ts`,zh 对象里在 `// models` 注释之前插入:

```ts
	// progress mode
	progressModeCurrent: (m: string) => `当前进度展示: ${m}`,
	progressModeUsage: "用法: /feishu card | /feishu text,下一轮对话生效。",
	progressModeSet: (m: string) => `已切换到 ${m},下一轮对话生效。`,
	progressModeTgOnly: "该命令仅飞书支持;TG 固定纯文本。",
	progressModePersistFail: (e?: string) =>
		e ? `切换失败: ${e}` : "切换失败:本地会话尚未就绪,无法保存配置。",
	statusProgressMode: (m: string) => `进度展示: ${m}`,
```

`src/i18n.ts`,`en` 对象里在 `modelsEmpty:` 之前插入(必须与 zh 同名同签名):

```ts
	// progress mode
	progressModeCurrent: (m: string) => `Progress display: ${m}`,
	progressModeUsage: "Usage: /feishu card | /feishu text, takes effect next turn.",
	progressModeSet: (m: string) => `Switched to ${m}, takes effect next turn.`,
	progressModeTgOnly: "Feishu only; Telegram is always plain text.",
	progressModePersistFail: (e?: string) =>
		e
			? `Switch failed: ${e}`
			: "Switch failed: local session not ready, cannot save the config.",
	statusProgressMode: (m: string) => `Progress display: ${m}`,
```

- [ ] **Step 4: `help` 串加 `/feishu [card|text]`**

`src/i18n.ts` zh 的 `help`(约 146 行)结尾改成:

```ts
	help: "/help /status /version /new /stop /steer <文本> /compact /history [N] /models /model [序号|ID] /thinking [ID] (/reasoning) /workspace <路径|序号> (/ws) /wsl /sessionlist (/sessions) /session <ID|序号> /batch /send /cancel /repair /clear /feishu [card|text]",
```

`src/i18n.ts` en 的 `help`(约 280 行)结尾改成:

```ts
	help: "/help /status /version /new /stop /steer <text> /compact /history [N] /models /model [number|ID] /thinking [ID] (/reasoning) /workspace <path|number> (/ws) /wsl /sessionlist (/sessions) /session <ID|number> /batch /send /cancel /repair /clear /feishu [card|text]",
```

- [ ] **Step 5: 加控制器访问器**

`src/controller.ts`,在 `setLocale()` 方法之后(`setAllowlist()` 之前)插入:

```ts
	/** The channel this controller answers for: "feishu" or "telegram". */
	channelName(): string {
		return this.opts.channelName;
	}
	/**
	 * Flip the progress presentation for the NEXT turn.
	 *
	 * A turn in flight already holds its own renderer closure, so it finishes in
	 * the style it started in — no answer that is half a card and half a plain
	 * message. makeRenderer re-reads this on every turn.
	 */
	setProgressMode(mode: ProgressMode): void {
		this.opts.progressMode = mode;
	}
	/**
	 * The CONFIGURED mode, not the effective one: a channel without both
	 * sendCard and updateCard silently falls back to text in makeRenderer.
	 */
	progressMode(): ProgressMode {
		return this.opts.progressMode ?? "text";
	}
```

- [ ] **Step 6: 在 `PiRuntimeHooks` 上声明 hook**

`src/controller.ts` 的 `PiRuntimeHooks` 里,`switchSession?: ...` 之后插入:

```ts
	/**
	 * Persist a progress-mode change, then apply it to the live controller.
	 *
	 * Optional: a controller built without the extension attached (tests, or a
	 * direct embed) has nowhere to write, and must be told so rather than left
	 * to report a switch that the next restart undoes.
	 */
	setProgressMode?: (mode: ProgressMode) => Promise<void>;
```

- [ ] **Step 7: `/status` 追加一行**

`src/controller.ts` 的 `/status` case,把 `lines` 数组改成:

```ts
				const lines = [
					`${s.statusVersion}/${this.opts.channelName}`,
					s.statusConn,
					s.statusQueue(this.queue.size),
					s.statusProgressMode(this.progressMode()),
				];
```

- [ ] **Step 8: 加 `/feishu` 命令分支**

`src/controller.ts`,在 `case "/session":` 分支之后、`default:` 之前插入:

```ts
			case "/feishu": {
				// Telegram's gateway has no sendCard at all, so a switch there is
				// a no-op the user cannot see. Say so instead of taking the tap.
				if (this.opts.channelName !== "feishu") {
					await this.channel.sendText(m.chatId, s.progressModeTgOnly);
					return;
				}
				const want = args.trim().toLowerCase();
				if (!want) {
					await this.channel.sendText(
						m.chatId,
						`${s.progressModeCurrent(this.progressMode())}\n${s.progressModeUsage}`,
					);
					return;
				}
				if (want !== "text" && want !== "card") {
					await this.channel.sendText(
						m.chatId,
						`${s.progressModeUsage}\n${s.progressModeCurrent(this.progressMode())}`,
					);
					return;
				}
				// No hook means nowhere to persist it. Reporting "switched" here
				// is the one lie the user would only discover after a restart.
				if (!this.runtime?.setProgressMode) {
					await this.channel.sendText(m.chatId, s.progressModePersistFail());
					return;
				}
				try {
					await this.runtime.setProgressMode(want);
					await this.channel.sendText(m.chatId, s.progressModeSet(want));
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						s.progressModePersistFail(
							e instanceof Error ? e.message : String(e),
						),
					);
				}
				return;
			}
```

- [ ] **Step 9: `KNOWN` 加 `/feishu`**

`src/remote-commands.ts`,在 `KNOWN` 数组 `"/clear",` 之后、`];` 之前插入 `"/feishu",`。

- [ ] **Step 10: manifest 加 `feishu` 条目**

`src/feishu/slash-commands.ts` 的 `PI_IM_SLASH_MANIFEST`,在 `clear` 条目之后插入:

```ts
	{
		command: "feishu",
		default: "查看或切换进度展示(纯文本/卡片)",
		en_us: "Show or switch progress display (text/card)",
	},
```

**故意不写 `icon`**:`DEFAULT_ICON`(`ai-agent_outlined`)是已经在用的安全值,而自造一个没在真实 API 上验证过的 `icon_key`(比如 `switch_outlined`)有渲染失败的风险 —— 一个命令图标不值得整条面板条目挂掉。

- [ ] **Step 11: 更新 README**

`README.md:20` 那一行改成:

```
| `progressMode` | `text`(默认,原地编辑纯文本)或 `card`(交互卡片,见下);也可在飞书里发 `/feishu card` / `/feishu text` 切换,无需重启 |
```

`README.md:51` 结尾改成:

```
`/session <ID|序号>` `/batch` `/send` `/cancel` `/repair` `/clear` `/feishu [card|text]`
```

- [ ] **Step 12: 跑测试确认通过**

Run: `npx vitest run tests/progress-mode-command.test.ts tests/feishu-slash-commands.test.ts`

Expected: 两个文件全部 PASS。`feishu-slash-commands.test.ts` 的 manifest 一致性断言(`only names commands the IM controller actually handles`、`covers every non-alias command pi-im supports`)在 `KNOWN` 与 manifest 同步改过之后自然通过。

- [ ] **Step 13: 全量验证**

Run: `npm test && npm run typecheck`

Expected: 全部测试 PASS,typecheck 无错。

- [ ] **Step 14: 汇报,不要提交**

本任务不执行 `git commit`(理由见 Global Constraints 的「工作区状态」)。向用户汇报:改了哪些文件、`npm test` 从 218 → N 通过,并提醒他工作区里仍有 19 个文件的既有 WIP 未提交、其中包含本功能依赖的 `src/feishu/slash-commands.ts`(untracked)。

---

## Task 2: 扩展侧 —— 落盘 + 热更新

**Files:**
- Modify: `src/extension.ts`(`attachRuntime` 的 runtime 对象字面量,`switchSession` 之后、`};`(约 889 行)之前)
- Test: `tests/progress-mode-persist.test.ts`(新建)

**Interfaces:**
- Consumes(Task 1 产出):`ImController.channelName(): string`、`ImController.setProgressMode(mode: ProgressMode): void`、`PiRuntimeHooks.setProgressMode?: (mode: ProgressMode) => Promise<void>`。
- Produces:`runtime.setProgressMode(mode)` —— 先把 `progressMode` 写进 `~/.pi/agent/pi-im/<channel>.json`(保留其它字段),再 `shared` 槽位里的 controller 应用到内存。

- [ ] **Step 1: 写失败测试 —— 新建 `tests/progress-mode-persist.test.ts`**

```ts
// tests/progress-mode-persist.test.ts
//
// The switch has to survive a restart, so it is written to feishu.json before
// the live mode is touched. The order matters: a failed write must leave the
// running mode alone, or /status would advertise a switch a restart undoes.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelLike } from "../src/core/types.js";
import { ImController } from "../src/controller.js";
import { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-im-pmode-"));
	process.env.PI_IM_DIR = dir;
});

afterEach(() => {
	delete process.env.PI_IM_DIR;
});

function controller(channelName: string) {
	const c = new ImController(
		{
			async sendText() {
				return "m";
			},
			async editText() {},
		} as unknown as ChannelLike,
		new PiAgentBridge(async () => {}),
		{ allowlist: [], channelName, progressMode: "text" },
	);
	attachRuntime(c);
	return c;
}

/**
 * The gateway publishes the live controller in the shared slot; the hook reads
 * that slot rather than closing over the controller it was attached to. Call
 * only after controller(), which is what creates the shared state.
 */
function publish(channelName: string, c: ImController) {
	const shared = (
		globalThis as Record<string, unknown>
	).__piImShared__ as {
		feishu: { controller: ImController | null };
		tg: { controller: ImController | null };
	};
	(channelName === "telegram" ? shared.tg : shared.feishu).controller = c;
}

async function readJson(name: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(dir, name), "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

describe("/feishu card persistence", () => {
	it("writes the mode and applies it to the live controller", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x", allowlist: ["u1"] }),
		);
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("card");

		expect(await readJson("feishu.json")).toEqual({
			appId: "cli_x",
			allowlist: ["u1"],
			progressMode: "card",
		});
		expect(c.progressMode()).toBe("card");
	});

	it("writes text back without touching the credentials", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x", appSecret: "s" }),
		);
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("text");

		expect(await readJson("feishu.json")).toEqual({
			appId: "cli_x",
			appSecret: "s",
			progressMode: "text",
		});
	});

	it("creates the config file when there is none yet", async () => {
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("card");

		expect((await readJson("feishu.json")).progressMode).toBe("card");
	});

	it("keeps the live mode when the write fails", async () => {
		// A directory where the file belongs: saveJsonAtomic's rename onto it
		// fails, which is the closest portable stand-in for a read-only volume.
		await mkdir(join(dir, "feishu.json"));
		await writeFile(join(dir, "feishu.json", "blocker"), "x");
		const c = controller("feishu");
		publish("feishu", c);

		await expect(c.runtime?.setProgressMode?.("card")).rejects.toThrow();

		expect(c.progressMode()).toBe("text");
	});

	it("writes telegram.json for a Telegram controller and leaves feishu.json alone", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x" }),
		);
		const c = controller("telegram");
		publish("telegram", c);

		await c.runtime?.setProgressMode?.("card");

		// Proves the slot lookup: the shared keys are `feishu` and `tg`, so a
		// naive shared[channel] would be undefined and silently skip this.
		expect(c.progressMode()).toBe("card");
		expect((await readJson("telegram.json")).progressMode).toBe("card");
		expect(await readJson("feishu.json")).toEqual({ appId: "cli_x" });
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/progress-mode-persist.test.ts`

Expected: FAIL。`TypeError: c.runtime?.setProgressMode is not a function` —— Task 1 只声明了 hook 的类型,还没有实现。

- [ ] **Step 3: 实现 hook**

`src/extension.ts`,在 `switchSession: async (arg: string) => { ... },` 之后、`};` 之前插入:

```ts
		setProgressMode: async (mode) => {
			// The controller already knows its channel, so the file name follows
			// from it instead of from a second attachRuntime() parameter.
			const channel = c.channelName();
			const path = join(piImDir(), `${channel}.json`);
			const prev = await readJson<FeishuFileConfig & TelegramFileConfig>(
				path,
				{},
			);
			// Disk first, memory second. A failed write must leave the live mode
			// untouched, so /status never advertises a switch a restart undoes.
			await saveJsonAtomic(path, { ...prev, progressMode: mode });
			// Read the shared slot rather than closing over `c`: the gateway may
			// have swapped in a newer controller, and setAllowlist already relies
			// on the slot being the authority.
			// The key is `tg`, not `telegram` — shared[channel] would be undefined.
			const slot = channel === "telegram" ? shared.tg : shared.feishu;
			slot.controller?.setProgressMode(mode);
		},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/progress-mode-persist.test.ts`

Expected: 5 passed。

- [ ] **Step 5: 全量验证**

Run: `npm test && npm run typecheck && npm run check`

Expected: 测试全绿;typecheck 无错;biome 无格式/静态问题(若 biome 报格式,跑 `npx biome check --write .` 再重跑本步)。

- [ ] **Step 6: 汇报,不要提交**

同 Task 1 Step 14:不执行 `git commit`。`src/extension.ts` 本身就带着 +677 行既有未提交改动,任何 `git add src/extension.ts` 都会把它们一并提交。

---

## 执行结束后的最终验证

Run: `npm test && npm run check`

Expected: 全绿;测试数从基线 218 增加到 **218 + 12(Task 1 的 12 条)+ 5(Task 2 的 5 条)= 235**。若数目不同,说明有测试被误删或未跑到。

---

## Self-Review

**1. Spec 覆盖**

| Spec 小节 | 对应步骤 |
| --- | --- |
| 2(决策表) | Task 1 Step 7/8(命令形态、下一轮生效)、Task 2 Step 3(写盘+热更新)、Task 1 Step 8(仅飞书渠道)、Task 1 Step 3/4(i18n) |
| 3.1 命令面 | Task 1 Step 8、Step 9 |
| 3.2 热切换 | Task 1 Step 5、Step 6;行为由 Step 1 的"下一轮生效""本轮不换风格"两条测试锁住 |
| 3.3 持久化 | Task 2 Step 3(先写盘后改内存、`tg` 槽位映射、写 `<channel>.json`)。**签名改为 `channelName()`,偏离已在 Global Constraints 说明** |
| 3.4 可见性 | Task 1 Step 3(i18n)/Step 4(help)/Step 7(`/status`)/Step 10(manifest)/Step 11(README) |
| 4 Data Flow | 端到端由 Task 1 的 harness(hook 调用 `c.setProgressMode`)+ Task 2 的落盘测试共同覆盖 |
| 5 边界表 | 逐行对应:无 hook→Step 8 的 `!this.runtime?.setProgressMode`;写失败→Step 8 catch + Task 2 Step 1 的 `keeps the live mode when the write fails`;非法参数→Step 8;TG→Step 8 + Task 2 的 telegram 落盘测试;本轮不换风格→Task 1 的 mid-turn 测试;大小写→Step 8 的 `toLowerCase()` + Task 1 的 casing 测试;TUI 不变→计划未触碰 `handleTuiCommand`,符合 |
| 6 Testing 1–7 | Task 1 Step 1 逐条覆盖 |
| 6 Testing 8 | Task 2 Step 1(保留字段、无文件时创建、写失败、渠道映射) |
| 6 Testing 9 | 无需测试:`Strings = typeof zh` 编译期强制;`npm run typecheck` 即断言 |
| 7 非目标 | 计划未引入 card action 分发、Telegram 卡片、命令别名、强制重发当前轮 |

**2. Placeholder 扫描**:无 TBD / TODO / "类似 Task N" / 无代码的代码步骤。所有代码步骤都给了可直接粘贴的完整代码。

**3. 类型一致性核对**
- `ProgressMode` 来自 `src/core/types.ts:109`,`export type ProgressMode = "text" | "card"`;`ImController` 已 import(第 8 行)。
- `progressModePersistFail(e?: string)` 在 zh/en 两侧签名一致,`Strings = typeof zh` 锁住。
- harness 里 `c.runtime = { setProgressMode: async (mode) => {...} }` 的 `mode` 由接口推导为 `ProgressMode`,`calls.push(mode)` 得到 `string[]`。
- Task 2 测试里 `c.runtime?.setProgressMode?.("card")` 参数为字面量 `"card"`,可赋给 `ProgressMode`。
- `attachRuntime` 签名**未改**,6 个既有测试文件 / 10 处调用不受影响。
- `readJson<FeishuFileConfig & TelegramFileConfig>(path, {})`:两个类型字段全可选,`{}` 可赋值。

**已知取舍(不修,已在计划里说明)**:`publish()` 直接写 `globalThis.__piImShared__`。这是仓里唯一能拿到该单例的入口(未导出),`tests/preferred-model.test.ts` 等也用 `PI_IM_DIR` + 真实扩展工厂的同一路子。若将来 `SharedState` 被导出,应改为导入。