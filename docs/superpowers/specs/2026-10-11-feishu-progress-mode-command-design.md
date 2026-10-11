# 飞书进度展示切换命令 `/feishu [card|text]` 设计规格 (Spec)

日期: 2026-10-11
状态: 待用户评审 → 通过后转 writing-plans
目标目录: `/Users/pan/Documents/Project/pi-im`

## 1. Goal

让用户不手改 `~/.pi/agent/pi-im/feishu.json` 就能在**纯文本进度**与**卡片进度**之间切换:在飞书聊天框发 `/feishu card` 或 `/feishu text`,立即生效并落盘,**不需要重启 pi / pi-web**。

现状: `progressMode` 只能在 `feishu.json` 里手写,或靠 `startFeishu` 构造 controller 时读入 (`extension.ts:969` / `extension.ts:1407`),重启网关后才生效。

## 2. 决策 (已与用户确认)

| 决策点 | 结论 |
| --- | --- |
| 命令形态 | `/feishu` (无参=查当前值) / `/feishu card` / `/feishu text` |
| 持久化 | 写盘 + 内存热更新,两者都做 |
| 生效时机 | 下一轮对话生效,进行中的这一轮不切换、不中断 |
| 渠道 | 仅飞书。Telegram 收到 `/feishu` 直接回「不支持」 |
| i18n | 新增 zh/en 文案,并进 `/help` |

## 3. Architecture

四个改动点,各自职责单一:

```
IM 文本 "/feishu card"
   │
   ├─ remote-commands.ts   KNOWN 加 "/feishu"  (面板注册的唯一事实源)
   │
   ├─ controller.ts        case "/feishu": 渠道守卫 → 查/改 → 回报
   │                        makeRenderer 读 this.opts.progressMode(每轮一次)
   │
   ├─ extension.ts         runtime hook setProgressMode: 写盘 → 再改内存
   │                        attachRuntime(c, channel) 决定写哪个 <channel>.json
   │
   └─ slash-commands.ts    PI_IM_SLASH_MANIFEST 加 "feishu" 条目(飞书 "/" 面板可见)
```

### 3.1 命令面 (`src/controller.ts` + `src/remote-commands.ts`)

- `src/remote-commands.ts`: `KNOWN` 加 `"/feishu"`。`KNOWN` 目前只被面板一致性测试消费(见 6),`parseRemoteCommand` 对未知名本来也照样返回,行为不变。
- `src/controller.ts` `handleCommand` 新增 `case "/feishu"`:
  1. **渠道守卫**:`this.opts.channelName !== "feishu"` → 回 `progressModeTgOnly`,直接 return(照 `/repair` 的 `repairUnsupportedTg` 写法)。
  2. **无参**:回 `progressModeCurrent(this.progressMode())` + `progressModeUsage`。
  3. **参数归一**:`args.trim().toLowerCase()`;不是 `"text"` / `"card"` → 回 `progressModeUsage` + 当前值。
  4. **runtime hook 缺失**:`this.runtime?.setProgressMode` 不存在 → 回 `progressModePersistFail`。**不静默成功** —— 用户在未绑定 runtime 的 controller 上切换却看到「已切换」,重启后回滚,是最难查的一类谎报。
  5. **调用 hook**:成功回 `progressModeSet(mode)`;抛错回 `progressModePersistFail(e.message)`。hook 内部抛错即写盘失败,此时内存**未**被改(见 3.3),所以报错文案成立。

### 3.2 热切换 (`src/controller.ts`)

- `ImController` 新增:
  ```ts
  setProgressMode(mode: ProgressMode): void { this.opts.progressMode = mode; }
  progressMode(): ProgressMode { return this.opts.progressMode ?? "text"; }
  ```
