// src/feishu/gateway.ts — real Lark WebSocket gateway via @larksuiteoapi/node-sdk.
import type {
	ChannelHealth,
	ChannelLike,
	InboundMessage,
} from "../core/types.js";
import { imDebug } from "../debug.js";

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
	/**
	 * Snapshot of the WebSocket lifecycle. Absent on older SDK builds and under
	 * the webhook transport, so every read has to tolerate it.
	 */
	getConnectionStatus?(): { state?: string } | undefined;
	fetchBotIdentity?(): Promise<
		{ openId?: string; userId?: string } | undefined
	>;
}

/**
 * How long the socket may stay outside `connected` before the gateway counts as
 * down. The SDK auto-reconnects transient drops, and a reconnecting blip must
 * not release the session — only an outage lasting past this does.
 */
export const FEISHU_HEALTH_GRACE_MS = 90_000;

/** SDK logger levels, in the numeric order @larksuiteoapi/node-sdk uses. */
const LEVELS = ["off", "error", "warn", "info", "debug"] as const;

/**
 * The SDK defaults to LoggerLevel.info writing straight to the global console,
 * so a single connect printed a "[info]: ws client ready" line plus a
 * multi-line "configure long connection in the developer console" banner into
 * the user's TUI — interleaved with pi's own output and impossible to filter.
 *
 * Default to warn: the SDK's routine chatter goes away, its real problems stay.
 * PI_IM_FEISHU_LOG raises it back when debugging.
 */
function resolveLogLevel(): number {
	const raw = process.env.PI_IM_FEISHU_LOG?.trim().toLowerCase();
	const i = raw ? LEVELS.indexOf(raw as (typeof LEVELS)[number]) : -1;
	return i === -1 ? LEVELS.indexOf("warn") : i;
}

/**
 * Tag SDK output so it is distinguishable from pi's, and keep it on the same
 * console stream. Must tolerate any call signature the SDK uses.
 */
function taggedLogger(): {
	error: (...msg: unknown[]) => void;
	warn: (...msg: unknown[]) => void;
	info: (...msg: unknown[]) => void;
	debug: (...msg: unknown[]) => void;
	trace: (...msg: unknown[]) => void;
} {
	// Explicitly debugging the SDK: hand over its stream verbatim.
	const raw = process.env.PI_IM_FEISHU_LOG?.trim().toLowerCase() === "debug";
	const emit =
		(stream: "error" | "warn" | "info" | "log") =>
		(...args: unknown[]) => {
			if (stream === "warn" && !raw) {
				const unhandled = unhandledEventName(args);
				// Only silence it when the SDK says "nothing handles this event"
				// for an event pi-im does not depend on.
				if (unhandled && !REQUIRED_EVENT_SET.has(unhandled)) return;
			}
			try {
				console[stream]("[pi-im:feishu]", ...args);
			} catch {
				// A logger that throws would take down the gateway it is logging for.
			}
		};
	return {
		error: emit("error"),
		warn: emit("warn"),
		info: emit("log"),
		debug: emit("log"),
		trace: emit("log"),
	};
}

/**
 * Why the SDK dropped an inbound message before pi-im saw it.
 *
 * The gate lives in the SDK's safety pipeline and is silent by default:
 * `policy.evaluate()` -> `onReject({reason})` -> `return`. Reasons we have to
 * be able to name: no_mention (group message without an @bot),
 * mention_all_blocked, dm_disabled, sender_not_allowed, group_not_allowed.
 */
export interface FeishuReject {
	reason: string;
	chatId?: string;
	senderId?: string;
	messageId?: string;
}

function baseUrl(domain: "feishu" | "lark"): string {
	return domain === "lark"
		? "https://open.larksuite.com"
		: "https://open.feishu.cn";
}

