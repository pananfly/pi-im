// src/pi-bridge.ts
/** One tool call for the duration of the turn, from start to its outcome. */
export interface ToolRun {
	toolCallId: string;
	name: string;
	/** One-line summary of the arguments, capped like pi-web's tool preview. */
	argsPreview: string;
	/** Wall time, only known once the tool finishes. */
	durationMs?: number;
	isError?: boolean;
	/** Short, already-truncated reason. Failures only. */
	errorText?: string;
}

export interface ToolOutcome {
	durationMs?: number;
	isError?: boolean;
	errorText?: string;
}

export interface ProgressObserver {
	onText(t: string): void;
	/** Full text of the thinking block currently in flight or just settled. */
	onThinking(t: string, index?: number): void;
	onToolStart(run: ToolRun): void;
	onToolEnd(toolCallId: string, outcome: ToolOutcome): void;
}

/**
 * Longest one-line argument summary on a tool row.
 *
 * Matches pi-web's `getToolPreview` cap so the same call reads identically in
 * both clients.
 */
const ARGS_PREVIEW_CHARS = 120;
/** Failure detail is a diagnostic aid, not a transcript; it stops at two lines. */
const ERROR_TEXT_CHARS = 200;

/**
 * Argument summary for a tool row, in the priority order pi-web uses:
 * command, path, file_path, pattern, query, then the first argument.
 */
export function previewToolArgs(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const input = args as Record<string, unknown>;
	const keys = Object.keys(input);
	if (keys.length === 0) return "";
	const pick = (key: string): string | undefined =>
		key in input ? String(input[key]).slice(0, ARGS_PREVIEW_CHARS) : undefined;
	const value =
		pick("command") ??
		pick("path") ??
		pick("file_path") ??
		pick("pattern") ??
		pick("query") ??
		String(input[keys[0]]).slice(0, ARGS_PREVIEW_CHARS);
	return value.replace(/\s+/g, " ").trim();
}

/**
 * First line of a failed tool's output.
 *
 * pi hands the raw tool result here, which reaches us as a string, as a
 * `{content: [{type:"text", text}]}` message, or as `{output}`. Anything
 * unrecognized yields "", and the row simply shows no detail.
 */
