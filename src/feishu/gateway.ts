// src/feishu/gateway.ts — real Lark WebSocket gateway via @larksuiteoapi/node-sdk.
import type { ChannelLike, InboundMessage } from "../core/types.js";

export function parseMention(text: string, botId: string): boolean {
	if (!text) return false;
	// Direct bot-id hit (SDK may keep ids in text or mentions payload).
	if (botId && text.includes(botId)) return true;
	// @ tags: <at user_id="ou_xxx"> / <at id="ou_xxx"> — only ours counts.
	const tags = text.matchAll(/<at\s[^>]*>/g);
	let sawTag = false;
	for (const m of tags) {
		sawTag = true;
		if (botId && m[0].includes(botId)) return true;
	}
	// Bot id unknown: any @ counts (fallback); otherwise @someone-else is not us.
	if (!botId && (sawTag || text.includes("@"))) return true;
	return false;
}

export type MsgHandler = (m: InboundMessage) => void;

interface LarkChannelLike {
	on(name: string, handler: (msg: unknown) => void): () => void;
	connect(): Promise<unknown>;
	disconnect(): Promise<unknown>;
	fetchBotIdentity?(): Promise<
		{ openId?: string; userId?: string } | undefined
	>;
}

function baseUrl(domain: "feishu" | "lark"): string {
	return domain === "lark"
		? "https://open.larksuite.com"
		: "https://open.feishu.cn";
}

function pickText(raw: Record<string, unknown>): string {
	const content = raw.content;
	if (typeof content === "string") {
		try {
			const parsed = JSON.parse(content) as { text?: unknown };
			if (typeof parsed.text === "string") return parsed.text;
		} catch {
			return content;
		}
	}
	if (typeof raw.text === "string") return raw.text;
	if (typeof raw.body === "string") return raw.body;
	return "";
}

function pickStr(raw: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = raw[k];
		if (typeof v === "string" && v) return v;
	}
	return "";
}

function toInboundMessage(raw: Record<string, unknown>): InboundMessage | null {
	const messageId =
		pickStr(raw, ["messageId", "message_id", "id", "uuid"]) ||
		`fs-${Date.now()}`;
	const chatId = pickStr(raw, ["chatId", "chat_id", "chatID", "openChatId"]);
	const senderId = pickStr(raw, [
		"senderId",
		"sender_id",
		"openId",
		"open_id",
		"senderOpenId",
		"userId",
	]);
	const text = pickText(raw);
	if (!chatId || !text) return null;
	const chatTypeRaw = String(
		raw.chatType ?? raw.chat_type ?? raw.chatMode ?? "p2p",
	).toLowerCase();
	const chatType = chatTypeRaw.includes("group") ? "group" : "p2p";
	const mentions = raw.mentions;
	let mentionBot = false;
	if (Array.isArray(mentions)) {
		mentionBot = mentions.some((x) => {
			if (typeof x === "string") return true;
			if (x && typeof x === "object") {
				const o = x as Record<string, unknown>;
				return Boolean(o.isBot ?? o.bot ?? o.id);
			}
			return false;
		});
	}
	if (!mentionBot) mentionBot = /<at\s[^>]*>/.test(text);
	const ts = raw.createTime ?? raw.create_time ?? raw.timestamp;
	return {
		messageId,
		chatId,
		chatType: chatType as "p2p" | "group",
		senderId: senderId || "unknown",
		senderName:
			pickStr(raw, ["senderName", "sender_name", "nickname", "name"]) ||
			undefined,
		text,
		mentionBot,
		timestampMs: typeof ts === "number" ? ts : Date.now(),
	};
}

