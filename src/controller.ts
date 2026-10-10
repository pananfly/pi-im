// src/controller.ts
import { BatchCollector } from "./core/batch.js";
import { MessageDeduplicator } from "./core/dedup.js";
import { SerialMessageQueue } from "./core/queue.js";
import type { ChannelLike, InboundMessage } from "./core/types.js";
import type { PiAgentBridge } from "./pi-bridge.js";
import { parseRemoteCommand, renderHelp } from "./remote-commands.js";
export interface PiModelRef {
	id: string;
	name?: string;
	provider?: string;
}
export interface PiRuntimeHooks {
	newSession?: () => Promise<boolean>;
	compact?: () => void;
	abort?: () => void;
	cwd?: () => string;
	sessionFile?: () => string | undefined;
	model?: () => PiModelRef | undefined;
	thinking?: () => string | undefined;
	contextPercent?: () => number | undefined;
	isRunning?: () => boolean;
	listModels?: () => PiModelRef[];
	switchModel?: (query: string) => Promise<PiModelRef>;
	setThinking?: (level: string) => boolean;
	readHistory?: (n: number) => string[];
	listWorkspaces?: () => string[];
	listSessions?: () => Array<{ id: string; title?: string }>;
	switchWorkspace?: (dir: string) => Promise<string>;
	switchSession?: (idOrIndex: string) => Promise<string>;
}
export class ImController {
	queue = new SerialMessageQueue();
	dedup = new MessageDeduplicator();
	batch = new BatchCollector();
	runtime: PiRuntimeHooks | undefined;
	constructor(
		private channel: ChannelLike,
		private agent: PiAgentBridge,
		private opts: { allowlist: string[]; channelName: string },
	) {}
	private allowed(senderId: string): boolean {
		if (this.opts.allowlist.length === 0) return true;
		return this.opts.allowlist.includes(senderId);
	}
	async handleInbound(m: InboundMessage): Promise<void> {
		if (this.dedup.seen(m.messageId)) return;
		this.dedup.mark(m.messageId);
		if (Date.now() - m.timestampMs > 30 * 60 * 1000) return;
		if (!this.allowed(m.senderId)) return;
		if (m.chatType === "group" && !m.mentionBot) return;
		const cmd = parseRemoteCommand(m.text);
		if (cmd) {
			await this.handleCommand(m, cmd.name, cmd.args);
			return;
		}
		if (this.batch.isActive(m.chatId)) {
			await this.channel.sendText(
				m.chatId,
				this.batch.collect(m.chatId, m.text),
			);
			return;
		}
		const pos = this.queue.size + 1;
		let progressId = "";
		await this.queue.enqueue(m.chatId, async () => {
			progressId = await this.channel.sendText(
				m.chatId,
				pos > 1 ? `排队第${pos}位…` : "收到,处理中…",
			);
			const out = await this.agent.run(m.text, {
				onText: () => {},
				onActivity: () => {},
			});
			await this.channel
				.editText(m.chatId, progressId, out.slice(0, 4000))
				.catch(() => this.channel.sendText(m.chatId, out.slice(0, 4000)));
		});
	}
	private async handleCommand(
		m: InboundMessage,
		name: string,
		args: string,
	): Promise<void> {
		switch (name) {
			case "/help":
				await this.channel.sendText(m.chatId, renderHelp());
				return;
			case "/version":
				await this.channel.sendText(m.chatId, "pi-im 0.1.0");
				return;
			case "/batch":
				if (m.chatType !== "p2p") {
					await this.channel.sendText(m.chatId, "仅私聊可用。");
					return;
				}
				await this.channel.sendText(m.chatId, this.batch.start(m.chatId));
				return;
			case "/send": {
				const all = this.batch.submit(m.chatId);
				await this.handleInbound({
					...m,
					text: all || "(空批量)",
					messageId: `${m.messageId}-send`,
				});
				return;
			}
			case "/cancel":
				await this.channel.sendText(
					m.chatId,
					this.batch.cancel(m.chatId) ? "已取消。" : "无批量任务。",
				);
				return;
			case "/repair":
				await this.channel.sendText(
					m.chatId,
					this.opts.channelName === "telegram"
						? "TG 不支持 /repair。"
						: "请在设置页补全 scope 后重试。",
				);
				return;
			case "/status": {
				const r = this.runtime;
				const lines = [
					`pi-im 0.1.0/${this.opts.channelName}`,
					`  连接: 运行中`,
					`  队列: ${this.queue.size}`,
				];
				if (r?.cwd) lines.push(`  工作区: ${r.cwd()}`);
				if (r?.sessionFile)
					lines.push(`  会话: ${r.sessionFile() ?? "(下一条消息新建)"}`);
				if (r?.model) {
					const m = r.model();
					if (m)
						lines.push(
							`  模型: ${m.name ?? m.id}${m.provider ? ` (${m.provider})` : ""}`,
						);
				}
				if (r?.thinking) {
					const t = r.thinking();
					if (t) lines.push(`  思考: ${t}`);
				}
				if (r?.contextPercent) {
					const p = r.contextPercent();
					if (typeof p === "number") lines.push(`  上下文: ${Math.round(p)}%`);
				}
				if (r?.isRunning)
					lines.push(`  运行: ${r.isRunning() ? "运行中" : "空闲"}`);
				await this.channel.sendText(m.chatId, lines.join("\n"));
				return;
			}
			case "/new":
				if (this.runtime?.newSession) {
					const ok = await this.runtime.newSession();
					await this.channel.sendText(
						m.chatId,
						ok ? "已新建 Pi 会话。" : "新建会话未完成。",
					);
				} else {
					await this.channel.sendText(
						m.chatId,
						"已解绑,下一条普通消息将建新会话。",
					);
				}
				return;
			case "/stop":
				this.agent.cancel("IM /stop");
				this.runtime?.abort?.();
				await this.channel.sendText(m.chatId, "已发送中止信号。");
				return;
			case "/steer":
				if (!args) {
					await this.channel.sendText(m.chatId, "用法:/steer <补充指令>");
					return;
				}
				await this.channel.sendText(
					m.chatId,
					`已收到 steer,将在下一轮生效:${args.slice(0, 200)}`,
				);
				return;
			case "/compact":
				this.runtime?.compact?.();
				await this.channel.sendText(m.chatId, "已开始压缩上下文。");
				return;
			case "/clear":
				await this.channel.sendText(m.chatId, "当前 Pi 未支持 /clear,会话不变");
				return;
			case "/models": {
				const list = this.runtime?.listModels?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(
						m.chatId,
						"暂无可用模型信息(本地暂未就绪,稍后再试)。",
					);
					return;
				}
				const cur = this.runtime?.model?.()?.id;
				const lines = list.slice(0, 30).map((md, i) => {
					const mark = cur && (md.id === cur || md.name === cur) ? " *" : "";
					return `${i + 1}. ${md.name ?? md.id}${md.provider ? ` [${md.provider}]` : ""}${mark}`;
				});
				await this.channel.sendText(
					m.chatId,
					`可用模型(共${list.length}个):\n${lines.join("\n")}\n用 /model <序号|ID> 切换。`,
				);
				return;
			}
			case "/model": {
				if (!args) {
					const curM = this.runtime?.model?.();
					const curT = this.runtime?.thinking?.();
					await this.channel.sendText(
						m.chatId,
						curM
							? `当前模型: ${curM.name ?? curM.id}${curT ? `\n思考: ${curT}` : ""}`
							: "当前模型未知。",
					);
					return;
				}
				if (this.runtime?.isRunning?.()) {
					await this.channel.sendText(
						m.chatId,
						"任务运行中,请等待完成或先 /stop。",
					);
					return;
				}
				try {
					const switched = await this.runtime?.switchModel?.(args);
					await this.channel.sendText(
						m.chatId,
						switched
							? `已切换模型: ${switched.name ?? switched.id} (${switched.id})`
							: "切换完成。",
					);
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						`切换模型失败: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return;
			}
			case "/thinking":
			case "/reasoning": {
				if (!args) {
					const cur = this.runtime?.thinking?.();
					await this.channel.sendText(
						m.chatId,
						`${cur ? `当前思考档位: ${cur}` : "当前思考档位未知。"}\n可用: off / minimal / low / medium / high / xhigh / max\n示例: /thinking high`,
					);
					return;
				}
				const ok = this.runtime?.setThinking?.(args.toLowerCase());
				await this.channel.sendText(
					m.chatId,
					ok
						? `已切换思考档位: ${args.toLowerCase()}。`
						: `无法设置思考档位"${args}"。可用: off / minimal / low / medium / high / xhigh / max`,
				);
				return;
			}
			case "/history": {
				const n = Math.min(Math.max(Number.parseInt(args, 10) || 3, 1), 5);
				const items = this.runtime?.readHistory?.(n) ?? [];
				if (items.length === 0) {
					await this.channel.sendText(
						m.chatId,
						"暂无可显示的历史(尚无绑定会话或历史为空)。",
					);
					return;
				}
				const { formatHistoryPreview } = await import("./remote-commands.js");
				await this.channel.sendText(m.chatId, formatHistoryPreview(items, n));
				return;
			}
			case "/wsl": {
				const list = this.runtime?.listWorkspaces?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(
						m.chatId,
						"工作区: (暂无记录)\n用 /workspace <绝对路径> 添加。",
					);
					return;
				}
				await this.channel.sendText(
					m.chatId,
					`工作区:\n${list.map((w, i) => `${i + 1}. ${w}${i === 0 ? " (当前)" : ""}`).join("\n")}\n用 /workspace <序号|绝对路径> 切换。`,
				);
				return;
			}
			case "/workspace":
			case "/ws": {
				if (!args) {
					await this.channel.sendText(
						m.chatId,
						"用法: /workspace <绝对路径|序号>",
					);
					return;
				}
				try {
					const msg = await this.runtime?.switchWorkspace?.(args);
					await this.channel.sendText(m.chatId, msg ?? "已切换工作区。");
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						`切换工作区失败: ${e instanceof Error ? e.message : String(e)}\n用法: /workspace <绝对路径|序号>`,
					);
				}
				return;
			}
			case "/sessionlist":
			case "/sessions": {
				const list = this.runtime?.listSessions?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(m.chatId, "当前工作区暂无会话。");
					return;
				}
				const shown = list.slice(0, 20);
				await this.channel.sendText(
					m.chatId,
					`会话(共${list.length}个):\n${shown.map((s, i) => `${i + 1}. ${s.title ?? "暂无标题"} (${s.id.slice(0, 8)})`).join("\n")}\n用 /session <ID|序号> 绑定。`,
				);
				return;
			}
			case "/session": {
				if (!args) {
					await this.channel.sendText(m.chatId, "用法: /session <ID|序号>");
					return;
				}
				try {
					const msg = await this.runtime?.switchSession?.(args);
					await this.channel.sendText(m.chatId, msg ?? "已绑定会话。");
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						`绑定会话失败: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				return;
			}
			default:
				await this.channel.sendText(
					m.chatId,
					`命令 ${name} ${args} 已收到(V1最小实现)。`,
				);
				return;
		}
	}
}