export function summarizeToolError(result: unknown): string {
	let text = "";
	if (typeof result === "string") {
		text = result;
	} else if (result && typeof result === "object") {
		const r = result as {
			content?: unknown;
			output?: unknown;
			error?: unknown;
		};
		if (typeof r.error === "string") text = r.error;
		else if (typeof r.output === "string") text = r.output;
		else if (Array.isArray(r.content)) {
			text = r.content
				.filter(
					(b): b is { type: string; text: string } =>
						!!b &&
						typeof b === "object" &&
						(b as { type?: string }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
				)
				.map((b) => b.text)
				.join("\n");
		}
	}
	const line =
		text
			.trim()
			.split(/\r?\n/)
			.find((l) => l.trim()) ?? "";
	if (!line) return "";
	return line.slice(0, ERROR_TEXT_CHARS).trim();
}

/**
 * Another run already owns the bridge.
 *
 * pi runs one prompt at a time, so a second message arriving from another
 * channel cannot start a turn. Reported separately so the UI can explain
 * "busy" rather than blaming a session swap.
 */
export class BridgeBusyError extends Error {
	constructor() {
		super("Pi 正在处理另一条消息。");
		this.name = "BridgeBusyError";
	}
}

/** One assistant message's worth of content, kept together. */
interface TurnMessage {
	text: string;
	thinking: string;
}

export class PiAgentBridge {
	private msgs: TurnMessage[] = [];
	private tools = new Map<string, ToolRun>();
	private toolOrder: string[] = [];
	private settled = false;
	private waiter: (() => void) | null = null;
	private cancelled = false;
	private running = false;
	private observer: ProgressObserver | null = null;
	private steerPending: string[] = [];
	/** Index in `msgs` of the message currently streaming, -1 when none. */
	private streamingIndex = -1;
	/**
	 * Id of the run that currently owns the mutable state above, null when idle.
	 *
	 * Ownership is per-run, not per-`running` flag: `settle()` clears `running`
	 * while the owning run is still draining its loop, and a new message must not
	 * be allowed to reset `msgs` out from under it.
	 */
	private owner: number | null = null;
	private nextRunId = 0;
	constructor(
		private send: (prompt: string) => Promise<void>,
		private steerSend?: (text: string) => Promise<boolean>,
	) {}
	async run(text: string, observer: ProgressObserver): Promise<string> {
		if (this.owner !== null) throw new BridgeBusyError();
		const runId = ++this.nextRunId;
		this.owner = runId;
		this.msgs = [];
		this.tools = new Map();
		this.toolOrder = [];
		this.streamingIndex = -1;
		this.settled = false;
		this.cancelled = false;
		this.running = true;
		this.observer = observer;
		this.steerPending = [];
		try {
			await this.send(text);
			while (!this.settled && !this.cancelled) {
				await new Promise<void>((r) => {
					this.waiter = r;
					setTimeout(r, 50);
				});
			}
			// Assistant prose only. Tools and thinking have their own card panels
			// now, so folding them in here printed every one of them twice.
			const out = this.msgs
				.map((m) => m.text)
				.filter(Boolean)
				.join("\n");
			observer.onText(out || "(空回复)");
			return out || "(空回复)";
		} finally {
			// A failed send must not leave the bridge looking busy forever —
			// that made every later message fail the same way.
			if (this.owner === runId) this.owner = null;
			this.running = false;
			this.observer = null;
		}
	}
	isActive(): boolean {
		return this.running && !this.settled && !this.cancelled;
	}
	cancel(_reason: string): void {
		this.cancelled = true;
		this.running = false;
		this.waiter?.();
	}
	steer(text: string): boolean {
		if (!this.isActive()) return false;
		this.steerPending.push(text);
		if (this.steerSend) {
			void this.steerSend(text).catch(() => undefined);
			return true;
		}
		return true;
	}
	drainSteer(): string[] {
		const out = [...this.steerPending];
		this.steerPending = [];
		return out;
	}
	/** Text and thinking carried by an assistant message, in one slot. */
	private assistantParts(msg: unknown): TurnMessage {
		const out: TurnMessage = { text: "", thinking: "" };
		const m = msg as { role?: string; content?: unknown } | null | undefined;
		if (!m || m.role !== "assistant") return out;
		const content = m.content;
		if (typeof content === "string") {
			out.text = content.trim() ? content : "";
			return out;
		}
		if (!Array.isArray(content)) return out;
		const texts: string[] = [];
		const thinking: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: string; text?: unknown; thinking?: unknown };
			if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
				texts.push(p.text);
			} else if (
				p.type === "thinking" &&
				typeof p.thinking === "string" &&
				p.thinking.trim()
			) {
				thinking.push(p.thinking);
			}
		}
		out.text = texts.join("\n");
		out.thinking = thinking.join("\n");
		return out;
	}
	/**
	 * Store one assistant message, replacing the streaming slot when there is one.
	 *
	 * Notifications fire only on an actual change. Every streamed chunk carries
	 * the whole message, so the text grows in place; re-notifying an identical
	 * value would either repeat the card's answer or, worse, append another copy
	 * of a thinking block the reader has already seen.
	 */
	private record(parts: TurnMessage, streaming: boolean): void {
		if (!parts.text && !parts.thinking) return;
		const index =
			this.streamingIndex >= 0 ? this.streamingIndex : this.msgs.length;
		const prev = this.msgs[index];
		if (parts.text && (!prev || prev.text !== parts.text)) {
			this.observer?.onText(parts.text);
		}
		if (parts.thinking && (!prev || prev.thinking !== parts.thinking)) {
			this.observer?.onThinking(parts.thinking, index);
		}
		if (index < this.msgs.length) {
			this.msgs[index] = parts;
		} else {
			this.msgs.push(parts);
		}
		if (streaming) {
			// A streamed message keeps the slot open: the next chunk re-sends the
			// whole thing. A settled one closes it.
			this.streamingIndex = index;
		} else {
			this.streamingIndex = -1;
		}
	}
	/**
	 * Settled assistant message (message_end).
	 *
	 * When this message was streamed, it replaces the entry the streaming path
	 * was rewriting instead of adding a second copy.
	 */
	captureMessage(msg: unknown): void {
		if (this.owner === null) return;
		this.record(this.assistantParts(msg), false);
	}
	/**
	 * Streaming assistant message (message_update).
	 *
	 * Every chunk carries the *whole* message so far, so each one must overwrite
	 * the entry in flight. Appending them is what made a five-character reply
	 * render as five lines.
	 */
	captureStreamingMessage(msg: unknown): void {
		if (this.owner === null) return;
		this.record(this.assistantParts(msg), true);
	}
	captureToolStart(toolCallId: string, name: string, args: unknown): void {
		// Unowned turns belong to some other pi-web session; recording them would
		// put another session's tools in this chat's card.
		if (this.owner === null) return;
		const run: ToolRun = {
			toolCallId,
			name,
			argsPreview: previewToolArgs(args),
		};
		this.tools.set(toolCallId, run);
		this.toolOrder.push(toolCallId);
		try {
			this.observer?.onToolStart({ ...run });
		} catch {}
	}
	captureToolEnd(
		toolCallId: string,
		result: unknown,
		isError: boolean,
		durationMs?: number,
	): void {
		if (this.owner === null) return;
		const run = this.tools.get(toolCallId);
		if (!run) return;
		run.durationMs =
			typeof durationMs === "number" ? durationMs : run.durationMs;
		run.isError = isError;
		run.errorText = isError
			? summarizeToolError(result) || undefined
			: undefined;
		try {
			this.observer?.onToolEnd(toolCallId, {
				...(typeof run.durationMs === "number"
					? { durationMs: run.durationMs }
					: {}),
				isError: run.isError,
				...(run.errorText ? { errorText: run.errorText } : {}),
			});
		} catch {}
	}
	settle(): void {
		this.settled = true;
		this.running = false;
		this.waiter?.();
	}
}
