// src/controller.ts
import { BatchCollector } from "./core/batch.js";
import { MessageDeduplicator } from "./core/dedup.js";
import { SerialMessageQueue } from "./core/queue.js";
import type {
	ChannelLike,
	InboundMessage,
	ProgressMode,
	ProgressRenderer,
} from "./core/types.js";
import { describeChannelHealth } from "./core/types.js";
import { imDebug } from "./debug.js";
import { buildProgressCards, type ProgressState } from "./feishu/card.js";
import { getStrings, type Locale } from "./i18n.js";
import type { PiAgentBridge } from "./pi-bridge.js";
import { BridgeBusyError } from "./pi-bridge.js";
import { RuntimeNotReadyError, StaleExtensionApiError } from "./pi-ref.js";
import { parseRemoteCommand, renderHelp } from "./remote-commands.js";
import {
	consumeUiAnswer,
	type ImSessionScope,
	runAsImTurn,
} from "./ui-bridge.js";
export interface PiModelRef {
	id: string;
	name?: string;
	provider?: string;
}
/** Outcome of a /thinking request, including pi's silent clamping. */
export interface ThinkingResult {
	ok: boolean;
	/** The level actually in effect once the call returned. */
	level?: string;
	/** The request exceeded what the model supports and pi stepped it down. */
	clamped?: boolean;
	reason?: "invalid" | "stale" | "no-session";
	/** Levels the current model supports. */
	available?: string[];
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
	/**
	 * Apply a thinking level and report what actually took effect.
	 *
	 * pi clamps the request to what the model declares in thinkingLevelMap, so the
	 * effective level may differ from the requested one — `clamped` says so.
	 */
	setThinking?: (level: string) => ThinkingResult;
	listThinkingLevels?: () => string[];
	readHistory?: (n: number) => string[];
	listWorkspaces?: () => string[];
	listSessions?: () => Array<{ id: string; title?: string; file?: string }>;
	switchWorkspace?: (dir: string) => Promise<string>;
	switchSession?: (idOrIndex: string) => Promise<string>;
	/**
	 * Persist a progress-mode change, then apply it to the live controller.
	 *
	 * Optional: a controller built without the extension attached (tests, or a
	 * direct embed) has nowhere to write, and must be told so rather than left
	 * to report a switch that the next restart undoes.
	 */
	setProgressMode?: (mode: ProgressMode) => Promise<void>;
	/** Whether IM session-control commands have a live context. Surfaced in /status. */
	canControlSession?: () => boolean;
}
/** Throttle for progress-message edits (ms). */
const PROGRESS_EDIT_MIN_INTERVAL = 1500;
/** Plain-text answers have no card budget to spill into, so they are cut here. */
const TEXT_ANSWER_CHARS = 8000;
export class ImController {
	queue = new SerialMessageQueue();
	dedup = new MessageDeduplicator();
	batch: BatchCollector;
	runtime: PiRuntimeHooks | undefined;
	private locale: Locale;
	private allowlist: string[];
	private queuedSteers = new Map<string, string[]>();
	constructor(
		private channel: ChannelLike,
		private agent: PiAgentBridge,
		private opts: {
			allowlist: string[];
			channelName: string;
			locale?: Locale;
			/** "card" needs a card-capable channel; it silently falls back otherwise. */
			progressMode?: ProgressMode;
			/**
			 * 此刻这个 bot 驱动的是哪个 pi 会话。
			 *
			 * 回合要带上它,UI 桥的兜底分支才能分清「只有一个 IM 回合在跑」时的提问是
			 * 不是自己这一轮的:同一个 pi 进程里还开着别的会话(Pi Web 的标签页)时,
			 * 它们的提问不能搬进聊天。给不出身份就留空,退回旧的宽松行为。
			 */
			sessionScope?: () => ImSessionScope | null;
		},
	) {
		this.locale = opts.locale ?? "zh";
		this.batch = new BatchCollector(this.locale);
		this.allowlist = [...opts.allowlist];
	}
	setLocale(locale: Locale): void {
		this.locale = locale;
		this.batch.setLocale(locale);
	}
	private get s() {
		return getStrings(this.locale);
	}
	/**
	 * Fail closed. This bot drives a pi session that holds bash/read/write/edit,
	 * so "no allowlist configured" must never mean "open to everyone" — that
	 * turned a leaked bot token into remote code execution on the host. `["*"]`
	 * is the explicit opt-out, so forgetting to configure cannot reopen the door.
	 */
	private allowed(senderId: string): boolean {
		if (this.allowlist.includes("*")) return true;
		return this.allowlist.includes(senderId);
	}
	/** The channel this controller answers for: "feishu" or "telegram". */
	channelName(): string {
		return this.opts.channelName;
	}
	/**
	 * Send a standalone message, outside any turn's progress renderer.
	 *
	 * The UI bridge raises questions while a turn is still running: it cannot
	 * edit the progress card (that belongs to the running turn) and it must not
	 * wait for the turn to end (the turn is waiting on the answer). A plain
	 * message in the same chat is the only surface that works for both.
	 */
	async notifyChat(chatId: string, text: string): Promise<void> {
		await this.channel.sendText(chatId, text);
	}
	/**
	 * Flip the progress presentation for the NEXT turn.
	 *
	 * A turn in flight already holds its own renderer closure, so it finishes in
	 * the style it started in — no answer that is half a card and half a plain
	 * message. makeRenderer re-reads this on every turn.
	 */
	setProgressMode(mode: ProgressMode): void {
		this.opts.progressMode = mode;
	}
	/**
	 * The CONFIGURED mode, not the effective one: a channel without both
	 * sendCard and updateCard silently falls back to text in makeRenderer.
	 */
	progressMode(): ProgressMode {
		return this.opts.progressMode ?? "text";
	}
	/**
	 * Swap the allowlist at runtime. /tg allow must take effect immediately:
	 * an owner who unlocks the bot from the TUI and is still refused has no way
	 * to guess that a restart is what they are missing.
	 */
	setAllowlist(ids: string[]): void {
		this.allowlist = ids;
	}
	/** The TUI command that manages this channel's allowlist. */
	private adminCmd(): string {
		return this.opts.channelName === "feishu" ? "/feishu" : "/tg";
	}
	async handleInbound(m: InboundMessage): Promise<void> {
		imDebug(
			"inbound",
			this.channelName(),
			m.chatId,
			m.chatType,
			m.senderId,
			m.messageId,
			m.mentionBot ? "@bot" : "-",
			m.text,
		);
		if (this.dedup.seen(m.messageId)) {
			imDebug("drop:duplicate", m.messageId);
			return;
		}
		this.dedup.mark(m.messageId);
		if (Date.now() - m.timestampMs > 30 * 60 * 1000) {
			imDebug("drop:stale", m.timestampMs, Date.now() - m.timestampMs);
			return;
		}
		if (!this.allowed(m.senderId)) {
			// Say so, and hand back their own id: silently dropping leaves the
			// owner locked out with no idea why the bot went quiet.
			imDebug("drop:not-allowed", m.senderId);
			await this.channel
				.sendText(m.chatId, this.s.notAllowed(m.senderId, this.adminCmd()))
				.catch(() => undefined);
			return;
		}
		if (m.chatType === "group" && !m.mentionBot) {
			imDebug("drop:no-mention", m.chatId);
			return;
		}
		// 一次提问挂起时,这条消息多半是答案:先让 UI 桥消化,别把它当成新的
		// prompt 塞进队列(那会把答案排在一轮永远等不到答案的运行后面)。
		if (
			consumeUiAnswer(
				this.channelName(),
				m.chatId,
				m.text,
				this.locale,
				(chatId, text) => this.notifyChat(chatId, text),
			)
		) {
			imDebug("consume:answered", m.text);
			return;
		}
		const cmd = parseRemoteCommand(m.text);
		if (cmd) {
			await this.handleCommand(m, cmd.name, cmd.args);
			return;
		}
		if (this.batch.isActive(m.chatId)) {
			imDebug("batch:collect", this.channelName(), m.chatId, m.text);
			await this.channel.sendText(
				m.chatId,
				this.batch.collect(m.chatId, m.text),
			);
			return;
		}
		const pos = this.queue.size + 1;
		const queued = this.queuedSteers.get(m.chatId);
		let runPrompt = m.text;
		if (queued && queued.length > 0) {
			this.queuedSteers.delete(m.chatId);
			runPrompt = `${queued.map((st) => `[补充指令: ${st}]`).join("\n")}\n${m.text}`;
		}
		// 排队是"最安静"的一条路:前一轮还在等答案时,新消息既不跑也不回话。
		imDebug(
			"queue:enqueue",
			this.channelName(),
			m.chatId,
			pos,
			this.queue.size,
			runPrompt,
		);
		await this.queue.enqueue(m.chatId, async () => {
			imDebug("queue:start", m.chatId, m.messageId);
			const state: ProgressState = {
				activity: "",
				tools: [],
				thinking: [],
				steps: [],
				text: "",
				done: false,
				queued: pos,
			};
			const renderer = this.makeRenderer(state);
			await renderer.start(m.chatId, pos);

			let lastEdit = 0;
			const pushProgress = async () => {
				const now = Date.now();
				if (now - lastEdit < PROGRESS_EDIT_MIN_INTERVAL) return;
				lastEdit = now;
				await renderer.update().catch(() => undefined);
			};
			// A failing run must never reject out of the queue job: the gateway
			// calls `void handleInbound(...)`, so a rejection would be an unhandled
			// rejection and would take the whole pi process down with it.
			let out: string;
			try {
				out = await runAsImTurn(
					{
						channel: this.channelName(),
						chatId: m.chatId,
						group: m.chatType === "group",
						send: (chatId, text) => this.notifyChat(chatId, text),
						locale: () => this.locale,
						session: this.opts.sessionScope?.() ?? null,
					},
					() =>
						this.agent.run(runPrompt, {
							onText: (t) => {
								state.text = t;
								void pushProgress();
							},
							onThinking: (t, index) => {
								state.steps = state.steps ?? [];
								const lastStep = state.steps.at(-1);
								if (
									lastStep &&
									lastStep.kind === "thinking" &&
									(index === undefined || lastStep.messageIndex === index)
								) {
									lastStep.text = t;
									if (state.thinking.length > 0) {
										state.thinking[state.thinking.length - 1] = t;
									} else {
										state.thinking.push(t);
									}
								} else {
									state.steps.push({
										kind: "thinking",
										text: t,
										...(index !== undefined ? { messageIndex: index } : {}),
									});
									state.thinking.push(t);
								}
								void pushProgress();
							},
							onToolStart: (run) => {
								state.activity = run.name;
								state.tools = [...state.tools, run];
								state.steps = state.steps ?? [];
								state.steps.push({ kind: "tool", tool: run });
								void pushProgress();
							},
							onToolEnd: (toolCallId, outcome) => {
								state.tools = state.tools.map((t) =>
									t.toolCallId === toolCallId ? { ...t, ...outcome } : t,
								);
								if (state.steps) {
									const target = state.steps.find(
										(s) =>
											s.kind === "tool" && s.tool.toolCallId === toolCallId,
									);
									if (target && target.kind === "tool") {
										Object.assign(target.tool, outcome);
									}
								}
								void pushProgress();
							},
						}),
				);
			} catch (e) {
				console.error("[pi-im] agent run failed:", e);
				out =
					e instanceof StaleExtensionApiError
						? e.message
						: e instanceof BridgeBusyError
							? this.s.bridgeBusy
							: e instanceof RuntimeNotReadyError
								? this.s.sessionNotReady
								: this.s.runFailed;
			}
			state.done = true;
			state.text = out.trim();
			await renderer.finish(state.text);
		});
	}