- `makeRenderer` 已经在**每轮**读 `this.opts.progressMode` (`controller.ts:215`),所以改内存值即对下一轮生效。
- **进行中的那一轮不切换**:它持有自己已构造好的 renderer(闭包),不回头再读 opts;不会被中途打断,不会出现「一半卡片一半文本」。这正是「下一轮生效」的落点,无需额外代码。
- 能力检查不变:`makeRenderer` 里 `progressMode === "card"` 还要求 channel 同时有 `sendCard` 与 `updateCard`。`progressMode()` 只报**配置值**,`/status` 也报配置值;「配了 card 但渠道不支持」这种情况当前只有 Telegram 会出现,而 `/feishu` 在 Telegram 上本来就拒绝,所以不存在误报。

### 3.3 持久化 (`src/extension.ts`)

- `PiRuntimeHooks` 新增:
  ```ts
  setProgressMode?: (mode: ProgressMode) => Promise<void>;
  ```
- `attachRuntime(c, channel: ChannelKind)` —— 加第二个参数。四个调用点全部更新:
  - `startTelegram` (`extension.ts:923`) → `"telegram"`
  - `startFeishu` (`extension.ts:971`) → `"feishu"`
  - `startTelegramSilent` (`extension.ts:1386`) → `"telegram"`
  - `startFeishuSilent` (`extension.ts:1409`) → `"feishu"`
- hook 实现(照 `allowlistCommand` 的形状,用现成的 `readJson` + `saveJsonAtomic`):
  ```ts
  setProgressMode: async (mode) => {
    const path = join(piImDir(), `${channel}.json`);
    const prev = await readJson<FeishuFileConfig & TelegramFileConfig>(path, {});
    await saveJsonAtomic(path, { ...prev, progressMode: mode });
    // shared 的槽位名与 ChannelKind 不同:telegram 的槽位叫 tg。
    const slot = channel === "telegram" ? shared.tg : shared.feishu;
    slot.controller?.setProgressMode(mode);
  }
  ```
- **顺序:先写盘,后改内存。** 写盘失败(只读目录、磁盘满)时抛错,内存保持旧值,`/status` 和下一轮仍报旧模式 —— 内存和磁盘永不打架。反过来(先改内存)会出现「界面显示已切换,重启后回滚」。
- 用 `slot.controller?.setProgressMode(...)` 而不是 hook 的闭包变量 `c`,与 5 处 `setAllowlist` 写法一致:以 shared 里登记的 controller 为准(启动过程中 controller 可能已被换掉)。
- 槽位名坑必须显式处理:`shared` 的键是 `feishu` 与 **`tg`**(`extension.ts:96`),而 `ChannelKind` 是 `"feishu" | "telegram"`,`shared[channel]` 会是 `undefined`。
- 落盘后**不需要**再动网关:后续 `/feishu start`(或 pi-web 重启走 `startFeishuSilent`)会从文件读到新值。

### 3.4 可见性 (`src/i18n.ts` + `src/feishu/slash-commands.ts`)

- `src/i18n.ts` 新增 6 条(zh + en 必须同时补,`Strings = typeof zh` 会强制对齐):
  | key | 含义 |
  | --- | --- |
  | `progressModeCurrent(m)` | 「当前进度展示: card(卡片)」 |
  | `progressModeUsage` | 「用法: `/feishu card` \| `/feishu text`,下一轮生效」 |
  | `progressModeSet(m)` | 「已切换到 card,下一轮对话生效」 |
  | `progressModeTgOnly` | 「该命令仅飞书支持;TG 当前固定纯文本」 |
  | `progressModePersistFail(e?)` | 「切换失败: <e>」(runtime 未挂载时无 e) |
  | `statusProgressMode(m)` | `/status` 一行:「进度展示: card」 |
- `/status`(`controller.ts:375` 起的 `/status` case)在现有行后追加 `statusProgressMode(this.progressMode())`。
- `help` 串尾加 ` /feishu [card|text]`(zh + en 两份)。
- `src/feishu/slash-commands.ts` `PI_IM_SLASH_MANIFEST` 加:
  ```ts
  { command: "feishu", default: "切换进度展示(纯文本/卡片)", en_us: "Switch progress display (text/card)", icon: "switch_outlined" }
  ```
  不加这条,飞书 `/` 面板里就看不到 `/feishu`;而且 `feishu-slash-commands.test.ts` 的「covers every non-alias command pi-im supports」断言 `manifest == KNOWN - aliases`,只改 `KNOWN` 会直接红。