function pickText(raw: Record<string, unknown>): string {
	const content = raw.content;
	if (typeof content === "string") {
		// 飞书文本事件的 content 有两种形态:JSON 包层的 `{"text":"2"}`,或者
		// 已经是纯文本的 `2`。这里踩过一个很贵的坑:单数字、`true`、`null` 本身
		// 就是合法 JSON,parse 成功后取 `.text` 得到 undefined —— 老代码据此返回
		// 空串,整条消息在 `!text` 那一步被当成"取不到文本"丢掉,而丢掉的正好是
		// "1"/"2" 这种最常用的序号回复。所以只有真取到文本才用解析结果,其余一律
		// 退回原文。
		let structured = false;
		try {
			const parsed = JSON.parse(content) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const text = (parsed as { text?: unknown }).text;
				if (typeof text === "string") return text;
				// 结构化内容(图片/富文本)没有可当 prompt 的文本,按老行为留空。
				structured = true;
			}
		} catch {
			// 不是 JSON,那就是人写的句子。
		}
		if (!structured) return content;
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

function toInboundMessage(
	raw: Record<string, unknown>,
	botOpenId = "",
): InboundMessage | null {
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
			if (typeof x === "string") return botOpenId ? x === botOpenId : true;
			if (x && typeof x === "object") {
				const o = x as Record<string, unknown>;
				const id = o.id ?? o.openId ?? o.open_id ?? o.userId ?? o.user_id;
				if (botOpenId && id) return id === botOpenId;
				return Boolean(o.isBot ?? o.bot);
			}
			return false;
		});
	}
	if (!mentionBot) mentionBot = parseMention(text, botOpenId);
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

/** 只给测试用:把一条原始事件转成入站消息(正常路径由网关内部调用)。 */
export const toInboundMessageForTests = toInboundMessage;

/**
 * Events Feishu pushes that pi-im deliberately does not handle.
 *
 * The SDK registers handlers for a fixed set and warns for anything else
 * (`EventDispatcher.invoke`: `this.logger.warn(`no ${type} handle`)`).
 *
 * Enumerating the harmless events (a blacklist) is the wrong default: Feishu
 * pushes whatever the app subscribed to, so the next subscribed event warns
 * again. Invert it — name the events whose loss must stay visible and let the
 * logger drop every other "no <type> handle". Unknown event types are silent by
 * default, so new subscriptions cost nothing.
 *
 * Keep this short and pi-im-specific. `im.message.receive_v1` is the only one:
 * if it ever loses its handler the bot goes silently blind, and that is exactly
 * the warning this inversion must never swallow.
 */
export const REQUIRED_LARK_EVENTS = ["im.message.receive_v1"] as const;

/** `no im.foo.bar_v1 handle` -> the event name, else undefined. */
function unhandledEventName(args: unknown[]): string | undefined {
	for (const arg of args) {
		// The SDK forwards one array (LoggerProxy.warn does `this.logger.warn(msg)`).
		const text = Array.isArray(arg) ? arg.join(" ") : String(arg);
		const m = /\bno\s+([A-Za-z0-9_.]+)\s+handle\b/.exec(text);
		if (m?.[1]) return m[1];
	}
	return undefined;
}

const REQUIRED_EVENT_SET: ReadonlySet<string> = new Set(REQUIRED_LARK_EVENTS);

