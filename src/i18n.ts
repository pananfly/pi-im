// src/i18n.ts — user-visible strings, default zh. Command names stay English.

import { piImVersion } from "./config.js";

export type Locale = "zh" | "en";

export function resolveLocale(
	env: NodeJS.ProcessEnv,
	file: { locale?: string },
): Locale {
	const raw = (env.PI_IM_LOCALE ?? file.locale ?? "zh").toLowerCase();
	if (raw.startsWith("en")) return "en";
	return "zh";
}

const zh = {
	// progress
	progressWorking: "收到,处理中…",
	progressQueued: (pos: number) => `排队第${pos}位…`,
	// progress card
	cardDone: "✅ 完成",
	cardQueued: (pos: number) => `⏳ 排队第 ${pos} 位…`,
	cardWorking: "🤖",
	cardWorkingBusy: "🤖 处理中…",
	cardTask: "⚙️ 任务过程",
	cardTaskMore: "⚙️ 任务过程（续）",
	cardDetails: "📋 过程详情",
	cardThinking: "💭 思考",
	cardThinkingCount: (n: number) => `💭 思考 · ${n} 段`,
	cardThinkingPart: (n: number) => `第 ${n} 段`,
	cardProcess: (n: number) => `🛠️ 工具摘要 · ${n} 次`,
	cardToolsOmitted: (n: number) => `… 另有 ${n} 次工具调用`,
	cardTruncated: "…(内容过长已截断)",
	cardNoReply: "_(无回复)_",
	cardCompletedNote: "✅ 已完成",
	// batch
	batchStart:
		"批量输入已开启,后续纯文字将暂存最多10条,/send 提交,/cancel 取消。",
	batchIdle: "未进入批量输入模式。",
	batchFull: "已收录10条,请 /send 提交。",
	batchCollected: (n: number) =>
		n >= 10 ? "已收录第10条,请 /send 提交。" : `已收录第${n}条。`,
	batchCancelled: "已取消。",
	batchNone: "无批量任务。",
	batchEmpty: "(空批量)",
	batchDmOnly: "仅私聊可用。",
	// status
	statusVersion: `pi-im ${piImVersion()}`,
	statusConn: "连接: 运行中",
	statusQueue: (n: number) => `队列: ${n}`,
	statusCwd: (d: string) => `工作区: ${d}`,
	statusSession: (f: string | undefined) => `会话: ${f ?? "(下一条消息新建)"}`,
	statusModel: (m: string) => `模型: ${m}`,
	statusThinking: (t: string) => `思考: ${t}`,
	statusContext: (p: number) => `上下文: ${Math.round(p)}%`,
	statusRunning: (r: boolean) => `运行: ${r ? "运行中" : "空闲"}`,
	// generic commands
	newDone: "已新建 Pi 会话。",
	newFail: "新建会话未完成。",
	newUnbound: "已解绑,下一条普通消息将建新会话。",
	stopDone: "已发送中止信号。",
	steerUsage: "用法:/steer <补充指令>",
	steerMerged: "已并入当前任务。",
	steerQueued: (t: string) => `已收到 steer,将在下一轮生效:${t.slice(0, 200)}`,
	compactDone: "已开始压缩上下文。",
	clearUnsupported: "当前 Pi 未支持 /clear,会话不变",
	repairUnsupportedTg: "TG 不支持 /repair。",
	repairFeishuHint: "请在设置页补全 scope 后重试。",
	// progress mode
	progressModeCurrent: (m: string) => `当前进度展示: ${m}`,
	progressModeUsage: "用法: /feishu card | /feishu text,下一轮对话生效。",
	progressModeSet: (m: string) => `已切换到 ${m},下一轮对话生效。`,
	progressModeTgOnly: "该命令仅飞书支持;TG 固定纯文本。",
	progressModePersistFail: (e?: string) =>
		e ? `切换失败: ${e}` : "切换失败:本地会话尚未就绪,无法保存配置。",
	statusProgressMode: (m: string) => `进度展示: ${m}`,
	// models
	modelsEmpty: "暂无可用模型信息(本地暂未就绪,稍后再试)。",
	modelsList: (n: number) => `可用模型(共${n}个):`,
	modelsHint: "用 /model <序号|ID> 切换。",
	modelCurrent: (m: string, t?: string) =>
		`当前模型: ${m}${t ? `\n思考: ${t}` : ""}`,
	modelUnknown: "当前模型未知。",
	modelBusy: "任务运行中,请等待完成或先 /stop。",
	modelSwitched: (name: string, id: string) => `已切换模型: ${name} (${id})`,
	modelSwitchedPlain: "切换完成。",
	modelSwitchFail: (e: string) => `切换模型失败: ${e}`,
	modelIndexOut: (q: string) => `序号 ${q} 超出范围,先 /models 查看。`,
	modelNotFound: (q: string) => `未找到匹配"${q}"的模型。`,
	modelAmbiguous: (q: string) => `"${q}"匹配到多个模型,请用完整 ID。`,
	modelNotInCatalog: "模型不在本地目录中,无法切换。",
	modelNoKey: "模型缺少可用的 API Key。",
	modelNoSession: "本地会话尚未就绪。",
	// thinking
	thinkingLevels: (levels: string): string => `可用: ${levels}`,
	thinkingLevelsUnknown: "可用档位未知(本地会话尚未就绪)。",
	thinkingExample: "示例: /thinking high",
	thinkingCurrent: (c: string) => `当前思考档位: ${c}`,
	thinkingUnknown: "当前思考档位未知。",
	thinkingSwitched: (l: string): string => `已切换思考档位: ${l}。`,
	thinkingClamped: (asked: string, got: string, avail?: string): string =>
		`当前模型不支持 ${asked},已改为 ${got}${avail ? `。可用: ${avail}` : ""}。`,
	thinkingNoSession: "本地会话尚未就绪,无法设置思考档位。",
	thinkingBad: (a: string, avail?: string): string =>
		`无法设置思考档位"${a}"${avail ? `。可用: ${avail}` : ""}`,
	// history / workspace / session
	historyEmpty: "暂无可显示的历史(尚无绑定会话或历史为空)。",
	wslEmpty: "工作区: (暂无记录)\n用 /workspace <绝对路径> 添加。",
	wslTitle: "工作区:",
	wslCurrent: " (当前)",
	wslHint: "用 /workspace <序号|绝对路径> 切换。",
	workspaceUsage: "用法: /workspace <绝对路径|序号>",
	workspaceFail: (e: string) =>
		`切换工作区失败: ${e}\n用法: /workspace <绝对路径|序号>`,
	workspaceIndexOut: (q: string) => `序号 ${q} 超出范围,先 /wsl 查看。`,
	workspaceNotDir: (d: string) => `目录不存在或不是文件夹: ${d}`,
	workspaceSwitched: (d: string) =>
		`已切换全局工作区: ${d}\n(与 TUI 同进程,后续消息与工具调用都在此目录。)`,
	workspaceSwitchedWithSession: (d: string, title: string) =>
		`已切换全局工作区: ${d}\n已绑定该目录最新会话: ${title}\n后续消息与工具调用都在此目录。`,
	workspaceNoSession: (d: string) =>
		`已记录工作区: ${d}\n该目录暂无 Pi 会话,无法直接切换过去。\n请在 pi-web 里该目录新建一次会话(或 node scripts/pi-web-warmup.mjs --cwd ${d}),再 /workspace 切过去。`,
	sessionEmpty: "当前工作区暂无会话。",
	sessionTitle: (n: number) => `会话(共${n}个):`,
	sessionUntitled: "暂无标题",
	sessionHint: "用 /session <ID|序号> 绑定。",
	sessionUsage: "用法: /session <ID|序号>",
	sessionFail: (e: string) => `绑定会话失败: ${e}`,
	sessionIndexOut: (q: string) => `序号 ${q} 超出范围,先 /sessionlist 查看。`,
	sessionBound: (id: string) => `已绑定会话: ${id}`,
	statusSessionControl: (ok: boolean): string =>
		ok
			? "会话控制: 已就绪"
			: "会话控制: 未就绪(/new /workspace /session 会失败)",
	sessionNoCtx:
		"还没有可用的会话控制上下文。请在终端会话里执行一次 /tg status,然后重试。",
	sessionCancelled:
		"切换被取消(宿主拒绝了这次切换)。请确认目标会话存在、且它记录的目录仍可访问。",
	sessionUnsupported:
		"切换调用已返回,但宿主没有交回新的会话上下文,无法确认 IM 已切到目标会话。若在 pi-web 下使用,需先重启服务并新建会话,让扩展在新会话里重新加载。",
	workspaceCancelled:
		"工作区切换被取消(宿主拒绝了这次切换)。请确认目标工作区里存在会话、且它记录的目录仍可访问。",
	workspaceUnsupported:
		"工作区切换调用已返回,但宿主没有交回新的会话上下文,无法确认已切到目标工作区。若在 pi-web 下使用,需先重启服务并新建会话,让扩展在新会话里重新加载。",
	sessionStale:
		"本地 Pi 刚刚发生过会话切换,控制句柄已失效。请稍等几秒后重发这条消息。",
	newBusy: "任务运行中,请先 /stop 再 /new。",
	bridgeBusy:
		"Pi 正在处理上一条消息,这条没有送达。等当前任务结束后重发,或用 /steer 直接补充指令。",
	runFailed: "本地 Pi 会话正在切换,消息未送达。请稍等几秒后重发这条消息。",
	/**
	 * No ExtensionAPI could run the message at all. Distinct from runFailed on
	 * purpose: a session swap resolves by itself in seconds, this never does,
	 * so "wait and resend" here would send the user in circles.
	 */
	sessionNotReady:
		"Pi 会话尚未就绪,消息未送达。请先启动一个 pi 会话(终端或 pi-web),再重发这条消息。",
	cmdFallback: (name: string, args: string) =>
		`命令 ${name} ${args} 已收到(V1最小实现)。`,
	// Shown to a sender the allowlist rejects. Carries their own id so they
	// never have to dig it out of the Telegram/Feishu client to get back in.
	notAllowed: (id: string, cmd: string) =>
		`本机器人仅限白名单使用。\n你的 user id: ${id}\n请在运行 pi 的终端执行: ${cmd} allow ${id}`,
	// 远程 UI:把宿主的对话框搬到 IM 上回答(见 src/ui-bridge.ts)。
	uiAskSelect: (title: string, list: string, hint: string) =>
		`❓ ${title}\n\n${list}\n\n${hint}`,
	uiAskConfirm: (title: string, message: string) =>
		`❓ ${title}\n\n${message}\n\n回复「是」或「否」;发送 /cancel 取消。`,
	uiAskText: (title: string, placeholder: string) =>
		`❓ ${title}\n\n${placeholder ? `(${placeholder})\n\n` : ""}直接回复内容;发送 /cancel 取消。`,
	uiPickHint: (count: number) => `回复序号 1-${count},或 /cancel 取消。`,
	// 选项里带「自己输入」占位项时:直接回文字就是自定义答案。
	uiPickOrText: (count: number) =>
		`回复序号 1-${count};想自己写答案就直接回复文字;或 /cancel 取消。`,
	uiNeedNumberOrText: (count: number) =>
		`没看懂这个回答。请回序号 1-${count};想自己写答案就直接回复文字,或 /cancel 取消。`,
	uiReminder: (minutes: number) =>
		`⏳ 上面的问题还在等你回答(约 ${minutes} 分钟后自动取消)。回复序号或文字即可。`,
	// 群里只有 @ 到机器人的消息才会被处理,提问时必须先说清楚。
	uiGroupHint: "群里请 @我 再回复答案。",
	uiMoreOptions: (count: number) => `…(还有 ${count} 项,直接回复选项文字)`,
	uiNeedNumber: (count: number) =>
		`没看懂这个回答。请回序号 1-${count},或 /cancel 取消。`,
	uiNeedYesNo: "请回复「是」或「否」,或发送 /cancel 取消。",
	uiAnswered: (value: string) => `✅ 已提交:${value}`,
	uiYes: "是",
	uiNo: "否",
	uiCancelled: "已取消这个提问。",
	uiExpired: "这个问题太久没有回答,已自动取消。",
	// help
	help: "/help /status /version /new /stop /steer <文本> /compact /history [N] /models /model [序号|ID] /thinking [ID] (/reasoning) /workspace <路径|序号> (/ws) /wsl /sessionlist (/sessions) /session <ID|序号> /batch /send /cancel /repair /clear /feishu [card|text]",
};

