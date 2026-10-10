// src/telegram/gateway.ts
import type { ChannelLike, InboundMessage } from "../core/types.js";
export function shouldRespondInGroup(
	_text: string,
	mentioned: boolean,
	isReplyToBot: boolean,
): boolean {
	return mentioned || isReplyToBot;
}
export class TelegramGateway implements ChannelLike {
	private handler: ((m: InboundMessage) => void) | null = null;
	private offset = 0;
	private stopped = false;
	constructor(private opts: { botToken: string }) {
		void this.opts;
	}
	onMessage(h: (m: InboundMessage) => void): () => void {
		this.handler = h;
		return () => {
			this.handler = null;
		};
	}
	async start(): Promise<void> {
		this.stopped = false;
		void this.poll();
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	private async poll(): Promise<void> {
		while (!this.stopped) {
			try {
				const res = await fetch(
					`https://api.telegram.org/bot${this.opts.botToken}/getUpdates?offset=${this.offset}&timeout=30`,
				);
				const data = (await res.json()) as {
					result?: Array<{
						update_id: number;
						message?: {
							message_id: number;
							chat: { id: number; type: string };
							from?: { id: number; first_name?: string };
							text?: string;
						};
					}>;
				};
				for (const u of data.result ?? []) {
					this.offset = u.update_id + 1;
					const m = u.message;
					if (!m?.text) continue;
					this.handler?.({
						messageId: `tg-${u.update_id}`,
						chatId: String(m.chat.id),
						chatType: m.chat.type === "private" ? "p2p" : "group",
						senderId: String(m.from?.id ?? 0),
						senderName: m.from?.first_name,
						text: m.text,
						mentionBot: m.text.includes("@"),
						timestampMs: Date.now(),
					});
				}
			} catch {
				await new Promise((r) => setTimeout(r, 3000));
			}
		}
	}
	async sendText(chatId: string, text: string): Promise<string> {
		const res = await fetch(
			`https://api.telegram.org/bot${this.opts.botToken}/sendMessage`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
			},
		);
		const data = (await res.json()) as { result?: { message_id: number } };
		return String(data.result?.message_id ?? Date.now());
	}
	async editText(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		await fetch(
			`https://api.telegram.org/bot${this.opts.botToken}/editMessageText`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					chat_id: chatId,
					message_id: Number(messageId) || undefined,
					text: text.slice(0, 4000),
				}),
			},
		);
	}
	async sendImage(
		chatId: string,
		buf: Buffer,
		filename: string,
	): Promise<void> {
		const form = new FormData();
		form.append("chat_id", chatId);
		form.append("photo", new Blob([new Uint8Array(buf)]), filename);
		await fetch(`https://api.telegram.org/bot${this.opts.botToken}/sendPhoto`, {
			method: "POST",
			body: form,
		});
	}
	async sendFile(chatId: string, buf: Buffer, filename: string): Promise<void> {
		const form = new FormData();
		form.append("chat_id", chatId);
		form.append("document", new Blob([new Uint8Array(buf)]), filename);
		await fetch(
			`https://api.telegram.org/bot${this.opts.botToken}/sendDocument`,
			{ method: "POST", body: form },
		);
	}
}