export class SdkFeishuGateway implements ChannelLike {
	private handler: MsgHandler | null = null;
	private channel: LarkChannelLike | null = null;
	private botOpenId = "";
	private lastReject: FeishuReject | null = null;
	private lastOkAtMs = 0;
	private lastErrorAtMs = 0;
	private lastError: string | undefined;
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
		// Seed the window before the first handshake: connect() can take a while,
		// and that must not read as an outage.
		this.lastOkAtMs = Date.now();
		this.lastErrorAtMs = 0;
		this.lastError = undefined;
		const { Domain, createLarkChannel } = await import(
			"@larksuiteoapi/node-sdk"
		);
		const channel = createLarkChannel({
			appId: this.opts.appId,
			appSecret: this.opts.appSecret,
			// Must be the SDK's numeric Domain enum. formatDomain() switches on
			// Domain.Feishu === 0 / Domain.Lark === 1 and falls through to
			// `default: return domain`, so passing the string "feishu" made the
			// literal string the axios baseURL ("feishu/open-apis/...") and every
			// request failed with ERR_INVALID_URL behind a bot-identity error.
			domain: this.opts.domain === "lark" ? Domain.Lark : Domain.Feishu,
			// Without these the SDK logs at info straight to the global console
			// and dumps its connection banner into the user's TUI.
			loggerLevel: resolveLogLevel(),
			logger: taggedLogger(),
		}) as unknown as LarkChannelLike;
		channel.on("message", (raw: unknown) => {
			try {
				if (!raw || typeof raw !== "object") return;
				const m = toInboundMessage(
					raw as Record<string, unknown>,
					this.botOpenId,
				);
				if (!m) {
					// 取不到 chat/文本时这里会静默丢,是整条链路最黑的一段:
					// 把原始事件记下来才能判断是飞书没投递还是我们没解析。
					imDebug("feishu:unparsed", raw);
					return;
				}
				imDebug("feishu:inbound", m.chatId, m.chatId.length, m.text);
				this.handler?.(m);
			} catch {}
		});
		// Without this the SDK's policy gate drops messages with no trace at
		// all, so "群里没 @ 机器人" and "飞书根本没投递" look identical.
		channel.on("reject", (raw: unknown) => {
			const r = (raw ?? {}) as Record<string, unknown>;
			this.lastReject = {
				reason: typeof r.reason === "string" ? r.reason : "unknown",
				chatId: typeof r.chatId === "string" ? r.chatId : undefined,
				senderId: typeof r.senderId === "string" ? r.senderId : undefined,
				messageId: typeof r.messageId === "string" ? r.messageId : undefined,
			};
			console.error(
				`[pi-im] 飞书消息被网关策略拦截: reason=${this.lastReject.reason} chat=${this.lastReject.chatId ?? "?"} sender=${this.lastReject.senderId ?? "?"}`,
			);
			imDebug("feishu:reject", this.lastReject);
		});
		try {
			await channel.connect();
		} catch (error) {
			// A failed handshake is the outage `/status` and the session keepAlive
			// both need to see; without this the state would only ever say
			// "stopped", hiding why.
			this.lastErrorAtMs = Date.now();
			this.lastError = error instanceof Error ? error.message : String(error);
			await channel.disconnect().catch(() => undefined);
			throw error;
		}
		this.channel = channel;
		this.lastOkAtMs = Date.now();
		// No event registration here on purpose: "no <type> handle" warnings are
		// filtered in taggedLogger() instead, so subscribed events pi-im has never
		// heard of stay quiet without enumerating them.
		try {
			const id = await channel.fetchBotIdentity?.();
			if (id?.openId) this.botOpenId = id.openId;
		} catch {}
	}
	/**
	 * Liveness for pi-web's session keepAlive.
	 *
	 * `channel !== null` only means connect() resolved once; the socket can be
	 * reconnecting or dead long afterwards. The SDK tracks that itself, so ask
	 * it — and treat an SDK too old to answer as "reconnecting", not "connected",
	 * because assuming healthy would pin the session alive with a dead gateway.
	 */
	getHealth(): ChannelHealth {
		const ch = this.channel;
		if (!ch) {
			return {
				state: "stopped",
				lastOkAtMs: 0,
				lastErrorAtMs: this.lastErrorAtMs,
				...(this.lastError ? { lastError: this.lastError } : {}),
			};
		}
		const state = ch.getConnectionStatus?.()?.state;
		const connected = state === "connected";
		if (connected) {
			this.lastOkAtMs = Date.now();
			this.lastError = undefined;
		}
		return {
			state: connected ? "connected" : "reconnecting",
			lastOkAtMs: this.lastOkAtMs,
			lastErrorAtMs: this.lastErrorAtMs,
			...(this.lastError || state
				? { lastError: this.lastError ?? `socket ${state ?? "unknown"}` }
				: {}),
		};
	}
	async stop(): Promise<void> {
		const ch = this.channel;
		this.channel = null;
		this.lastOkAtMs = 0;
		if (ch) await ch.disconnect().catch(() => undefined);
	}
	/**
	 * `channel.sender` is the SDK's low-level OutboundSender, whose methods
	 * take four positional arguments (sendText(to, idType, text, opts)). Calling
	 * sendText(chatId, text) put the body in the idType slot, left text
	 * undefined and opts undefined, and the transpiled `opts.mentions ?? []`
	 * threw on the eager property access — killing the whole pi process on the
	 * first reply.
	 *
	 * `send(to, input, opts = {})` is the public entry point: it derives the
	 * receive-id type itself via detectReceiveIdType(), so we must not pass one.
	 */
	/**
	 * Everything needed to talk to a chat lives on LarkChannel, not on
	 * `channel.sender` (OutboundSender). The split matters:
	 *
	 *   OutboundSender — send / sendText / patchCard / createCardInstance
	 *   LarkChannel    — send / editMessage / updateCard / recallMessage
	 *
	 * `editMessage` exists ONLY on LarkChannel. Reading it off `sender` gave
	 * undefined, and the `if (!s.editMessage) return;` guard returned WITHOUT
	 * throwing — so the controller's `.catch(() => sendText(...))` fallback
	 * never ran and the reply stayed on "收到,处理中…" forever. A missing
	 * capability must throw so the caller can fall back.
	 */
	private surface(): {
		send(
			to: string,
			input: Record<string, unknown>,
			opts?: Record<string, unknown>,
		): Promise<unknown>;
		editMessage(messageId: string, text: string): Promise<unknown>;
		updateCard(
			messageId: string,
			card: Record<string, unknown>,
		): Promise<unknown>;
	} {
		const ch = this.channel as unknown as {
			send?: (...a: never[]) => Promise<unknown>;
			editMessage?: (...a: never[]) => Promise<unknown>;
			updateCard?: (...a: never[]) => Promise<unknown>;
		} | null;
		if (!ch?.send) throw new Error("飞书网关未连接,先 /feishu start。");
		return ch as unknown as ReturnType<SdkFeishuGateway["surface"]>;
	}
	async sendText(chatId: string, text: string): Promise<string> {
		const r = (await this.surface().send(chatId, { text })) as
			| { messageId?: string; message_id?: string }
			| undefined;
		return r?.messageId ?? r?.message_id ?? `mid-${Date.now()}`;
	}
	async editText(
		_chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		const s = this.surface();
		if (typeof s.editMessage !== "function") {
			throw new Error("飞书网关不支持 editMessage,无法更新已发送的消息。");
		}
		await s.editMessage(messageId, text);
	}
	/** Send an interactive card message; returns its message id. */
	async sendCard(
		chatId: string,
		card: Record<string, unknown>,
	): Promise<string> {
		const r = (await this.surface().send(chatId, { card })) as
			| { messageId?: string; message_id?: string }
			| undefined;
		return r?.messageId ?? r?.message_id ?? `mid-${Date.now()}`;
	}
	/** Replace a card message in place (im.v1.message.patch). */
	async updateCard(
		messageId: string,
		card: Record<string, unknown>,
	): Promise<void> {
		const s = this.surface();
		if (typeof s.updateCard !== "function") {
			throw new Error("飞书网关不支持 updateCard,无法更新卡片。");
		}
		await s.updateCard(messageId, card);
	}
	async sendImage(
		chatId: string,
		buf: Buffer,
		_filename: string,
	): Promise<void> {
		await this.surface().send(chatId, { image: { source: buf } });
	}
	async sendFile(chatId: string, buf: Buffer, filename: string): Promise<void> {
		await this.surface().send(chatId, {
			file: { source: buf, fileName: filename },
		});
	}
	getBotOpenId(): string {
		return this.botOpenId;
	}
	/** Last message the SDK's policy gate dropped, for /feishu status. */
	getLastReject(): FeishuReject | undefined {
		return this.lastReject ?? undefined;
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