export type Strings = typeof zh;

const en: Strings = {
	progressWorking: "Received, working…",
	progressQueued: (pos: number) => `Queued #${pos}…`,
	// progress card
	cardDone: "✅ Done",
	cardQueued: (pos: number) => `⏳ Queued #${pos}…`,
	cardWorking: "🤖",
	cardWorkingBusy: "🤖 Working…",
	cardTask: "⚙️ Task process",
	cardTaskMore: "⚙️ Task process (cont.)",
	cardDetails: "📋 Process details",
	cardThinking: "💭 Thinking",
	cardThinkingCount: (n: number) => `💭 Thinking · ${n} blocks`,
	cardThinkingPart: (n: number) => `Block ${n}`,
	cardProcess: (n: number) => `🛠️ Tool summary · ${n}`,
	cardToolsOmitted: (n: number) => `… ${n} more tool calls`,
	cardTruncated: "…(truncated)",
	cardNoReply: "_(no reply)_",
	cardCompletedNote: "✅ Completed",
	batchStart:
		"Batch input on, following plain texts buffered up to 10, /send to submit, /cancel to drop.",
	batchIdle: "Not in batch mode.",
	batchFull: "10 collected, use /send to submit.",
	batchCollected: (n: number) =>
		n >= 10 ? "Collected #10, use /send to submit." : `Collected #${n}.`,
	batchCancelled: "Cancelled.",
	batchNone: "No batch task.",
	batchEmpty: "(empty batch)",
	batchDmOnly: "DM only.",
	statusVersion: `pi-im ${piImVersion()}`,
	statusConn: "Connection: running",
	statusQueue: (n: number) => `Queue: ${n}`,
	statusCwd: (d: string) => `Workspace: ${d}`,
	statusSession: (f: string | undefined) =>
		`Session: ${f ?? "(created on next message)"}`,
	statusModel: (m: string) => `Model: ${m}`,
	statusThinking: (t: string) => `Thinking: ${t}`,
	statusContext: (p: number) => `Context: ${Math.round(p)}%`,
	statusRunning: (r: boolean) => `Run: ${r ? "running" : "idle"}`,
	newDone: "New Pi session created.",
	newFail: "New session not completed.",
	newUnbound: "Unbound, next message will create a new session.",
	stopDone: "Abort signal sent.",
	steerUsage: "Usage: /steer <instruction>",
	steerMerged: "Steered into the running turn.",
	steerQueued: (t: string) =>
		`Steer noted, takes effect next turn: ${t.slice(0, 200)}`,
	compactDone: "Compaction started.",
	clearUnsupported: "Current Pi does not support /clear, session unchanged",
	repairUnsupportedTg: "/repair not supported on TG.",
	repairFeishuHint: "Complete missing scopes in settings and retry.",
	// progress mode
	progressModeCurrent: (m: string) => `Progress display: ${m}`,
	progressModeUsage:
		"Usage: /feishu card | /feishu text, takes effect next turn.",
	progressModeSet: (m: string) => `Switched to ${m}, takes effect next turn.`,
	progressModeTgOnly: "Feishu only; Telegram is always plain text.",
	progressModePersistFail: (e?: string) =>
		e
			? `Switch failed: ${e}`
			: "Switch failed: local session not ready, cannot save the config.",
	statusProgressMode: (m: string) => `Progress display: ${m}`,
	modelsEmpty: "No model info yet (local session not ready, retry later).",
	modelsList: (n: number) => `Available models (${n}):`,
	modelsHint: "Switch with /model <number|ID>.",
	modelCurrent: (m: string, t?: string) =>
		`Current model: ${m}${t ? `\nThinking: ${t}` : ""}`,
	modelUnknown: "Current model unknown.",
	modelBusy: "Task running, wait or /stop first.",
	modelSwitched: (name: string, id: string) =>
		`Switched model: ${name} (${id})`,
	modelSwitchedPlain: "Switched.",
	modelSwitchFail: (e: string) => `Model switch failed: ${e}`,
	modelIndexOut: (q: string) => `Index ${q} out of range, check /models first.`,
	modelNotFound: (q: string) => `No model matches "${q}".`,
	modelAmbiguous: (q: string) => `"${q}" matches multiple models, use full ID.`,
	modelNotInCatalog: "Model not in local catalog, cannot switch.",
	modelNoKey: "Model has no usable API key.",
	modelNoSession: "Local session not ready yet.",
	thinkingLevels: (levels: string): string => `Available: ${levels}`,
	thinkingLevelsUnknown: "Available levels unknown (local session not ready).",
	thinkingExample: "Example: /thinking high",
	thinkingCurrent: (c: string) => `Current thinking: ${c}`,
	thinkingUnknown: "Current thinking unknown.",
	thinkingSwitched: (l: string): string => `Thinking set to: ${l}.`,
	thinkingClamped: (asked: string, got: string, avail?: string): string =>
		`Current model does not support ${asked}, switched to ${got}${avail ? `. Available: ${avail}` : ""}.`,
	thinkingNoSession: "Local session not ready, cannot set thinking level.",
	thinkingBad: (a: string, avail?: string): string =>
		`Cannot set thinking "${a}"${avail ? `. Available: ${avail}` : ""}`,
	historyEmpty: "No history to show (no bound session or empty).",
	wslEmpty: "Workspaces: (none)\nAdd with /workspace <abs path>.",
	wslTitle: "Workspaces:",
	wslCurrent: " (current)",
	wslHint: "Switch with /workspace <number|abs path>.",
	workspaceUsage: "Usage: /workspace <abs path|number>",
	workspaceFail: (e: string) =>
		`Workspace switch failed: ${e}\nUsage: /workspace <abs path|number>`,
	workspaceIndexOut: (q: string) =>
		`Index ${q} out of range, check /wsl first.`,
	workspaceNotDir: (d: string) => `Not an existing directory: ${d}`,
	workspaceSwitched: (d: string) =>
		`Switched global workspace: ${d}\n(Same process as TUI, later messages and tools run here.)`,
	workspaceSwitchedWithSession: (d: string, title: string) =>
		`Switched global workspace: ${d}\nBound newest session there: ${title}\nLater messages and tools run here.`,
	workspaceNoSession: (d: string) =>
		`Recorded workspace: ${d}\nNo Pi session in that dir yet, cannot switch over.\nCreate one session there in pi-web (or node scripts/pi-web-warmup.mjs --cwd ${d}), then /workspace again.`,
	sessionEmpty: "No sessions in current workspace.",
	sessionTitle: (n: number) => `Sessions (${n}):`,
	sessionUntitled: "Untitled",
	sessionHint: "Bind with /session <ID|number>.",
	sessionUsage: "Usage: /session <ID|number>",
	sessionFail: (e: string) => `Session bind failed: ${e}`,
	sessionIndexOut: (q: string) =>
		`Index ${q} out of range, check /sessionlist first.`,
	sessionBound: (id: string) => `Bound session: ${id}`,
	statusSessionControl: (ok: boolean): string =>
		ok
			? "Session control: ready"
			: "Session control: NOT ready (/new /workspace /session will fail)",
	sessionNoCtx:
		"No session-control context yet. Run /tg status once in the terminal session, then retry.",
	sessionCancelled:
		"Switch cancelled (the host rejected the switch). Make sure the target session exists and its recorded directory is still accessible.",
	sessionUnsupported:
		"The switch call returned, but the host handed back no new session context, so we can't confirm the IM landed on the target session. On pi-web, restart the server and start a new session so the extension reloads inside it.",
	workspaceCancelled:
		"Workspace switch cancelled (the host rejected the switch). Make sure the target workspace has a session and its recorded directory is still accessible.",
	workspaceUnsupported:
		"The workspace switch call returned, but the host handed back no new session context, so we can't confirm we landed on the target workspace. On pi-web, restart the server and start a new session so the extension reloads inside it.",
	sessionStale:
		"Local Pi just switched sessions, so the control handle went stale. Wait a few seconds, then resend this message.",
	newBusy: "Task running, /stop first then /new.",
	bridgeBusy:
		"Pi is working on the previous message, so this one was not delivered. Resend once the current task finishes, or use /steer to add an instruction.",
	runFailed:
		"Local Pi session is switching, message not delivered. Wait a few seconds and resend.",
	sessionNotReady:
		"Pi session not ready, message not delivered. Start a pi session (terminal or pi-web) first, then resend.",
	cmdFallback: (name: string, args: string) =>
		`Command ${name} ${args} received (V1 stub).`,
	notAllowed: (id: string, cmd: string) =>
		`This bot is restricted to an allowlist.\nYour user id: ${id}\nRun this in the terminal running pi: ${cmd} allow ${id}`,
	uiAskSelect: (title: string, list: string, hint: string) =>
		`❓ ${title}\n\n${list}\n\n${hint}`,
	uiAskConfirm: (title: string, message: string) =>
		`❓ ${title}\n\n${message}\n\nReply "yes" or "no"; send /cancel to dismiss.`,
	uiAskText: (title: string, placeholder: string) =>
		`❓ ${title}\n\n${placeholder ? `(${placeholder})\n\n` : ""}Reply with the answer; send /cancel to dismiss.`,
	uiPickHint: (count: number) => `Reply 1-${count}, or /cancel to dismiss.`,
	uiPickOrText: (count: number) =>
		`Reply 1-${count}; to write your own answer, just reply with text; or /cancel to dismiss.`,
	uiNeedNumberOrText: (count: number) =>
		`That did not match. Reply 1-${count}; to write your own answer, reply with text; or /cancel.`,
	uiReminder: (minutes: number) =>
		`⏳ Still waiting on the question above (auto-cancels in ~${minutes} min). Reply with a number or text.`,
	uiGroupHint: "In a group, @-mention me in your reply.",
	uiMoreOptions: (count: number) =>
		`…(${count} more; reply with the option text)`,
	uiNeedNumber: (count: number) =>
		`That is not one of the answers. Reply 1-${count}, or /cancel to dismiss.`,
	uiNeedYesNo: 'Reply "yes" or "no", or send /cancel to dismiss.',
	uiAnswered: (value: string) => `✅ Sent: ${value}`,
	uiYes: "yes",
	uiNo: "no",
	uiCancelled: "Question dismissed.",
	uiExpired: "Nobody answered this question in time, so it was dismissed.",
	help: "/help /status /version /new /stop /steer <text> /compact /history [N] /models /model [number|ID] /thinking [ID] (/reasoning) /workspace <path|number> (/ws) /wsl /sessionlist (/sessions) /session <ID|number> /batch /send /cancel /repair /clear /feishu [card|text]",
};

export function getStrings(locale: Locale): Strings {
	return locale === "en" ? en : zh;
}
