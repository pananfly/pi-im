# pi-im 设计规格 (Spec)

日期: 2026-10-10
状态: 待用户评审 → 通过后转 writing-plans
目标目录: `/Users/pan/Documents/Project/pi-im` (包名 `pi-im`)

## 1. Goal

在 Pi 上复刻 `dsh-im` (xmanrui/dsh-im) 的飞书 + Telegram 接入效果:同一套语义功能在飞书和 TG 聊天框可用,但按 Pi 扩展机制重适配——前台 `pi` 进程常驻、共享主会话、TUI 同屏可见实时进度,而不是 dsh-im 的 headless Harness + 订阅结果模式。

## 2. Architecture

单包双通道,前台常驻,共享主会话(方案一锁定)。

```
pi-im/
  package.json          # name: pi-im, pi.extensions: ./dist/extension.js
  src/extension.ts      # export default (pi: ExtensionAPI), session_start 自启动
  src/core/             # types.ts, queue.ts, dedup.ts, router.ts, renderer.ts
  src/feishu/gateway.ts # Lark SDK WebSocket + 卡片流
  src/telegram/gateway.ts # Bot API getUpdates + send/editMessage
  src/controller.ts     # 双通道编排:鉴权/去重/排队/命令快速通道
  src/pi-bridge.ts      # sendUserMessage + on(message_end/tool_*/agent_settled)
  src/commands.ts       # TUI /feishu /tg
  src/remote-commands.ts # IM 聊天框 19 命令
  src/config.ts         # ~/.pi/agent/pi-im/*.json 读写 (0600)
```

为什么只能语义对齐、不能代码直移(实证):

- dsh-im 飞书 `bridge.mjs 6485 行`巨石 + `TextHarnessBridge 1672 行` + `HarnessClient 2273 行`,强依赖 DSH `typertGateway/sessionController/workspaceController/credentials/webServer`(plugin-src/host)。Pi 扩展内无这些,必须换成 `ExtensionAPI + globalThis.__shared__ + 文件`。
- TG 在 dsh-im 仅 `telegram-bridge 81 行`继承基类,重活在 `telegram-runtime 1467 行`。Pi 上同理:两通道只差 gateway,controller/pi-bridge 照抄。
- 样例 `@hwj123weijian/pi-feishu@0.12.1/src/extension.ts:480,504,636` 已验证: `pi.on("session_start") + shouldAutoStartFeishu(PI_FEISHU_AUTO_START) + globalThis.__piFeishuSharedState__` 跨 `/new` 存活。pi-im 照抄此模式,扩展到双通道。

## 3. 常驻与自启动 (已确认, 2026-10-10 修订: pi-web 常驻代替 TUI 常驻)

- 形态: A. `pi-web` server 进程常驻 (代替 TUI `pi` 前台常驻)。不做 launchd 守护 (V2 可选项),不用群 `pi -p` 子进程 (样例为隔离群上下文才用,本项目明确不要隔离)。TUI `pi` 下同样可加载扩展,但主场景是 pi-web。
- 原理 (实证 agegr/pi-web): 扩展只能活在 `AgentSession` 里 (`lib/rpc-manager.ts:createAgentSessionFromServices`, 默认加载用户 packages);server 启动本身不建会话;闲置会话 10 分钟自动回收 (`PI_WEB_IDLE_TIMEOUT_MS` 默认 600000, `rpc-manager.ts:655`),但扩展可用 `globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")].register({name, sessionId, isActive})` 阻止回收 (`lib/session-liveness.ts`, README Extension Session Liveness 节)。
- Holder 会话约定: 固定一个 holder (如 `~/.pi/agent/pi-im/holder.json` 记录 sessionId, cwd = 默认工作区)。首次在 pi-web 里打开一次 holder 后扩展自启动网关 + `register liveness (isActive = 网关运行中)`。此后关浏览器也不死,server 进程不退不断线;网关单例挂 `globalThis`,其它会话只跳过 `start` 避免双连接。
- 自启动 (`extension.ts`):
  ```ts
  pi.on("session_start", async (_, ctx) => {
    if (shouldAutoStart("feishu")) await feishuController.start(process.env);
    if (shouldAutoStart("tg")) await tgController.start(process.env);
    registerPiWebLivenessIfAvailable(sessionId); // 有 registry 才注册, TUI 下无操作
  });
  ```
- `shouldAutoStart = feishu.json/telegram.json { autoStart: true } || PI_IM_AUTO_START=1`,默认 `true`,开箱即上线。凭据缺失时只 `ui.notify("执行 /feishu setup")`,不抛错。
- 重启缺口 (用户已接受): server 重启杀掉一切,IM 离线直到 holder 被重建。V1 用预热脚本补,不改 pi-web 代码:
  - `scripts/pi-web-warmup.mjs` (Node,跨平台,Windows 无需 Git Bash): `fetch POST /api/agent/new { cwd: holderCwd, type: "ensure_session" }` → 触发 `session_start` → 自启动 + liveness。支持 `--port/--hostname/--password` 参数读 `PI_WEB_*` 环境变量,轮询等 `Ready` 后执行,失败 exit 1。
  - PowerShell `Invoke-RestMethod` 一行作为备选写进 README,主推 Node 脚本 (避开 `curl` 别名坑)。
  - 开机自启: macOS launchd / Linux systemd / Windows 任务计划程序跑 `pi-web + node warmup`。重启到预热成功之间几十秒 IM 离线,真 7×24 无缝需方案 B 独立进程 (V2)。
- `switchingSession` 标志:扩展发起的 switch/newSession 期间的 `session_shutdown` 不得取消正在等待的 IM 轮次 (样例 `:531-537` 实证)。

## 4. 会话路由 (无隔离、全局共享)

