// src/telegram/gateway.ts
import type {
	ChannelHealth,
	ChannelLike,
	InboundMessage,
} from "../core/types.js";
import { chunkForTelegram } from "./markdown-chunks.js";
export function shouldRespondInGroup(
	_text: string,
	mentioned: boolean,
	isReplyToBot: boolean,
): boolean {
	return mentioned || isReplyToBot;
}

/**
 * Shortest gap between two getUpdates round trips.
 *
 * `timeout=30` asks the API to hold the request open, so in the steady state the
 * round trip itself paces the loop. Nothing guarantees that though: an edge that
 * answers instantly, a proxy that strips the long poll, or any non-2xx response
 * returns in microseconds. With no floor the loop becomes a hot spin that
 * hammers the API and allocates until the process dies, so pace it here instead
 * of trusting the far end to be slow.
 */
export const MIN_POLL_INTERVAL_MS = 1000;

export class TelegramGateway implements ChannelLike {
	private handler: ((m: InboundMessage) => void) | null = null;
	private offset = 0;
	// Starts stopped: a gateway that was never started has never reached the
	// API, and reporting it as connected would pin a session alive on it.
	private stopped = true;
	private lastOkAtMs = 0;
	private lastErrorAtMs = 0;
	private lastError: string | undefined;
	private down = false;
	private wake: (() => void) | null = null;
	private botUsername: string | undefined;
	constructor(
		private opts: { botToken: string; parseMode?: "plain" | "markdownV2" },
	) {
		void this.opts;
	}
	/**
	 * One Bot API call, or a throw.
	 *
	 * Telegram reports "chat not found", "message too long" and a revoked token
	 * as an ordinary response body, so a caller that only awaited the fetch saw
	 * them all as success. That is not hypothetical here: `sendText` used to
	 * answer with `Date.now()` as a message id when the body carried no result,
	 * and the bogus id then failed on `editMessageText` in exactly the same
	 * silent way — the progress message froze and nothing reported why. Both
	 * halves have to be checked, or the check is theatre.
	 */
	private async callApi<T>(
		method: string,
		body: Record<string, unknown>,
	): Promise<T> {
		const res = await fetch(
			`https://api.telegram.org/bot${this.opts.botToken}/${method}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			result?: T;
			description?: string;
			error_code?: number;
		};
		if (!res.ok || data.ok !== true) {
			const why = data.description ?? `HTTP ${res.status}`;
			throw new Error(`Telegram ${method} 失败: ${why}`);
		}
		return data.result as T;
	}
	onMessage(h: (m: InboundMessage) => void): () => void {
		this.handler = h;
		return () => {
			this.handler = null;
		};
	}
	async start(): Promise<void> {
		this.stopped = false;
		this.lastErrorAtMs = 0;
		this.lastError = undefined;
		this.down = false;
		// Seed the window at start so a gateway still dialling out is not read as
		// an outage before its first poll lands.
		this.lastOkAtMs = Date.now();
		try {
			const me = await this.callApi<{ username?: string }>("getMe", {});
			if (me?.username) this.botUsername = me.username;
		} catch {}
		void this.poll();
	}
	async stop(): Promise<void> {
		this.stopped = true;
		// Wake the backoff so the loop ends now rather than after a full delay.
		this.wake?.();
		this.wake = null;
	}
	/** Sleep, but stand down the moment stop() is called. */
	private async backoff(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			this.wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.wake = null;
	}
	/**
	 * The poll loop retries forever, so this object outlives any outage and its
	 * existence says nothing about whether a reply could be delivered. Answer
	 * from the last completed round trip instead.
	 */
	getHealth(): ChannelHealth {
		if (this.stopped) {
			return {
				state: "stopped",
				lastOkAtMs: this.lastOkAtMs,
				lastErrorAtMs: this.lastErrorAtMs,
				...(this.lastError ? { lastError: this.lastError } : {}),
			};
		}
		return {
			// An explicit flag, not a comparison of the two timestamps: a start
			// and its first failure routinely land in the same millisecond, and
			// `lastErrorAtMs > lastOkAtMs` would call that healthy.
			state: this.down ? "reconnecting" : "connected",
			lastOkAtMs: this.lastOkAtMs,
			lastErrorAtMs: this.lastErrorAtMs,
			...(this.lastError ? { lastError: this.lastError } : {}),
		};
	}
	private async poll(): Promise<void> {
		while (!this.stopped) {
			const startedAt = Date.now();
			try {
				const res = await fetch(
					`https://api.telegram.org/bot${this.opts.botToken}/getUpdates?offset=${this.offset}&timeout=30`,
				);
				// Telegram reports auth and rate-limit failures as ordinary HTTP
				// responses with an `ok:false` body, so a 401 parses fine. Reading
				// reachability off the round trip alone would call a revoked token
				// healthy; the status line is what actually proves the API is
				// serving this bot.
				if (!res.ok) {
					throw new Error(`getUpdates failed: HTTP ${res.status}`);
				}
				const data = (await res.json()) as {
					ok?: boolean;
					description?: string;
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
				// getUpdates reports a revoked token as HTTP 200 with `ok:false`,
				// so the status line alone would call a dead bot connected.
				if (data.ok !== true) {
					throw new Error(
						`getUpdates failed: ${data.description ?? "ok=false"}`,
					);
				}
				// A completed round trip — even with zero updates — proves the API is
				// reachable, which is all getHealth() reports on.
				this.lastOkAtMs = Date.now();
				this.lastError = undefined;
				this.down = false;
				for (const u of data.result ?? []) {
					this.offset = u.update_id + 1;
					const m = u.message as
						| {
								message_id: number;
								chat: { id: number; type: string };
								from?: { id: number; first_name?: string };
								text?: string;
								entities?: Array<{
									type: string;
									offset: number;
									length: number;
								}>;
								reply_to_message?: { from?: { is_bot?: boolean } };
						  }
						| undefined;
					if (!m?.text) continue;
					const isPrivate = m.chat.type === "private";
					const isReplyToBot = Boolean(m.reply_to_message?.from?.is_bot);
					let mentioned = false;
					if (this.botUsername) {
						mentioned = m.text
							.toLowerCase()
							.includes(`@${this.botUsername.toLowerCase()}`);
					}
					if (!mentioned && Array.isArray(m.entities)) {
						mentioned = m.entities.some((e) => e.type === "mention");
					}
					if (!mentioned && !this.botUsername && !m.entities) {
						mentioned = m.text.includes("@");
					}
					const mentionBot =
						isPrivate || shouldRespondInGroup(m.text, mentioned, isReplyToBot);
					this.handler?.({
						messageId: `tg-${u.update_id}`,
						chatId: String(m.chat.id),
						chatType: isPrivate ? "p2p" : "group",
						senderId: String(m.from?.id ?? 0),
						senderName: m.from?.first_name,
						text: m.text,
						mentionBot,
						timestampMs: Date.now(),
					});
				}
			} catch (error) {
				this.lastErrorAtMs = Date.now();
				this.lastError = error instanceof Error ? error.message : String(error);
				this.down = true;
				await this.backoff(3000);
				continue;
			}
			// Pace the success path too; see MIN_POLL_INTERVAL_MS. stop() cuts the
			// wait short, so a shutdown never waits out the remainder.
			await this.backoff(
				Math.max(0, MIN_POLL_INTERVAL_MS - (Date.now() - startedAt)),
			);
		}
	}
	/** One message on the wire; no chunking, no truncation. */
	private async sendOne(
		chatId: string,
		text: string,
		replyTo?: string,
	): Promise<string> {
		const result = await this.callApi<{ message_id: number }>("sendMessage", {
			chat_id: chatId,
			text,
			...(this.opts.parseMode === "markdownV2"
				? { parse_mode: "MarkdownV2" }
				: {}),
			...(replyTo && /^\d+$/.test(replyTo)
				? { reply_to_message_id: Number(replyTo) }
				: {}),
		});
		return String(result?.message_id ?? "");
	}

	/**
	 * Send `text`, spilling past one message into follow-ups.
	 *
	 * The old body did `text.slice(0, 4000)` and discarded the rest, so a 6000
	 * character answer reached the user as its first 4000 characters with no
	 * marker that anything was missing. Splitting instead is what dsh-im does
	 * and it is the only version of this that does not lose the tail.
	 */
	async sendText(
		chatId: string,
		text: string,
		replyTo?: string,
	): Promise<string> {
		const chunks = chunkForTelegram(text, this.opts.parseMode);
		if (chunks.length === 0) return "";
		const first = await this.sendOne(chatId, chunks[0], replyTo);
		for (const chunk of chunks.slice(1)) {
			await this.sendOne(chatId, chunk);
		}
		return first;
	}

	/**
	 * Replace the placeholder with the final answer, spilling any overflow into
	 * new messages.
	 *
	 * Returns every message id involved, in order, so a caller that wants to
	 * clean up after itself knows how many messages the answer actually cost.
	 */
	async finishText(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<string[]> {
		const chunks = chunkForTelegram(text, this.opts.parseMode);
		if (chunks.length === 0) return [messageId];
		const ids: string[] = [];
		// Editing is the part that can fail on its own (the message may have
		// aged out, or been deleted), so a failure here still has a path to the
		// user: the first chunk is sent fresh instead.
		try {
			await this.editOne(chatId, messageId, chunks[0]);
			ids.push(messageId);
		} catch {
			ids.push(await this.sendOne(chatId, chunks[0]));
		}
		for (const chunk of chunks.slice(1)) {
			ids.push(await this.sendOne(chatId, chunk));
		}
		return ids;
	}

	private async editOne(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		const id = Number(messageId);
		if (!Number.isSafeInteger(id)) {
			throw new Error(`Telegram message id 非法: ${messageId}`);
		}
		await this.callApi("editMessageText", {
			chat_id: chatId,
			message_id: id,
			text,
			...(this.opts.parseMode === "markdownV2"
				? { parse_mode: "MarkdownV2" }
				: {}),
		});
	}

	async editText(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		const chunks = chunkForTelegram(text, this.opts.parseMode);
		if (chunks.length === 0) return;
		await this.editOne(chatId, messageId, chunks[0]);
		for (const chunk of chunks.slice(1)) {
			await this.sendOne(chatId, chunk);
		}
	}
	async sendImage(
		chatId: string,
		buf: Buffer,
		filename: string,
	): Promise<void> {
		await this.sendMultipart("sendPhoto", chatId, "photo", buf, filename);
	}
	async sendFile(chatId: string, buf: Buffer, filename: string): Promise<void> {
		await this.sendMultipart("sendDocument", chatId, "document", buf, filename);
	}
	/**
	 * Multipart upload with the same both-halves check as `callApi`: these used
	 * to await the fetch and discard the body, so a 10MB file rejected for
	 * exceeding the limit looked exactly like a successful upload.
	 */
	private async sendMultipart(
		method: string,
		chatId: string,
		field: string,
		buf: Buffer,
		filename: string,
	): Promise<void> {
		const form = new FormData();
		form.append("chat_id", chatId);
		form.append(field, new Blob([new Uint8Array(buf)]), filename);
		const res = await fetch(
			`https://api.telegram.org/bot${this.opts.botToken}/${method}`,
			{ method: "POST", body: form },
		);
		const data = (await res.json().catch(() => ({}))) as {
			ok?: boolean;
			description?: string;
		};
		if (!res.ok || data.ok !== true) {
			throw new Error(
				`Telegram ${method} 失败: ${data.description ?? `HTTP ${res.status}`}`,
			);
		}
	}
}
