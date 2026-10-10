// src/feishu/gateway.ts
import type { ChannelLike, InboundMessage } from "../core/types.js";
export function parseMention(_text: string, _botId: string): boolean {
	return false;
}
export type MsgHandler = (m: InboundMessage) => void;
export class SdkFeishuGateway implements ChannelLike {
	private handler: MsgHandler | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor(
		private opts: {
			appId: string;
			appSecret: string;
			domain: "feishu" | "lark";
		},
	) {
		void this.opts;
	}
	onMessage(h: MsgHandler): () => void {
		this.handler = h;
		return () => {
			this.handler = null;
		};
	}
	async start(): Promise<void> {
		const { createLarkChannel } = await import("@larksuiteoapi/node-sdk");
		void createLarkChannel;
		this.timer = setInterval(() => {}, 60_000);
	}
	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
	async sendText(chatId: string, text: string): Promise<string> {
		void chatId;
		void text;
		return `mid-${Date.now()}`;
	}
	async editText(
		_chatId: string,
		_messageId: string,
		_text: string,
	): Promise<void> {}
	async sendImage(
		chatId: string,
		_buf: Buffer,
		_filename: string,
	): Promise<void> {
		void chatId;
		throw new Error("feishu sendImage requires im:resource, V1 stub");
	}
	async sendFile(
		chatId: string,
		_buf: Buffer,
		_filename: string,
	): Promise<void> {
		void chatId;
		throw new Error("feishu sendFile requires im:resource, V1 stub");
	}
	emitForTest(m: InboundMessage): void {
		this.handler?.(m);
	}
}
export const FEISHU_REQUIRED_SCOPES = [
	"im:message:readonly",
	"im:resource",
] as const;
export async function probeGrantedScopes(_appId: string): Promise<string[]> {
	return [];
}
export async function validateSdkCredentials(
	appId: string,
	appSecret: string,
): Promise<boolean> {
	return Boolean(appId && appSecret);
}