export class SdkFeishuGateway implements ChannelLike {
	private handler: MsgHandler | null = null;
	private channel: LarkChannelLike | null = null;
	private botOpenId = "";
	constructor(
		private opts: {
			appId: string;
			appSecret: string;
			domain: "feishu" | "lark";
		},
	) {}
	onMessage(h: MsgHandler): () => void {
		this.handler = h;
		return () => {
			this.handler = null;
		};
	}
	async start(): Promise<void> {
		if (this.channel) return;
		const { createLarkChannel } = await import("@larksuiteoapi/node-sdk");
		// biome-ignore lint/suspicious/noExplicitAny: SDK has no bundled types
		const channel = createLarkChannel({
			appId: this.opts.appId,
			appSecret: this.opts.appSecret,
			domain: this.opts.domain === "lark" ? "lark" : "feishu",
		}) as unknown as LarkChannelLike;
		channel.on("message", (raw: unknown) => {
			try {
				if (!raw || typeof raw !== "object") return;
				const m = toInboundMessage(raw as Record<string, unknown>);
				if (m) this.handler?.(m);
			} catch {}
		});
		await channel.connect();
		this.channel = channel;
		try {
			const id = await channel.fetchBotIdentity?.();
			if (id?.openId) this.botOpenId = id.openId;
		} catch {}
	}
	async stop(): Promise<void> {
		const ch = this.channel;
		this.channel = null;
		if (ch) await ch.disconnect().catch(() => undefined);
	}
	private sender(): {
		sendText(chatId: string, text: string): Promise<unknown>;
		editMessage?(messageId: string, text: string): Promise<unknown>;
		sendImage?(chatId: string, buf: Buffer, filename: string): Promise<unknown>;
		sendFile?(chatId: string, buf: Buffer, filename: string): Promise<unknown>;
	} {
		const ch = this.channel as unknown as {
			sender?: {
				sendText(c: string, t: string): Promise<unknown>;
				editMessage?(m: string, t: string): Promise<unknown>;
				sendImage?(c: string, b: Buffer, f: string): Promise<unknown>;
				sendFile?(c: string, b: Buffer, f: string): Promise<unknown>;
			};
		} | null;
		if (!ch?.sender) throw new Error("飞书网关未连接,先 /feishu start。");
		return ch.sender;
	}
	async sendText(chatId: string, text: string): Promise<string> {
		const r = (await this.sender().sendText(chatId, text)) as
			| { messageId?: string; message_id?: string }
			| undefined;
		return r?.messageId ?? r?.message_id ?? `mid-${Date.now()}`;
	}
	async editText(
		_chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		const s = this.sender();
		if (!s.editMessage) return;
		await s.editMessage(messageId, text);
	}
	async sendImage(
		chatId: string,
		buf: Buffer,
		filename: string,
	): Promise<void> {
		const s = this.sender();
		if (!s.sendImage) throw new Error("飞书 sendImage 需要 im:resource 权限。");
		await s.sendImage(chatId, buf, filename);
	}
	async sendFile(chatId: string, buf: Buffer, filename: string): Promise<void> {
		const s = this.sender();
		if (!s.sendFile) throw new Error("飞书 sendFile 需要 im:resource 权限。");
		await s.sendFile(chatId, buf, filename);
	}
	getBotOpenId(): string {
		return this.botOpenId;
	}
	emitForTest(m: InboundMessage): void {
		this.handler?.(m);
	}
}
export const FEISHU_REQUIRED_SCOPES = [
	"im:message:readonly",
	"im:resource",
] as const;
/** Best-effort scope probe via tenant token; [] on any failure. */
export async function probeGrantedScopes(
	appId: string,
	appSecret: string,
	domain: "feishu" | "lark" = "feishu",
): Promise<string[]> {
	try {
		const tokenRes = await fetch(
			`${baseUrl(domain)}/open-apis/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
				signal: AbortSignal.timeout(15000),
			},
		);
		const tokenData = (await tokenRes.json()) as {
			code?: number;
			tenant_access_token?: string;
		};
		if (tokenData.code !== 0 || !tokenData.tenant_access_token) return [];
		const scopeRes = await fetch(
			`${baseUrl(domain)}/open-apis/auth/v3/scopes`,
			{
				headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
				signal: AbortSignal.timeout(15000),
			},
		);
		const scopeData = (await scopeRes.json()) as {
			code?: number;
			data?: { scopes?: string[] };
		};
		if (scopeData.code !== 0) return [];
		return scopeData.data?.scopes ?? [];
	} catch {
		return [];
	}
}
export async function validateSdkCredentials(
	appId: string,
	appSecret: string,
	domain: "feishu" | "lark" = "feishu",
): Promise<boolean> {
	if (!appId || !appSecret) return false;
	try {
		const res = await fetch(
			`${baseUrl(domain)}/open-apis/auth/v3/tenant_access_token/internal`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
				signal: AbortSignal.timeout(15000),
			},
		);
		const data = (await res.json()) as { code?: number };
		return data.code === 0;
	} catch {
		return false;
	}
}
