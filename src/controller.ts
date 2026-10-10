// src/controller.ts
import { BatchCollector } from "./core/batch.js";
import { MessageDeduplicator } from "./core/dedup.js";
import { SerialMessageQueue } from "./core/queue.js";
import type { ChannelLike, InboundMessage } from "./core/types.js";
import type { PiAgentBridge } from "./pi-bridge.js";
import { parseRemoteCommand, renderHelp } from "./remote-commands.js";
export interface PiRuntimeHooks {
	newSession?: () => Promise<boolean>;
	compact?: () => void;
	abort?: () => void;
	listModels?: () => Array<{ id: string; name?: string }>;
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
			case "/status":
				await this.channel.sendText(
					m.chatId,
					`pi-im 0.1.0/${this.opts.channelName} 队列:${this.queue.size}`,
				);
				return;
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
			default:
				await this.channel.sendText(
					m.chatId,
					`命令 ${name} ${args} 已收到(V1最小实现)。`,
				);
				return;
		}
	}
}