## 4. Data Flow

```
用户: /feishu card
  → gateway 解 im.message.receive_v1 → InboundMessage{text:"/feishu card"}
  → controller.handleInbound: dedup → allowlist → parseRemoteCommand
  → handleCommand("/feishu", "card")
      渠道守卫(feishu ✓)→ args 归一 ✓ → runtime.setProgressMode("card")
        → readJson(feishu.json) → saveJsonAtomic({...prev, progressMode:"card"})
        → shared.feishu.controller.setProgressMode("card")
      → sendText("已切换到 card,下一轮对话生效")
下一条普通消息:
  → handleInbound → makeRenderer 读 opts.progressMode === "card"
  → 走卡片分支(SdkFeishuGateway 有 sendCard + updateCard ✓)
```

## 5. 边界与失败处理

| 场景 | 行为 |
| --- | --- |
| 无 runtime hook 的 controller | 回 `progressModePersistFail`,不谎报成功 |
| `feishu.json` 写失败 | hook 抛错 → 回失败文案;内存未变;`/status` 仍报旧值 |
| 参数非法(如 `/feishu foo`) | 回用法 + 当前值,不改任何状态 |
| Telegram 发 `/feishu card` | 回 `progressModeTgOnly`,不写 `telegram.json` |
| 正在跑的那一轮 | 继续用本轮 renderer,不中断、不半途换风格 |
| 参数大小写 | `args.trim().toLowerCase()`,`/feishu CARD` 等价 |
| TUI `/feishu card` | **不变** —— TUI 侧不认识该子参数,走 `default` 分支打印 TUI 用法。不在本次范围 |

## 6. Testing

新增 `tests/progress-mode-command.test.ts`(复用 `tests/controller-progress-mode.test.ts` 的 harness 形状):

1. `/feishu card` → 收到 `progressModeSet` 文案,且 controller 内存值变 `card`。
2. 切换后**下一轮**确实走卡片分支(`sendCard` 被调用),当前轮不受影响。
3. `/feishu`(无参)→ 回报当前值 + 用法,不调用 hook。
4. `/feishu foo` → 报用法,**不**调用 hook。
5. runtime hook 抛错 → 回报失败文案,**内存保持旧值**(证明先写盘后改内存的顺序)。
6. 无 runtime hook → 回报失败文案。
7. Telegram controller 收到 `/feishu card` → 回 `progressModeTgOnly`,hook 未被调用。
8. hook 实现(extension 层):`setProgressMode("card")` 后 `feishu.json` 里 `progressMode === "card"` 且**其余字段保留**(`appId`/`appSecret`/`allowlist` 不能被抹掉);写盘失败时抛错。
9. zh/en 文案对齐:`Strings = typeof zh`(`i18n.ts:149`)已让 `en: Strings` 在**编译期**强制补齐 zh 的每个 key,`npm run typecheck` 即断言,无需新增运行时测试。

`tests/feishu-slash-commands.test.ts` 预期变更:manifest 从 20 → 21 条。该文件已有断言会自动覆盖新增条目(「only names commands the IM controller actually handles」要求 `KNOWN` 含 `/feishu`;「covers every non-alias command」要求 manifest 含 `feishu`),无需改断言本身。

验证命令(取自 `package.json` scripts):`npm test`(vitest run)、`npm run typecheck`(tsc --noEmit)、`npm run check`(biome check . && tsc --noEmit)。

## 7. 非目标 (YAGNI)

- 卡片上放「切换展示」按钮 —— 卡片渲染层无回调通道,要做得先引入 card action 分发,收益不抵复杂度。
- Telegram 卡片模式 —— 网关本来就没有 `sendCard`/`updateCard`,`config.ts:47` 的注释已说明它是 forward-compat 占位。
- `/mode`、`/progress` 之类的别名 —— 一个功能一个名字,`/feishu` 与 TUI 同名但两个命名空间,IM 侧解析的是 `remote-commands.ts`。
- 切换后强制重发当前轮 —— 会打断正在进行的工具调用。
