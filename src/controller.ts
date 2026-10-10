// src/controller.ts
import { BatchCollector } from "./core/batch.js";
import { MessageDeduplicator } from "./core/dedup.js";
import { SerialMessageQueue } from "./core/queue.js";
import type { ChannelLike, InboundMessage } from "./core/types.js";
import { getStrings, type Locale } from "./i18n.js";
import type { PiAgentBridge } from "./pi-bridge.js";
import { parseRemoteCommand, renderHelp } from "./remote-commands.js";
export interface PiModelRef {
	id: string;
	name?: string;
	provider?: string;
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
	setThinking?: (level: string) => boolean;
	readHistory?: (n: number) => string[];
	listWorkspaces?: () => string[];
	listSessions?: () => Array<{ id: string; title?: string; file?: string }>;
	switchWorkspace?: (dir: string) => Promise<string>;
	switchSession?: (idOrIndex: string) => Promise<string>;
}
/** Throttle for progress-message edits (ms). */
const PROGRESS_EDIT_MIN_INTERVAL = 1500;
export class ImController {
	queue = new SerialMessageQueue();
	dedup = new MessageDeduplicator();
	batch: BatchCollector;
	runtime: PiRuntimeHooks | undefined;
	private locale: Locale;
	constructor(
		private channel: ChannelLike,
		private agent: PiAgentBridge,
		private opts: {
			allowlist: string[];
			channelName: string;
			locale?: Locale;
		},
	) {
		this.locale = opts.locale ?? "zh";
		this.batch = new BatchCollector(this.locale);
	}
	setLocale(locale: Locale): void {
		this.locale = locale;
		this.batch.setLocale(locale);
	}
	private get s() {
		return getStrings(this.locale);
	}
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
		const s = this.s;
		const pos = this.queue.size + 1;
		await this.queue.enqueue(m.chatId, async () => {
			const progressId = await this.channel.sendText(
				m.chatId,
				pos > 1 ? s.progressQueued(pos) : s.progressWorking,
			);
			let lastEdit = 0;
			let lastActivity = "";
			let lastText = "";
			const pushProgress = async (force: boolean) => {
				const now = Date.now();
				if (!force && now - lastEdit < PROGRESS_EDIT_MIN_INTERVAL) return;
				lastEdit = now;
				const parts = ["⏳"];
				if (lastActivity) parts.push(lastActivity);
				if (lastText) parts.push(lastText.slice(-500));
				const body = parts.join("\n");
				await this.channel
					.editText(m.chatId, progressId, body)
					.catch(() => undefined);
			};
			const out = await this.agent.run(m.text, {
				onText: (t) => {
					lastText = t;
					void pushProgress(false);
				},
				onActivity: (a) => {
					lastActivity = a;
					void pushProgress(false);
				},
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
				await this.handleInbound({
					...m,
					text: all || s.batchEmpty,
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
				const lines = [
					`${s.statusVersion}/${this.opts.channelName}`,
					s.statusConn,
					s.statusQueue(this.queue.size),
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
					await this.channel.sendText(
						m.chatId,
						`${cur ? s.thinkingCurrent(cur) : s.thinkingUnknown}\n${s.thinkingLevels}\n${s.thinkingExample}`,
					);
					return;
				}
				const ok = this.runtime?.setThinking?.(args.toLowerCase());
				await this.channel.sendText(
					m.chatId,
					ok ? s.thinkingSwitched(args.toLowerCase()) : s.thinkingBad(args),
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
			default:
				await this.channel.sendText(m.chatId, s.cmdFallback(name, args));
				return;
		}
	}
}
