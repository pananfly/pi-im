// src/extension.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parseTuiArgs } from "./commands.js";
import {
	type ChannelKind,
	discoverSessionWorkspaces,
	type FeishuFileConfig,
	listWorkspaceSessionsSync,
	mergeWorkspaces,
	piImDir,
	readPiImConfig,
	recordWorkspace,
	resolveFeishuCredentials,
	resolveTelegramCredentials,
	saveJsonAtomic,
	shouldAutoStart,
	type TelegramFileConfig,
} from "./config.js";
import { ImController } from "./controller.js";
import { SdkFeishuGateway } from "./feishu/gateway.js";
import { getStrings, type Locale, resolveLocale } from "./i18n.js";
import { registerPiWebLiveness } from "./liveness.js";
import { PiAgentBridge } from "./pi-bridge.js";
import { TelegramGateway } from "./telegram/gateway.js";

async function readJson<T>(p: string, fb: T): Promise<T> {
	try {
		return JSON.parse(await readFile(p, "utf8")) as T;
	} catch {
		return fb;
	}
}
const SKEY = "__piImShared__";
interface ChannelState {
	gateway: { stop(): Promise<void> } | null;
	controller: ImController | null;
}
interface SharedState {
	feishu: ChannelState;
	tg: ChannelState;
	bridge: PiAgentBridge | null;
	autostartDone: boolean;
	release: (() => void) | null;
	latestCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null;
	cmdCtx: ExtensionCommandContext | null;
	locale: Locale;
	workspaces: string[];
}
function getShared(): SharedState {
	const host = globalThis as Record<string, unknown>;
	if (!host[SKEY]) {
		host[SKEY] = {
			feishu: { gateway: null, controller: null },
			tg: { gateway: null, controller: null },
			bridge: null,
			autostartDone: false,
			release: null,
			latestCtx: null,
			cmdCtx: null,
			locale: "zh" as Locale,
			workspaces: [],
		};
	}
	const s = host[SKEY] as SharedState;
	if (!s.locale) s.locale = "zh";
	if (!s.workspaces) s.workspaces = [];
	return s;
}
/** Refresh locale + workspace history from disk (called on commands/autostart). */
async function refreshSharedMeta(): Promise<void> {
	const shared = getShared();
	const dir = piImDir();
	const cfg = await readPiImConfig(dir);
	shared.locale = resolveLocale(process.env, cfg);
	const cur = shared.latestCtx?.cwd ?? process.cwd();
	const discovered = await discoverSessionWorkspaces().catch(() => []);
	const merged = mergeWorkspaces(cfg.workspaces, cur, discovered).slice(0, 20);
	shared.workspaces = merged;
	// persist back so history accumulates even without /workspace switches
	try {
		if (JSON.stringify(cfg.workspaces ?? []) !== JSON.stringify(merged)) {
			await saveJsonAtomic(join(dir, "config.json"), {
				...cfg,
				workspaces: merged,
			});
		}
	} catch {}
}
function notify(
	ctx: ExtensionCommandContext,
	msg: string,
	kind: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui.notify(msg, kind);
	} catch {
		// print-mode / RPC 下无 UI:回落到控制台,保证总有可见输出。
		console.log(`[pi-im] ${msg}`);
	}
}
function mask(s: string): string {
	if (s.length <= 8) return "****";
	return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
async function validateTelegramToken(botToken: string): Promise<string> {
	const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
		signal: AbortSignal.timeout(15000),
	});
	const data = (await res.json()) as {
		ok?: boolean;
		result?: { username?: string };
		description?: string;
	};
	if (!data.ok) throw new Error(data.description ?? "Bot Token 无效");
	return data.result?.username ?? "unknown";
}
function getBridge(pi: ExtensionAPI): PiAgentBridge {
	const shared = getShared();
	if (!shared.bridge) {
		shared.bridge = new PiAgentBridge(
			async (prompt) => {
				pi.sendUserMessage(prompt);
			},
			async (text) => {
				try {
					pi.sendUserMessage(text, { deliverAs: "steer" });
					return true;
				} catch {
					return false;
				}
			},
		);
	}
	return shared.bridge;
}
function attachRuntime(pi: ExtensionAPI, c: ImController): void {
	const shared = getShared();
	const t = () => getStrings(shared.locale);
	c.runtime = {
		newSession: async () => {
			const cmd = shared.cmdCtx;
			if (!cmd) return false;
			try {
				const r = await cmd.newSession();
				return !r.cancelled;
			} catch {
				return false;
			}
		},
		compact: () => {
			try {
				shared.latestCtx?.compact();
			} catch {}
		},
		abort: () => {
			try {
				shared.latestCtx?.abort();
			} catch {}
		},
		cwd: () => shared.latestCtx?.cwd ?? process.cwd(),
		sessionFile: () => {
			try {
				return shared.latestCtx?.sessionManager.getSessionFile() ?? undefined;
			} catch {
				return undefined;
			}
		},
		model: () => {
			const m = shared.latestCtx?.model as
				| { id?: string; name?: string; provider?: string }
				| undefined;
			if (!m?.id) return undefined;
			return {
				id: m.id,
				name: m.name,
				provider: typeof m.provider === "string" ? m.provider : undefined,
			};
		},
		thinking: () => {
			const t = shared.latestCtx?.thinkingLevel;
			return typeof t === "string" ? t : undefined;
		},
		contextPercent: () => {
			try {
				const u = shared.latestCtx?.getContextUsage() as
					| { percent?: number }
					| undefined;
				return typeof u?.percent === "number" ? u.percent : undefined;
			} catch {
				return undefined;
			}
		},
		isRunning: () => {
			const idle = shared.latestCtx?.isIdle();
			return typeof idle === "boolean" ? !idle : false;
		},
		listModels: () => {
			const ctx = shared.latestCtx;
			if (!ctx) return [];
			const scoped = (ctx.scopedModels ?? []) as unknown as Array<{
				id?: string;
				name?: string;
				provider?: string;
			}>;
			if (scoped.length > 0) {
				return scoped
					.map((s) => ({
						id: String(s.id ?? s.name ?? ""),
						name: s.name,
						provider: s.provider,
					}))
					.filter((x) => x.id);
			}
			try {
				const all = ctx.modelRegistry.getAvailable() as Array<{
					id?: string;
					name?: string;
					provider?: unknown;
				}>;
				return all
					.map((m) => ({
						id: String(m.id ?? m.name ?? ""),
						name: m.name,
						provider: typeof m.provider === "string" ? m.provider : undefined,
					}))
					.filter((x) => x.id);
			} catch {
				return [];
			}
		},
		switchModel: async (query: string) => {
			const ctx = shared.latestCtx;
			if (!ctx) throw new Error(t().modelNoSession);
			const q = query.trim();
			let target: { id?: string; name?: string } | undefined;
			if (/^\d+$/.test(q)) {
				const list = c.runtime?.listModels?.() ?? [];
				target = list[Number(q) - 1];
				if (!target) throw new Error(t().modelIndexOut(q));
			} else {
				const scoped = (ctx.scopedModels ?? []) as unknown as Array<{
					id?: string;
					name?: string;
				}>;
				target =
					scoped.find((s) => s.id === q || s.name === q) ??
					(() => {
						try {
							return ctx.modelRegistry
								.getAvailable()
								.find(
									(m) =>
										(m as { id?: string }).id === q ||
										(m as { name?: string }).name === q,
								) as unknown as { id?: string; name?: string } | undefined;
						} catch {
							return undefined;
						}
					})();
				if (!target) {
					// 模糊匹配 id/name 包含
					const pool = (
						scoped.length > 0
							? scoped
							: (() => {
									try {
										return ctx.modelRegistry.getAvailable() as unknown as Array<{
											id?: string;
											name?: string;
										}>;
									} catch {
										return [];
									}
								})()
					) as Array<{ id?: string; name?: string }>;
					const fuzzy = pool.filter(
						(m) =>
							(m.id ?? "").toLowerCase().includes(q.toLowerCase()) ||
							(m.name ?? "").toLowerCase().includes(q.toLowerCase()),
					);
					if (fuzzy.length === 1 && fuzzy[0]) target = fuzzy[0];
					else if (fuzzy.length === 0) throw new Error(t().modelNotFound(q));
					else throw new Error(t().modelAmbiguous(q));
				}
			}
			const full = (() => {
				try {
					return ctx.modelRegistry
						.getAvailable()
						.find(
							(m) =>
								(m as { id?: string }).id === (target as { id?: string }).id,
						);
				} catch {
					return undefined;
				}
			})();
			if (!full) throw new Error(t().modelNotInCatalog);
			const ok = await pi.setModel(full);
			if (!ok) throw new Error(t().modelNoKey);
			const mm = full as { id?: string; name?: string; provider?: unknown };
			return {
				id: String(mm.id ?? q),
				name: mm.name,
				provider: typeof mm.provider === "string" ? mm.provider : undefined,
			};
		},
		setThinking: (level: string) => {
			const lv = level.toLowerCase() as unknown as Parameters<
				import("@earendil-works/pi-coding-agent").ExtensionAPI["setThinkingLevel"]
			>[0];
			try {
				pi.setThinkingLevel(lv);
				return true;
			} catch {
				return false;
			}
		},
		readHistory: (n: number) => {
			try {
				const entries = shared.latestCtx?.sessionManager.getEntries() as
					| Array<{
							role?: string;
							content?: Array<{ type?: string; text?: string }> | string;
					  }>
					| undefined;
				if (!entries) return [];
				const out: string[] = [];
				for (const e of entries) {
					if (e.role !== "user" && e.role !== "assistant") continue;
					let text = "";
					if (typeof e.content === "string") text = e.content;
					else if (Array.isArray(e.content)) {
						text = e.content
							.filter((p) => p.type === "text" && p.text)
							.map((p) => p.text as string)
							.join("\n");
					}
					if (text.trim()) out.push(text);
				}
				return out.slice(-n);
			} catch {
				return [];
			}
		},
		listWorkspaces: () => {
			const cur = shared.latestCtx?.cwd ?? process.cwd();
			return mergeWorkspaces(shared.workspaces, cur);
		},
		listSessions: () => {
			const cur = shared.latestCtx?.cwd ?? process.cwd();
			try {
				return listWorkspaceSessionsSync(cur);
			} catch {
				return [];
			}
		},
		switchWorkspace: async (arg: string) => {
			const { stat } = await import("node:fs/promises");
			const { resolve } = await import("node:path");
			let dir = arg.trim();
			if (/^\d+$/.test(dir)) {
				const list = c.runtime?.listWorkspaces?.() ?? [];
				const hit = list[Number(dir) - 1];
				if (!hit) throw new Error(t().workspaceIndexOut(dir));
				dir = hit;
			}
			const resolved = resolve(dir);
			const st = await stat(resolved).catch(() => null);
			if (!st?.isDirectory()) throw new Error(t().workspaceNotDir(resolved));
			process.chdir(resolved);
			// 记忆历史:写回 config.json + 更新内存缓存,下次 /wsl 可见。
			try {
				shared.workspaces = await recordWorkspace(piImDir(), resolved);
			} catch {}
			return t().workspaceSwitched(resolved);
		},
		switchSession: async (arg: string) => {
			const cmd = shared.cmdCtx;
			if (!cmd) throw new Error(t().sessionNoCtx);
			const list = c.runtime?.listSessions?.() ?? [];
			const q = arg.trim();
			let target: string | undefined;
			if (/^\d+$/.test(q)) {
				const hit = list[Number(q) - 1];
				if (!hit) throw new Error(t().sessionIndexOut(q));
				target = hit.file ?? hit.id;
			} else {
				// full id / id prefix / absolute .jsonl path
				const hit =
					list.find((s) => s.id === q) ??
					list.find((s) => s.id.startsWith(q)) ??
					list.find((s) => s.file === q);
				target = hit?.file ?? hit?.id ?? (q.endsWith(".jsonl") ? q : undefined);
			}
			if (!target) throw new Error(t().sessionIndexOut(q));
			// Pi switchSession expects the session FILE path, not the id.
			await cmd.switchSession(target);
			return t().sessionBound(target);
		},
	};
}
async function startTelegram(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const shared = getShared();
	if (shared.tg.gateway) {
		notify(ctx, "TG Bot 已在运行中。先 /tg stop 再启动。", "warning");
		return;
	}
	const dir = piImDir();
	const file = await readJson<TelegramFileConfig>(
		join(dir, "telegram.json"),
		{},
	);
	const cred = resolveTelegramCredentials(process.env, file);
	if (!cred) {
		notify(
			ctx,
			"TG 未配置 Bot Token。请先 /tg setup <BotToken>(向 @BotFather 申请)。",
			"warning",
		);
		return;
	}
	notify(ctx, "正在连接 Telegram…", "info");
	const username = await validateTelegramToken(cred.botToken);
	const gw = new TelegramGateway({ botToken: cred.botToken });
	const c = new ImController(gw, getBridge(pi), {
		allowlist: file.allowlist ?? [],
		channelName: "telegram",
		locale: shared.locale,
	});
	attachRuntime(pi, c);
	gw.onMessage((m) => void c.handleInbound(m));
	await gw.start();
	shared.tg.gateway = gw;
	shared.tg.controller = c;
	shared.cmdCtx = ctx;
	notify(ctx, `✅ TG Bot 已就绪(@${username})。私聊直回,群聊@回。`, "info");
}
async function stopTelegram(ctx: ExtensionCommandContext): Promise<void> {
	const shared = getShared();
	if (!shared.tg.gateway) {
		notify(ctx, "TG Bot 未运行。", "warning");
		return;
	}
	await shared.tg.gateway.stop().catch(() => undefined);
	shared.tg.gateway = null;
	shared.tg.controller = null;
	notify(ctx, "✅ TG 长连接已停止。", "info");
}
async function startFeishu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const shared = getShared();
	if (shared.feishu.gateway) {
		notify(ctx, "飞书 Bot 已在运行中。先 /feishu stop 再启动。", "warning");
		return;
	}
	const dir = piImDir();
	const file = await readJson<FeishuFileConfig>(join(dir, "feishu.json"), {});
	const cred = resolveFeishuCredentials(process.env, file);
	if (!cred) {
		notify(
			ctx,
			"飞书未配置凭据。请先 /feishu setup <AppID> <AppSecret>。",
			"warning",
		);
		return;
	}
	notify(ctx, "正在连接飞书…(WebSocket 长连接)", "info");
	const gw = new SdkFeishuGateway({
		appId: cred.appId,
		appSecret: cred.appSecret,
		domain: cred.domain,
	});
	const c = new ImController(gw, getBridge(pi), {
		allowlist: file.allowlist ?? [],
		channelName: "feishu",
		locale: shared.locale,
	});
	attachRuntime(pi, c);
	gw.onMessage((m) => void c.handleInbound(m));
	await gw.start();
	shared.feishu.gateway = gw;
	shared.feishu.controller = c;
	shared.cmdCtx = ctx;
	notify(ctx, "✅ 飞书网关已启动(WebSocket)。私聊直回,群聊@回。", "info");
}
async function stopFeishu(ctx: ExtensionCommandContext): Promise<void> {
	const shared = getShared();
	if (!shared.feishu.gateway) {
		notify(ctx, "飞书 Bot 未运行。", "warning");
		return;
	}
	await shared.feishu.gateway.stop().catch(() => undefined);
	shared.feishu.gateway = null;
	shared.feishu.controller = null;
	notify(ctx, "✅ 飞书长连接已停止。", "info");
}
async function handleTg(
	pi: ExtensionAPI,
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { cmd, rest } = parseTuiArgs(rawArgs || "help");
	const dir = piImDir();
	getShared().cmdCtx = ctx;
	await refreshSharedMeta().catch(() => undefined);
	try {
		switch (cmd) {
			case "setup": {
				let token = rest.trim();
				if (!token && ctx.hasUI) {
					const input = await ctx.ui.input(
						"TG Bot Token",
						"向 @BotFather 申请后粘贴",
					);
					token = (input ?? "").trim();
				}
				if (!token) {
					notify(ctx, "用法: /tg setup <BotToken>", "warning");
					return;
				}
				const username = await validateTelegramToken(token);
				const prev = await readJson<TelegramFileConfig>(
					join(dir, "telegram.json"),
					{},
				);
				await saveJsonAtomic(join(dir, "telegram.json"), {
					...prev,
					botToken: token,
					autoStart: prev.autoStart ?? true,
				});
				notify(
					ctx,
					`✅ TG Token 验证成功(@${username})并已保存。正在启动…`,
					"info",
				);
				await startTelegram(pi, ctx);
				return;
			}
			case "start":
				await startTelegram(pi, ctx);
				return;
			case "stop":
				await stopTelegram(ctx);
				return;
			case "status": {
				const file = await readJson<TelegramFileConfig>(
					join(dir, "telegram.json"),
					{},
				);
				const running = Boolean(getShared().tg.gateway);
				const q = getShared().tg.controller?.queue.size ?? 0;
				notify(
					ctx,
					`TG 状态\n  配置: ${file.botToken ? `已配置(${mask(file.botToken)})` : "未配置"}\n  连接: ${running ? "运行中" : "未运行"}\n  队列: ${q}\n  自启动: ${shouldAutoStart("telegram", process.env, file) ? "开" : "关"}`,
					"info",
				);
				return;
			}
			case "config":
				notify(
					ctx,
					`配置目录: ${dir}\n  telegram.json (0600)\n  环境变量 TELEGRAM_BOT_TOKEN / PI_IM_AUTO_START 可覆盖文件。`,
					"info",
				);
				return;
			case "logout": {
				await stopTelegram(ctx);
				const prev = await readJson<TelegramFileConfig>(
					join(dir, "telegram.json"),
					{},
				);
				await saveJsonAtomic(join(dir, "telegram.json"), {
					...prev,
					botToken: undefined,
				});
				notify(ctx, "TG 连接已停止,本地 Token 已清除。", "info");
				return;
			}
			default:
				notify(
					ctx,
					"tg 命令: setup <Token> | start | stop | status | config | logout | help",
					"info",
				);
				return;
		}
	} catch (e) {
		notify(
			ctx,
			`TG 操作失败: ${e instanceof Error ? e.message : String(e)}`,
			"error",
		);
	}
}
async function handleFeishu(
	pi: ExtensionAPI,
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { cmd, rest } = parseTuiArgs(rawArgs || "help");
	const dir = piImDir();
	getShared().cmdCtx = ctx;
	await refreshSharedMeta().catch(() => undefined);
	try {
		switch (cmd) {
			case "setup": {
				const parts = rest.trim().split(/\s+/).filter(Boolean);
				let appId = parts[0] ?? "";
				let appSecret = parts[1] ?? "";
				if ((!appId || !appSecret) && ctx.hasUI) {
					appId =
						appId ||
						((await ctx.ui.input("飞书 App ID", "cli_xxx")) ?? "").trim();
					appSecret =
						appSecret ||
						(
							(await ctx.ui.input("飞书 App Secret", "粘贴 Secret")) ?? ""
						).trim();
				}
				if (!appId || !appSecret) {
					notify(ctx, "用法: /feishu setup <AppID> <AppSecret>", "warning");
					return;
				}
				const prev = await readJson<FeishuFileConfig>(
					join(dir, "feishu.json"),
					{},
				);
				await saveJsonAtomic(join(dir, "feishu.json"), {
					...prev,
					appId,
					appSecret,
					domain: prev.domain ?? "feishu",
					autoStart: prev.autoStart ?? true,
				});
				notify(ctx, `✅ 飞书凭据已保存: ${appId}。正在启动…`, "info");
				await startFeishu(pi, ctx);
				return;
			}
			case "start":
				await startFeishu(pi, ctx);
				return;
			case "stop":
				await stopFeishu(ctx);
				return;
			case "status": {
				const file = await readJson<FeishuFileConfig>(
					join(dir, "feishu.json"),
					{},
				);
				const running = Boolean(getShared().feishu.gateway);
				notify(
					ctx,
					`飞书状态\n  配置: ${file.appId ? `已配置(${file.appId})` : "未配置"}\n  连接: ${running ? "运行中" : "未运行"}\n  自启动: ${shouldAutoStart("feishu" as ChannelKind, process.env, file) ? "开" : "关"}`,
					"info",
				);
				return;
			}
			case "config":
				notify(
					ctx,
					`配置目录: ${dir}\n  feishu.json (0600)\n  环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / PI_IM_AUTO_START 可覆盖文件。`,
					"info",
				);
				return;
			case "logout": {
				await stopFeishu(ctx);
				const prev = await readJson<FeishuFileConfig>(
					join(dir, "feishu.json"),
					{},
				);
				await saveJsonAtomic(join(dir, "feishu.json"), {
					...prev,
					appId: undefined,
					appSecret: undefined,
				});
				notify(ctx, "飞书连接已停止,本地凭据已清除。", "info");
				return;
			}
			default:
				notify(
					ctx,
					"feishu 命令: setup <ID> <Secret> | start | stop | status | config | logout | help",
					"info",
				);
				return;
		}
	} catch (e) {
		notify(
			ctx,
			`飞书操作失败: ${e instanceof Error ? e.message : String(e)}`,
			"error",
		);
	}
}
/** Track latest ctx + keep current cwd first in workspace list (in-memory). */
function trackContext(
	context: import("@earendil-works/pi-coding-agent").ExtensionContext,
): void {
	const shared = getShared();
	shared.latestCtx = context;
	try {
		const cur = context.cwd ?? process.cwd();
		shared.workspaces = mergeWorkspaces(shared.workspaces, cur).slice(0, 20);
	} catch {}
}
export default function piImExtension(pi: ExtensionAPI): void {
	getShared();
	pi.registerCommand("feishu", {
		description: "pi-im feishu setup|start|stop|status|config|logout|help",
		handler: async (args, ctx) => {
			await handleFeishu(pi, args ?? "", ctx);
		},
	});
	pi.registerCommand("tg", {
		description: "pi-im tg setup|start|stop|status|config|logout|help",
		handler: async (args, ctx) => {
			await handleTg(pi, args ?? "", ctx);
		},
	});
	pi.on("session_start", (event, context) => {
		void event;
		trackContext(context);
		void (async () => {
			const shared = getShared();
			await refreshSharedMeta().catch(() => undefined);
			if (shared.autostartDone) return;
			shared.autostartDone = true;
			const dir = piImDir();
			const feishuFile = await readJson<FeishuFileConfig>(
				join(dir, "feishu.json"),
				{},
			);
			const tgFile = await readJson<TelegramFileConfig>(
				join(dir, "telegram.json"),
				{},
			);
			getBridge(pi);
			const fCred = resolveFeishuCredentials(process.env, feishuFile);
			if (fCred && shouldAutoStart("feishu", process.env, feishuFile)) {
				await startFeishuSilent(pi, fCred, feishuFile).catch(() => undefined);
			}
			const tCred = resolveTelegramCredentials(process.env, tgFile);
			if (tCred && shouldAutoStart("telegram", process.env, tgFile)) {
				await startTelegramSilent(pi, tCred, tgFile).catch(() => undefined);
			}
			const sid = (context as { sessionId?: string }).sessionId ?? "holder";
			shared.release?.();
			shared.release = registerPiWebLiveness(
				sid,
				() => Boolean(shared.feishu.gateway) || Boolean(shared.tg.gateway),
			);
		})().catch((e) => {
			notify(
				context as ExtensionCommandContext,
				`pi-im自启动失败:${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		});
	});
	pi.on("message_end", (e, c) => {
		trackContext(c);
		getShared().bridge?.captureMessage(e.message as never);
	});
	pi.on("message_update", (e, c) => {
		trackContext(c);
		getShared().bridge?.captureStreamingMessage(e.message as never);
	});
	pi.on("tool_execution_start", (e, c) => {
		trackContext(c);
		getShared().bridge?.captureToolStart(e.toolName as string);
	});
	pi.on("tool_execution_end", (_e, c) => {
		trackContext(c);
		getShared().bridge?.captureToolEnd();
	});
	pi.on("agent_settled", (_e, c) => {
		trackContext(c);
		getShared().bridge?.settle();
	});
	pi.on("session_shutdown", () => {});
}
async function startTelegramSilent(
	pi: ExtensionAPI,
	cred: { botToken: string },
	file: TelegramFileConfig,
): Promise<void> {
	const shared = getShared();
	if (shared.tg.gateway) return;
	const gw = new TelegramGateway({ botToken: cred.botToken });
	const c = new ImController(gw, getBridge(pi), {
		allowlist: file.allowlist ?? [],
		channelName: "telegram",
		locale: shared.locale,
	});
	attachRuntime(pi, c);
	gw.onMessage((m) => void c.handleInbound(m));
	await gw.start();
	shared.tg.gateway = gw;
	shared.tg.controller = c;
}
async function startFeishuSilent(
	pi: ExtensionAPI,
	cred: { appId: string; appSecret: string; domain: "feishu" | "lark" },
	file: FeishuFileConfig,
): Promise<void> {
	const shared = getShared();
	if (shared.feishu.gateway) return;
	const gw = new SdkFeishuGateway({
		appId: cred.appId,
		appSecret: cred.appSecret,
		domain: cred.domain,
	});
	const c = new ImController(gw, getBridge(pi), {
		allowlist: file.allowlist ?? [],
		channelName: "feishu",
		locale: shared.locale,
	});
	attachRuntime(pi, c);
	gw.onMessage((m) => void c.handleInbound(m));
	await gw.start();
	shared.feishu.gateway = gw;
	shared.feishu.controller = c;
}
