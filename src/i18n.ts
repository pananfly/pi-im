// src/i18n.ts — user-visible strings, default zh. Command names stay English.
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
	statusVersion: "pi-im 0.1.0",
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
	thinkingLevels: "可用: off / minimal / low / medium / high / xhigh / max",
	thinkingExample: "示例: /thinking high",
	thinkingCurrent: (c: string) => `当前思考档位: ${c}`,
	thinkingUnknown: "当前思考档位未知。",
	thinkingSwitched: (l: string) => `已切换思考档位: ${l}。`,
	thinkingBad: (a: string) =>
		`无法设置思考档位"${a}"。可用: off / minimal / low / medium / high / xhigh / max`,
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
	sessionEmpty: "当前工作区暂无会话。",
	sessionTitle: (n: number) => `会话(共${n}个):`,
	sessionUntitled: "暂无标题",
	sessionHint: "用 /session <ID|序号> 绑定。",
	sessionUsage: "用法: /session <ID|序号>",
	sessionFail: (e: string) => `绑定会话失败: ${e}`,
	sessionIndexOut: (q: string) => `序号 ${q} 超出范围,先 /sessionlist 查看。`,
	sessionBound: (id: string) => `已绑定会话: ${id}`,
	sessionNoCtx:
		"本地暂无可用的会话切换上下文,请先在 TUI 执行一次 /tg status 后重试。",
	sessionStale:
		"本地 Pi 会话控制已过期（本地发生过会话切换）。请在 Pi Web/TUI 执行一次 /tg status 刷新，然后重发这条消息。",
	newBusy: "任务运行中,请先 /stop 再 /new。",
	cmdFallback: (name: string, args: string) =>
		`命令 ${name} ${args} 已收到(V1最小实现)。`,
	// help
	help: "/help /status /version /new /stop /steer <文本> /compact /history [N] /models /model [序号|ID] /thinking [ID] (/reasoning) /workspace <路径|序号> (/ws) /wsl /sessionlist (/sessions) /session <ID|序号> /batch /send /cancel /repair /clear",
};

export type Strings = typeof zh;

const en: Strings = {
	progressWorking: "Received, working…",
	progressQueued: (pos: number) => `Queued #${pos}…`,
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
	statusVersion: "pi-im 0.1.0",
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
	thinkingLevels:
		"Available: off / minimal / low / medium / high / xhigh / max",
	thinkingExample: "Example: /thinking high",
	thinkingCurrent: (c: string) => `Current thinking: ${c}`,
	thinkingUnknown: "Current thinking unknown.",
	thinkingSwitched: (l: string) => `Thinking set to: ${l}.`,
	thinkingBad: (a: string) =>
		`Cannot set thinking "${a}". Available: off / minimal / low / medium / high / xhigh / max`,
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
	sessionEmpty: "No sessions in current workspace.",
	sessionTitle: (n: number) => `Sessions (${n}):`,
	sessionUntitled: "Untitled",
	sessionHint: "Bind with /session <ID|number>.",
	sessionUsage: "Usage: /session <ID|number>",
	sessionFail: (e: string) => `Session bind failed: ${e}`,
	sessionIndexOut: (q: string) =>
		`Index ${q} out of range, check /sessionlist first.`,
	sessionBound: (id: string) => `Bound session: ${id}`,
	sessionNoCtx:
		"No session-switch context yet, run /tg status once in TUI first.",
	sessionStale:
		"Local Pi session control expired (session switched locally). Run /tg status once in Pi Web/TUI to refresh, then resend.",
	newBusy: "Task running, /stop first then /new.",
	cmdFallback: (name: string, args: string) =>
		`Command ${name} ${args} received (V1 stub).`,
	help: "/help /status /version /new /stop /steer <text> /compact /history [N] /models /model [number|ID] /thinking [ID] (/reasoning) /workspace <path|number> (/ws) /wsl /sessionlist (/sessions) /session <ID|number> /batch /send /cancel /repair /clear",
};

export function getStrings(locale: Locale): Strings {
	return locale === "en" ? en : zh;
}
