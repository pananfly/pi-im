export interface InboundMessage {
	messageId: string;
	chatId: string;
	chatType: "p2p" | "group";
	senderId: string;
	senderName?: string;
	text: string;
	mentionBot?: boolean;
	hasImage?: boolean;
	timestampMs: number;
}
/**
 * Whether the channel's transport is actually usable right now.
 *
 * "Started" and "reachable" are different states. Telegram's long poll and
 * Feishu's WebSocket both retry forever internally, so a gateway object
 * outlives any network outage — and a revoked token or a disabled app never
 * surfaces at all. `/status` needs the second fact, not the first.
 */
export type ChannelHealthState = "connected" | "reconnecting" | "stopped";

export interface ChannelHealth {
	state: ChannelHealthState;
	/** Last successful transport round trip, epoch ms; 0 if never. */
	lastOkAtMs: number;
	/** Last transport failure, epoch ms; 0 if never. */
	lastErrorAtMs: number;
	/** Short, redacted reason for the most recent failure. */
	lastError?: string;
}

export interface ChannelLike {
	sendText(chatId: string, text: string, replyTo?: string): Promise<string>;
	editText(chatId: string, messageId: string, text: string): Promise<void>;
	sendImage?(chatId: string, buf: Buffer, filename: string): Promise<void>;
	sendFile?(chatId: string, buf: Buffer, filename: string): Promise<void>;
	/**
	 * Replace the placeholder with a final answer that may exceed one message.
	 *
	 * Separate from `editText` because "deliver an answer" and "retarget a
	 * message" are not the same operation once the answer outgrows a message:
	 * the overflow has to go somewhere, and only the transport knows where that
	 * boundary is. Returns every message id the answer ended up occupying.
	 */
	finishText?(
		chatId: string,
		messageId: string,
		text: string,
	): Promise<string[]>;
	/** Interactive-card presentation; absent on channels without cards. */
	sendCard?(chatId: string, card: Record<string, unknown>): Promise<string>;
	updateCard?(messageId: string, card: Record<string, unknown>): Promise<void>;
	/** Transport reachability; absent on channels that cannot report it. */
	getHealth?(): ChannelHealth;
}

/**
 * How long a transport may stay outside `connected` before pi-web stops keeping
 * the session alive for it.
 *
 * Both transports retry internally, so a short blip heals on its own and must
 * not cost the user their session. But "retrying forever" also means a dead
 * network looks exactly like a healthy one indefinitely — past this window the
 * session is released so it can be reaped and, with it, this extension
 * reloaded by whatever starts it next.
 */
export const CHANNEL_HEALTH_GRACE_MS = 90_000;

/**
 * Whether a channel is good enough to keep its session alive right now.
 *
 * A channel with no health reporting at all is treated as healthy: it is
 * running, and inventing an outage for a transport that simply cannot answer
 * would shut down working sessions.
 */
export function isChannelHealthy(
	health: ChannelHealth | undefined,
	now: number = Date.now(),
	graceMs: number = CHANNEL_HEALTH_GRACE_MS,
): boolean {
	if (!health) return true;
	if (health.state === "stopped") return false;
	if (health.state === "connected") return true;
	// reconnecting: inside the grace window the outage may still heal.
	return now - health.lastErrorAtMs < graceMs;
}

/** Render one health line for `/status`: state plus how long it has been that way. */
export function describeChannelHealth(
	health: ChannelHealth | undefined,
	now: number = Date.now(),
): string {
	if (!health) return "运行中";
	if (health.state === "stopped") return "已停止";
	if (health.state === "connected") {
		const secs = health.lastOkAtMs
			? Math.floor((now - health.lastOkAtMs) / 1000)
			: -1;
		return secs < 0 ? "运行中" : `运行中(最近成功 ${secs}s 前)`;
	}
	const since = health.lastErrorAtMs
		? ` (${Math.floor((now - health.lastErrorAtMs) / 1000)}s)`
		: "";
	const reason = health.lastError ? `: ${health.lastError}` : "";
	return `重连中${since}${reason}`;
}

/** How a turn's progress is shown while the agent works. */
export type ProgressMode = "text" | "card";

export interface ProgressRenderer {
	/** Placeholder to show before the run starts. */
	start(chatId: string, queuedPos: number): Promise<void>;
	/** Throttled refresh; reads the shared turn state and writes if changed. */
	update(): Promise<void>;
	/** Replace the placeholder with the final answer. */
	finish(finalText: string): Promise<void>;
}