	/**
	 * Pick a progress presentation.
	 *
	 * Card mode needs BOTH sendCard and updateCard. A card we can post but not
	 * replace would leave the user staring at "处理中" forever — exactly the
	 * failure the text path used to have when editText silently no-op'd, which
	 * is why the capability check lives here rather than at the call site.
	 */
	private makeRenderer(state: ProgressState): ProgressRenderer {
		const s = this.s;
		const wantsCard =
			this.opts.progressMode === "card" &&
			typeof this.channel.sendCard === "function" &&
			typeof this.channel.updateCard === "function";
		if (!wantsCard) {
			let chatId = "";
			let msgId = "";
			return {
				start: async (cid, pos) => {
					chatId = cid;
					msgId = await this.channel.sendText(
						cid,
						pos > 1 ? s.progressQueued(pos) : s.progressWorking,
					);
				},
				update: async () => {
					const parts = ["⏳"];
					if (state.activity) parts.push(state.activity);
					if (state.text) parts.push(state.text.slice(-500));
					await this.channel
						.editText(chatId, msgId, parts.join("\n"))
						.catch(() => undefined);
				},
				finish: async (final) => {
					// A transport that can spill knows where one message ends; one
					// that cannot only has the character cap it applies itself.
					// Truncating here instead would silently drop the tail of any
					// answer longer than the cap, with nothing on screen saying so.
					if (this.channel.finishText) {
						await this.channel.finishText(chatId, msgId, final).catch((e) => {
							console.error("[pi-im] 收尾消息写入失败,改用发送:", e);
							return this.channel.sendText(chatId, final);
						});
						return;
					}
					await this.channel
						.editText(chatId, msgId, final.slice(0, TEXT_ANSWER_CHARS))
						.catch(() =>
							this.channel.sendText(chatId, final.slice(0, TEXT_ANSWER_CHARS)),
						);
				},
			};
		}

		let chatId = "";
		// One turn is a LIST of cards, not one card: Feishu caps a card at ~30KB
		// and 5 rendered tables and rejects the whole write when either is
		// exceeded, which would freeze the card on its previous content
		// mid-turn. `buildProgressCards` spills the overflow into extra
		// messages instead; this renderer patches the ones it already sent and
		// sends the new tail.
		const cardIds: string[] = [];
		const rendered = new Map<string, string>();
		let broken = false;
		const locale = this.locale;

		const contents = () =>
			buildProgressCards(state, locale).map((c) =>
				JSON.stringify(c as unknown as Record<string, unknown>),
			);

		let syncTail: Promise<void> = Promise.resolve();
		const sync = async (): Promise<void> => {
			const run = syncTail
				.catch(() => {})
				.then(async () => {
					// Serialize the whole list before the first await: a concurrent
					// refresh must not see half of it, and the patch of record lets an
					// unchanged card skip the round trip entirely.
					const payloads = contents();
					for (let i = 0; i < payloads.length; i += 1) {
						const content = payloads[i];
						const id = cardIds[i];
						if (id) {
							if (rendered.get(id) === content) continue;
							await this.channel.updateCard?.(
								id,
								JSON.parse(content) as Record<string, unknown>,
							);
						} else {
							const sent = await this.channel.sendCard?.(
								chatId,
								JSON.parse(content) as Record<string, unknown>,
							);
							cardIds.push(sent ?? "");
						}
						rendered.set(cardIds[i], content);
					}
				});
			syncTail = run;
			await run;
		};

		return {
			start: async (cid) => {
				chatId = cid;
				await sync();
			},
			update: async () => {
				if (broken || cardIds.length === 0) return;
				try {
					await sync();
				} catch (e) {
					// A rejected write is not a transient blip — retrying the same
					// payload just burns the 1.5s tick. Give up on the card, say why
					// in the log, and let finish() deliver the answer as a plain
					// message so the user is never left staring at a frozen
					// "处理中".
					broken = true;
					console.error("[pi-im] 飞书进度卡片写入失败,本轮改用纯文本:", e);
				}
			},
			finish: async (final) => {
				try {
					await sync();
				} catch (e) {
					broken = true;
					console.error("[pi-im] 飞书进度卡片收尾失败,改用纯文本:", e);
				}
				if (broken || cardIds.length === 0) {
					await this.channel.sendText(chatId, final).catch(() => undefined);
				}
			},
		};
	}
	private async handleCommand(
		m: InboundMessage,
		name: string,
		args: string,
	): Promise<void> {
		const s = this.s;
		switch (name) {
			case "/help":
				await this.channel.sendText(m.chatId, renderHelp(this.locale));
				return;
			case "/version":
				await this.channel.sendText(m.chatId, s.statusVersion);
				return;
			case "/batch":
				if (m.chatType !== "p2p") {
					await this.channel.sendText(m.chatId, s.batchDmOnly);
					return;
				}
				await this.channel.sendText(m.chatId, this.batch.start(m.chatId));
				return;
			case "/send": {
				const all = this.batch.submit(m.chatId);
				if (!all.trim()) {
					await this.channel.sendText(m.chatId, s.batchNone);
					return;
				}
				await this.handleInbound({
					...m,
					text: all,
					messageId: `${m.messageId}-send`,
				});
				return;
			}
			case "/cancel":
				await this.channel.sendText(
					m.chatId,
					this.batch.cancel(m.chatId) ? s.batchCancelled : s.batchNone,
				);
				return;
			case "/repair":
				await this.channel.sendText(
					m.chatId,
					this.opts.channelName === "telegram"
						? s.repairUnsupportedTg
						: s.repairFeishuHint,
				);
				return;
			case "/status": {
				const r = this.runtime;
				const health = this.channel.getHealth?.();
				const connDesc = describeChannelHealth(health);
				const lines = [
					`${s.statusVersion}/${this.opts.channelName}`,
					`连接: ${connDesc}`,
					s.statusQueue(this.queue.size),
					s.statusProgressMode(this.progressMode()),
				];
				if (r?.cwd) lines.push(s.statusCwd(r.cwd()));
				if (r?.sessionFile) lines.push(s.statusSession(r.sessionFile()));
				if (r?.model) {
					const md = r.model();
					if (md) {
						const label = `${md.name ?? md.id}${md.provider ? ` (${md.provider})` : ""}`;
						lines.push(s.statusModel(label));
					}
				}
				if (r?.thinking) {
					const t = r.thinking();
					if (t) lines.push(s.statusThinking(t));
				}
				if (r?.contextPercent) {
					const p = r.contextPercent();
					if (typeof p === "number") lines.push(s.statusContext(p));
				}
				if (r?.isRunning) lines.push(s.statusRunning(r.isRunning()));
				if (r?.canControlSession) {
					lines.push(s.statusSessionControl(r.canControlSession()));
				}
				await this.channel.sendText(m.chatId, lines.join("\n"));
				return;
			}
			case "/new":
				if (this.runtime?.newSession) {
					try {
						const ok = await this.runtime.newSession();
						await this.channel.sendText(m.chatId, ok ? s.newDone : s.newFail);
					} catch (e) {
						await this.channel.sendText(
							m.chatId,
							e instanceof Error ? e.message : s.newFail,
						);
					}
				} else {
					await this.channel.sendText(m.chatId, s.newUnbound);
				}
				return;
			case "/stop":
				this.agent.cancel("IM /stop");
				this.runtime?.abort?.();
				await this.channel.sendText(m.chatId, s.stopDone);
				return;
			case "/steer":
				if (!args) {
					await this.channel.sendText(m.chatId, s.steerUsage);
					return;
				}
				if (this.agent.isActive() && this.agent.steer(args)) {
					await this.channel.sendText(m.chatId, s.steerMerged);
				} else {
					const queued = this.queuedSteers.get(m.chatId) ?? [];
					queued.push(args);
					this.queuedSteers.set(m.chatId, queued);
					await this.channel.sendText(m.chatId, s.steerQueued(args));
				}
				return;
			case "/compact":
				this.runtime?.compact?.();
				await this.channel.sendText(m.chatId, s.compactDone);
				return;
			case "/clear":
				await this.channel.sendText(m.chatId, s.clearUnsupported);
				return;
			case "/models": {
				const list = this.runtime?.listModels?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(m.chatId, s.modelsEmpty);
					return;
				}
				const cur = this.runtime?.model?.()?.id;
				const lines = list.slice(0, 30).map((md, i) => {
					const mark = cur && (md.id === cur || md.name === cur) ? " *" : "";
					return `${i + 1}. ${md.name ?? md.id}${md.provider ? ` [${md.provider}]` : ""}${mark}`;
				});
				await this.channel.sendText(
					m.chatId,
					`${s.modelsList(list.length)}\n${lines.join("\n")}\n${s.modelsHint}`,
				);
				return;
			}
			case "/model": {
				if (!args) {
					const curM = this.runtime?.model?.();
					const curT = this.runtime?.thinking?.();
					await this.channel.sendText(
						m.chatId,
						curM ? s.modelCurrent(curM.name ?? curM.id, curT) : s.modelUnknown,
					);
					return;
				}
				if (this.runtime?.isRunning?.()) {
					await this.channel.sendText(m.chatId, s.modelBusy);
					return;
				}
				try {
					const switched = await this.runtime?.switchModel?.(args);
					await this.channel.sendText(
						m.chatId,
						switched
							? s.modelSwitched(switched.name ?? switched.id, switched.id)
							: s.modelSwitchedPlain,
					);
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						s.modelSwitchFail(e instanceof Error ? e.message : String(e)),
					);
				}
				return;
			}
			case "/thinking":
			case "/reasoning": {
				if (!args) {
					const cur = this.runtime?.thinking?.();
					const levels = this.runtime?.listThinkingLevels?.() ?? [];
					const list = levels.length
						? s.thinkingLevels(levels.join(" / "))
						: s.thinkingLevelsUnknown;
					await this.channel.sendText(
						m.chatId,
						`${cur ? s.thinkingCurrent(cur) : s.thinkingUnknown}\n${list}\n${s.thinkingExample}`,
					);
					return;
				}
				const r = this.runtime?.setThinking?.(args.trim().toLowerCase());
				if (!r?.ok) {
					const avail = r?.available?.join(" / ");
					const body =
						r?.reason === "stale"
							? s.sessionStale
							: r?.reason === "no-session"
								? s.thinkingNoSession
								: s.thinkingBad(args, avail);
					await this.channel.sendText(m.chatId, body);
					return;
				}
				await this.channel.sendText(
					m.chatId,
					r.clamped
						? s.thinkingClamped(
								args.trim().toLowerCase(),
								r.level ?? "",
								r.available?.join(" / "),
							)
						: s.thinkingSwitched(r.level ?? args.trim().toLowerCase()),
				);
				return;
			}
			case "/history": {
				const n = Math.min(Math.max(Number.parseInt(args, 10) || 3, 1), 5);
				const items = this.runtime?.readHistory?.(n) ?? [];
				if (items.length === 0) {
					await this.channel.sendText(m.chatId, s.historyEmpty);
					return;
				}
				const { formatHistoryPreview } = await import("./remote-commands.js");
				await this.channel.sendText(m.chatId, formatHistoryPreview(items, n));
				return;
			}
			case "/wsl": {
				const list = this.runtime?.listWorkspaces?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(m.chatId, s.wslEmpty);
					return;
				}
				await this.channel.sendText(
					m.chatId,
					`${s.wslTitle}\n${list.map((w, i) => `${i + 1}. ${w}${i === 0 ? s.wslCurrent : ""}`).join("\n")}\n${s.wslHint}`,
				);
				return;
			}
			case "/workspace":
			case "/ws": {
				if (!args) {
					await this.channel.sendText(m.chatId, s.workspaceUsage);
					return;
				}
				try {
					const msg = await this.runtime?.switchWorkspace?.(args);
					await this.channel.sendText(m.chatId, msg ?? s.workspaceUsage);
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						s.workspaceFail(e instanceof Error ? e.message : String(e)),
					);
				}
				return;
			}
			case "/sessionlist":
			case "/sessions": {
				const list = this.runtime?.listSessions?.() ?? [];
				if (list.length === 0) {
					await this.channel.sendText(m.chatId, s.sessionEmpty);
					return;
				}
				const curFile = this.runtime?.sessionFile?.();
				const shown = list.slice(0, 20);
				await this.channel.sendText(
					m.chatId,
					`${s.sessionTitle(list.length)}\n${shown.map((x, i) => `${i + 1}. ${(x.title ?? s.sessionUntitled).slice(0, 60)} (${x.id.slice(0, 8)})${curFile && x.file === curFile ? " *" : ""}`).join("\n")}\n${s.sessionHint}`,
				);
				return;
			}
			case "/session": {
				if (!args) {
					await this.channel.sendText(m.chatId, s.sessionUsage);
					return;
				}
				try {
					const msg = await this.runtime?.switchSession?.(args);
					await this.channel.sendText(m.chatId, msg ?? s.sessionUsage);
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						s.sessionFail(e instanceof Error ? e.message : String(e)),
					);
				}
				return;
			}
			case "/feishu": {
				// Telegram's gateway has no sendCard at all, so a switch there is
				// a no-op the user cannot see. Say so instead of taking the tap.
				if (this.opts.channelName !== "feishu") {
					await this.channel.sendText(m.chatId, s.progressModeTgOnly);
					return;
				}
				const want = args.trim().toLowerCase();
				if (!want) {
					await this.channel.sendText(
						m.chatId,
						`${s.progressModeCurrent(this.progressMode())}\n${s.progressModeUsage}`,
					);
					return;
				}
				if (want !== "text" && want !== "card") {
					await this.channel.sendText(
						m.chatId,
						`${s.progressModeUsage}\n${s.progressModeCurrent(this.progressMode())}`,
					);
					return;
				}
				// No hook means nowhere to persist it. Reporting "switched" here
				// is the one lie the user would only discover after a restart.
				if (!this.runtime?.setProgressMode) {
					await this.channel.sendText(m.chatId, s.progressModePersistFail());
					return;
				}
				try {
					await this.runtime.setProgressMode(want);
					await this.channel.sendText(m.chatId, s.progressModeSet(want));
				} catch (e) {
					await this.channel.sendText(
						m.chatId,
						s.progressModePersistFail(
							e instanceof Error ? e.message : String(e),
						),
					);
				}
				return;
			}
			default:
				await this.channel.sendText(m.chatId, s.cmdFallback(name, args));
				return;
		}
	}
}
