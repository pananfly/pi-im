// src/controller.ts
import { BatchCollector } from "./core/batch.js";
import { MessageDeduplicator } from "./core/dedup.js";
import { SerialMessageQueue } from "./core/queue.js";
import type { ChannelLike, InboundMessage } from "./core/types.js";
import type { PiAgentBridge } from "./pi-bridge.js";
import { parseRemoteCommand, renderHelp } from "./remote-commands.js";
export class ImController {
  queue = new SerialMessageQueue();
  dedup = new MessageDeduplicator();
  batch = new BatchCollector();
  constructor(private channel: ChannelLike, private agent: PiAgentBridge, private opts: { allowlist: string[]; channelName: string }) {}
  private allowed(senderId: string): boolean { if (this.opts.allowlist.length === 0) return true; return this.opts.allowlist.includes(senderId); }
  async handleInbound(m: InboundMessage): Promise<void> {
    if (this.dedup.seen(m.messageId)) return;
    this.dedup.mark(m.messageId);
    if (Date.now() - m.timestampMs > 30 * 60 * 1000) return;
    if (!this.allowed(m.senderId)) return;
    if (m.chatType === "group" && !m.mentionBot) return;
    const cmd = parseRemoteCommand(m.text);
    if (cmd) { await this.handleCommand(m, cmd.name, cmd.args); return; }
    if (this.batch.isActive(m.chatId)) { await this.channel.sendText(m.chatId, this.batch.collect(m.chatId, m.text)); return; }
    const pos = this.queue.size + 1;
    let progressId = "";
    await this.queue.enqueue(m.chatId, async () => {
      progressId = await this.channel.sendText(m.chatId, pos > 1 ? `排队第${pos}位…` : "收到,处理中…");
      const out = await this.agent.run(m.text, { onText: () => {}, onActivity: () => {} });
      await this.channel.editText(m.chatId, progressId, out.slice(0, 4000)).catch(() => this.channel.sendText(m.chatId, out.slice(0, 4000)));
    });
  }
  private async handleCommand(m: InboundMessage, name: string, args: string): Promise<void> {
    switch (name) {
      case "/help": await this.channel.sendText(m.chatId, renderHelp()); return;
      case "/version": await this.channel.sendText(m.chatId, "pi-im 0.1.0"); return;
      case "/batch": if (m.chatType !== "p2p") { await this.channel.sendText(m.chatId, "仅私聊可用。"); return; } await this.channel.sendText(m.chatId, this.batch.start(m.chatId)); return;
      case "/send": { const all = this.batch.submit(m.chatId); await this.handleInbound({ ...m, text: all || "(空批量)", messageId: `${m.messageId}-send` }); return; }
      case "/cancel": await this.channel.sendText(m.chatId, this.batch.cancel(m.chatId) ? "已取消。" : "无批量任务。"); return;
      case "/repair": await this.channel.sendText(m.chatId, this.opts.channelName === "telegram" ? "TG 不支持 /repair。" : "请在设置页补全 scope 后重试。"); return;
      default: await this.channel.sendText(m.chatId, `命令 ${name} ${args} 已收到(V1最小实现)。`); return;
    }
  }
}