- 默认工作区 = holder/TUI 会话启动时的 `process.cwd()` (跟 `pi` 启动目录走,不是写死的 `~/.dsh/im`;实证样例 `controller.ts:224`)。IM 消息 → `pi.sendUserMessage(prompt)` 进当前 holder/主会话,pi-web/TUI 同屏可见。不做 per-chat 会话映射,不做 `/conv`。
- 并发:全局串行队列 (`SerialMessageQueue`),一次一轮,排队时回 `排队第 N 位` tip + `❌` 取消语义。
- 切换命令是全局生效 (与 dsh-im per-chat 绑定有差异,用户已接受):
  - `/workspace <绝对路径|序号>` (别名 `/ws`) 切全局 cwd,影响所有聊天 + holder/TUI。
  - `/wsl` (别名 `/workspacelist /workspaces`) 列历史:来源 `config.json workspaces[]` + 已绑定目录,当前排首位标 current。`/workspace N` 按序号切;`/workspace /绝对路径` 手写亦可,只接受已存在绝对目录,成功后自动记入 `workspaces[]` 下次可见;首次进新目录需过 project-trust (已绑定目录自动放行)。
  - `/session <ID|序号>` 绑定已有 session;`/sessionlist` (别名 `/sessions`) 列当前工作区 sessions;`/new` 解绑,下一条普通消息建新会话 (运行中需先 `/stop`)。
- `/stop` 只停本轮 (保留历史,可重复);`/steer <文本>` 运行中追加指令,不开新任务。

## 5. 通道差异 (同语义、不同渲染,用户已接受)

- 触发策略 (沿用 dsh-im):私聊直回,群聊仅 @ 当前 Bot 才回。白名单默认空 = 开放,配在 `feishu.json/telegram.json { allowlist[] }`,以后主动收紧。
- 进度渲染接口 `ProgressRenderer`,两实现:
  - 飞书:可编辑进度卡 (500ms/120 字节流,样例 `gateway.ts stream()`) + `tool_execution_start/end → onActivity` + `message_end → onText` + `agent_settled → settle`。
  - TG:占位消息 `sendMessage → editMessage` 展示进度,富文本不支持时回退纯文本,避免 Android Draft 占发送入口 (dsh-im TG 策略)。
- 图片双向 + 文件回传:飞书需 scope 体检 (`im:message:readonly` 下载图片文件 + `im:resource` 上传,缺失走 `/repair`);TG 用 `sendPhoto/sendDocument`,单图 30MB/每消息 20 张对齐 dsh-im,模型副本压到 5MB/总计 20MB。
- 去重: `message_id` 落盘 48h + 12h TTL FIFO;过期消息过滤 30min。

## 6. 命令清单 (锁定范围)

TUI 侧 (电脑前输入,只管连接):

- `/feishu start|stop|status|config|logout` (+ `setup|help` 对齐样例)
- `/tg start|stop|status|config|logout` (+ `setup|help`)

IM 聊天框 (飞书/TG 两端一致,参照 dsh-im `docs/bot-commands.md` 裁剪,共 19):

`/help /status /version /new /stop /steer /compact /history [N] /models /model [序号|完整ID] [thinking] /thinking [序号|ID]` (别名 `/reasoning`) `/workspace <绝对路径|序号>` (别名 `/ws`) `/wsl /sessionlist (/sessions) /session <ID|序号> /batch /send /cancel /repair [qr|status|verify|cancel] /clear`

- `/batch /send /cancel` 仅私聊,纯文本暂存 ≤10 条。
- `/repair` 仅飞书私聊有效 (补 `card.action.trigger/im:message:readonly/im:resource/app_slash_command:read/write`),TG 下回"不支持"。
- `/clear` 若 Pi API 不支持则明确回"未支持" (参照 dsh-im 降级)。
- V1 砍掉: `/presetlist /preset` (Pi 无 Agent Preset)、`/permission` (Pi 无档位体系)、`/conv` (无隔离不需要)、语音转写+语音回复、飞书斜杠面板/审批卡、扫码建应用、多机器人 (每通道最多 1 个)。

## 7. 配置

- 路径: `~/.pi/agent/pi-im/{config.json,feishu.json,telegram.json}`,0600,原子写 (tmp + rename)。
- `feishu.json { appId, appSecret, domain(feishu|lark), autoStart, allowlist[] }`, `telegram.json { botToken, autoStart, allowlist[] }`。白名单默认空 = 开放。
- Env 覆盖: `FEISHU_APP_ID/SECRET`, `TELEGRAM_BOT_TOKEN`, `PI_IM_AUTO_START`。用户指定 `~/.pi/agent/pi-im` 目录保存,凭据只落本地,不回传。

## 8. 错误处理

- 超时补发简化版: pending 超时后只补 final 文本,不重放 tool 调用,明确失败最多 3 次,不确定时停不再试 (对齐 dsh-im `deferred-delivery.md` 语义的最小实现)。
- 断线/重启:进程退出丢 pending,重启后不自动重放 (V1);去重文件保证重启不重复处理。
- 启动时 scope 体检 + `/repair` 增量补全链接/二维码;`/model /thinking` 运行中拒绝并提示先 `/stop`。
- 路径校验: `/workspace` 只接受已存在绝对目录,失败回用法。

## 9. 测试

- 单测 (vitest): core 排队/去重/截断/batch 收集用 fake gateway,不碰真 API。
- 联调:用用户自己的飞书应用 + TG Bot 手测 (私聊直回、群 @ 回、`/new /stop /model /workspace /session`、图片双向、超时补发)。
- `npm run check (biome + tsc --noEmit)` 门禁。

## 10. 非目标 (V2)

语音、斜杠面板/审批卡、扫码建应用、多机器人、企业微信/钉钉等其余渠道、launchd 守护 + RPC 常驻 Agent。
