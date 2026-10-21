// src/extension.ts

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parseTuiArgs } from "./commands.js";
import {
	type ChannelKind,
	type FeishuFileConfig,
	feishuSetupConfig,
	type HolderRecord,
	listPiWebWorkspacesSync,
	listWorkspaceSessionsSync,
	mergeWorkspaces,
	piImDir,
	readPiImConfig,
	recordFallbackModel,
	resolveFeishuCredentials,
	resolveTelegramCredentials,
	saveJsonAtomic,
	shouldAutoStart,
	type TelegramFileConfig,
	updatePiImConfig,
} from "./config.js";
import { ImController } from "./controller.js";
import { imDebug } from "./debug.js";
import { SdkFeishuGateway } from "./feishu/gateway.js";
import { syncSlashCommands } from "./feishu/slash-commands.js";
import {
	adoptControlSession,
	ctxSessionFile,
	holderCwdNow,
	holderIdentityOf,
	holderSessionScope,
	isHolderContext,
	landedOnNewSession,
	matchesSeed,
	REBIND_POLL_MS,
	rebindTimeoutMs,
	safeSessionId,
	sameAsHolder,
} from "./holder.js";
import { resolveLocale } from "./i18n.js";
import { readJson } from "./json.js";
import {
	OWNER_HEARTBEAT_MS,
	openOwnerLock,
	type ProcessMode,
} from "./owner.js";
import { PiAgentBridge } from "./pi-bridge.js";
import {
	getCurrentPi,
	isStaleApiError,
	sendViaCurrentPi,
	sendViaCurrentPiWhenReady,
	setCurrentPi,
} from "./pi-ref.js";
import { attachRuntime, dispatchInbound } from "./runtime.js";
import { getShared, PENDING_SWITCH_TTL_MS } from "./shared.js";
import { TelegramGateway } from "./telegram/gateway.js";
import { hasActiveImTurn } from "./ui-bridge.js";

// Re-exported so tests and callers keep importing from the extension entry.
export { attachRuntime, dispatchInbound };

/**
 * True only while pi-im itself is re-applying the remembered model. pi emits
 * model_select from setModel(), so without this the restore would look like a
 * fresh TUI pick and stamp itself into config as one.
 */
let applyingRestore = false;
/** Refresh locale + workspace history from disk (called on commands/autostart). */
async function refreshSharedMeta(): Promise<void> {
	const shared = getShared();
	const dir = piImDir();
	const cfg = await readPiImConfig(dir);
	shared.locale = resolveLocale(process.env, cfg);
	// The holder itself is seeded synchronously in getShared(); this refresh only
	// owns locale and the workspace list.
	// Explicitly selected workspaces are the only thing worth persisting now:
	// everything else is discovered live from ~/.pi on every /wsl, so copying it
	// into config.json just grew a stale duplicate list. Prune entries whose
	// directory vanished (old test runs left plenty of those behind).
	const stored = (cfg.workspaces ?? []).filter((w) => existsSyncSafe(w));
	shared.workspaces = mergeWorkspaces(
		stored,
		holderCwdNow(),
		listPiWebWorkspacesSync(),
	).slice(0, 20);
	try {
		if (JSON.stringify(stored) !== JSON.stringify(cfg.workspaces ?? [])) {
			// Re-read inside the queue: a holder or model write may have landed
			// between the read above and this prune, and writing back the stale
			// snapshot would resurrect fields that write had cleared.
			await updatePiImConfig(dir, (cur) => ({ ...cur, workspaces: stored }));
		}
	} catch {}
}
/** existsSync that never throws on a non-string config entry. */
function existsSyncSafe(path: string): boolean {
	if (typeof path !== "string" || !path) return false;
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
/** 内部命令名：认领会话控制上下文。不出现在帮助里，只由 pi-im 自己触发。 */
const ADOPT_COMMAND = "_piim-adopt";
/**
 * 认领 ExtensionCommandContext。
 *
 * createContext()（session_start 给的）刻意不含 newSession / switchSession /
 * fork，只有命令上下文才有，而命令上下文只在命令 handler 里诞生。所以 IM 的
 * /new /workspace /session 以前必须靠用户记得敲一次 /tg status —— 而且每次会话
 * 替换后旧 ctx 就失效，得重新敲。
 *
 * 这里借 pi 自己的派发路径取到真的那个：prompt() 见到 "/name" 开头的文本会先
 * 走 _tryExecuteExtensionCommand -> createCommandContext()。命令被处理后
 * prompt() 直接返回，不会追加用户消息、也不会触发模型回合，所以对 TUI 是静默的。
 *
 * 必须显式传 expandPromptTemplates: true —— sendUserMessage 默认把它设为 false
 * （agent-session.js:1871），而 prompt() 的派发分支的前提正是这个开关。漏掉它，
 * 这条文本会被当成一条真实的用户消息发给模型。
 */
function claimCommandContext(api: ExtensionAPI): void {
	try {
		// The factory's own api, not getCurrentPi(): `session_start` pins this
		// session right before calling here, and during a switch the pinned slot
		// still holds the outgoing holder until that pin lands.
		api.sendUserMessage(`/${ADOPT_COMMAND}`, {
			expandPromptTemplates: true,
		});
	} catch {
		// pi mid-swap：下一个 session_start 会补上。IM 侧会看到明确的重试提示，
		// 而不是静默失败。
	}
}

/**
 * 无会话依赖的机器人自启动：extension 注册时即可拉起网关，
 * 不必等 session_start / holder 会话，用户不在电脑旁也能保持 IM 在线。
 * 幂等：autostartDone 保证 session_start 兜底时不会重复启动。
 */
function autostartBots(): Promise<void> {
	const shared = getShared();
	// Share the promise instead of returning early on `autostartDone`: the first
	// caller does the async refresh (which seeds the persisted holder), and
	// session_start must actually wait for that before deciding adoption.
	if (!shared.autostartPromise) {
		shared.autostartDone = true;
		shared.autostartPromise = runAutostart().catch(() => undefined);
	}
	return shared.autostartPromise;
}
/**
 * The host mode, if pi named one.
 *
 * `ctx.mode` is the only way to tell the TUI apart from pi-web from inside a pi
 * process: both are plain Node processes, and neither argv nor stdout reveals the
 * difference. A host that does not report one (an older pi, a test harness that
 * omits it) yields null, which leaves arbitration off entirely — the single
 * process assumption that was true before pi-web.
 */
function processModeOf(mode: unknown): ProcessMode | null {
	if (mode === "tui" || mode === "rpc" || mode === "json" || mode === "print") {
		return mode;
	}
	return null;
}
/** Whether this process may drive IM, treating an unnamed host as the only one. */
function isImOwner(): boolean {
	const shared = getShared();
	if (shared.ownerMode === null) return true;
	return shared.owner?.owned === true;
}
/** Strict variant: arbitration is on AND this process won it. */
function holdsImLock(): boolean {
	const shared = getShared();
	return shared.ownerMode !== null && shared.owner?.owned === true;
}
/**
 * Drop both gateways without a word to the user.
 *
 * Called when another process takes IM over: the loser must go quiet, or
 * Telegram keeps answering this process' long-poll with 409 while Feishu keeps a
 * second websocket open, and whichever process wins the race per update is
 * effectively random — that is the "IM answered in the wrong session" bug.
 */
async function stopAllChannels(): Promise<void> {
	const shared = getShared();
	const feishu = shared.feishu.gateway;
	const tg = shared.tg.gateway;
	shared.feishu = { gateway: null, controller: null };
	shared.tg = { gateway: null, controller: null };
	shared.release?.();
	shared.release = null;
	// Not "done", just "not ours for now": regaining the lock must be able to
	// start the bots again.
	shared.autostartDone = false;
	shared.autostartPromise = null;
	await Promise.allSettled([feishu?.stop(), tg?.stop()]);
}
/**
 * Heartbeat period of the IM lock.
 *
 * Only tests need to shorten it (`PIIM_OWNER_HEARTBEAT_MS`), the same way
 * `PIIM_REBIND_TIMEOUT_MS` shortens the command-context poll.
 */
function ownerHeartbeatMs(): number {
	const raw = Number(process.env.PIIM_OWNER_HEARTBEAT_MS ?? "");
	if (Number.isFinite(raw) && raw >= 5) return raw;
	return OWNER_HEARTBEAT_MS;
}
/**
 * Claim (or queue for) the cross-process IM lock, once per process.
 *
 * `session_start` is the first moment pi tells us which mode we run in, and it
 * is called synchronously so the claim is in place before `mayAdoptHolder` reads
 * it. The lock is never released early: it lives as long as the process, and
 * src/owner.ts unlinks the file on exit.
 */
function ensureOwnership(mode: ProcessMode | null): void {
	if (!mode) return;
	const shared = getShared();
	if (shared.ownerMode === null) shared.ownerMode = mode;
	if (shared.owner) return;
	const lock = openOwnerLock({
		file: join(piImDir(), "owner.json"),
		mode,
		heartbeatMs: ownerHeartbeatMs(),
		onLost: () => {
			imDebug("owner", "lost", mode);
			void stopAllChannels().catch(() => undefined);
		},
		onRegain: () => {
			imDebug("owner", "regained", mode);
			// The bot startup was marked done while we were only the fallback, so it
			// has to be re-armed before autostartBots() can do anything.
			const s = getShared();
			s.autostartDone = false;
			s.autostartPromise = null;
			void (async () => {
				await autostartBots();
				await restorePinnedHolder();
			})().catch(() => undefined);
		},
	});
	shared.owner = lock;
	imDebug("owner", lock.owned ? "claimed" : "queued", mode, process.pid);
}
/** The session file behind a persisted holder record, or null when it is gone. */
function resolveSeedSessionFile(seed: HolderRecord): string | null {
	if (seed.sessionFile && existsSyncSafe(seed.sessionFile))
		return seed.sessionFile;
	const id = seed.sessionId ?? "";
	const cwd = seed.cwd ?? "";
	if (!id || !cwd) return null;
	try {
		const hit = listWorkspaceSessionsSync(cwd).find(
			(s) => s.id === id || s.id.startsWith(id),
		);
		if (hit?.file && existsSyncSafe(hit.file)) return hit.file;
	} catch {}
	return null;
}
/** Poll for the command context pi hands to a dispatched command. */
async function waitForCommandContext(): Promise<ExtensionCommandContext | null> {
	const shared = getShared();
	const start = shared.sessionStart;
	if (start) claimCommandContext(start.api);
	const deadline = Date.now() + rebindTimeoutMs();
	for (;;) {
		if (shared.cmdCtx) return shared.cmdCtx;
		if (Date.now() >= deadline) return null;
		await new Promise((r) => setTimeout(r, REBIND_POLL_MS));
	}
}
/**
 * Pin the session this process is already on.
 *
 * The last resort of a takeover, for when there is nothing to resume: a process
 * that was only the fallback never adopted anything (see mayAdoptHolder), so it
 * sits on some session the host opened for it and IM would come back online with
 * nothing to drive — commands would answer "未就绪" until the user clicked a tab
 * in the browser. Adopting what we already have keeps IM usable right away.
 */
function adoptCurrentSession(): boolean {
	const shared = getShared();
	if (shared.holderAdopted) return true;
	const start = shared.sessionStart;
	if (!start) return false;
	const ident = holderIdentityOf(start.context);
	if (!ident.sessionFile && !ident.sessionId) return false;
	adoptControlSession(start.context, false, start.api, "auto");
	claimCommandContext(start.api);
	return true;
}
/**
 * Bring the pinned conversation back after this process takes IM over.
 *
 * A process that owns IM from the start is already oriented: warmup resumes the
 * record and its own `session_start` adopts it. A process that was only the
 * fallback never adopted anything (by rule, see mayAdoptHolder), so the only
 * target it knows is the record on disk — resume it the way /session does, or
 * keep whatever session it is on when there is no record to resume.
 *
 * Failure is logged and dropped, never retried: the user may have deleted that
 * session, and a background retry loop would keep yanking the browser off
 * whichever tab they just opened.
 */
async function restorePinnedHolder(): Promise<void> {
	const shared = getShared();
	if (!holdsImLock()) return;
	if (shared.restoring) return;
	const seed = shared.holderSeed;
	if (!seed) {
		// Nothing was ever pinned: take over with the session we have.
		if (adoptCurrentSession()) imDebug("owner", "restore-adopted", "no-pin");
		return;
	}
	if (
		shared.holderAdopted &&
		matchesSeed(seed, holderIdentityOf(shared.latestCtx))
	) {
		return;
	}
	const target = resolveSeedSessionFile(seed);
	if (!target) {
		// The pinned session is gone (deleted, or another machine): same fallback.
		imDebug("owner", "restore-skip", "no-session-file");
		adoptCurrentSession();
		return;
	}
	shared.restoring = true;
	try {
		const cmd = shared.cmdCtx ?? (await waitForCommandContext());
		if (!cmd) {
			imDebug("owner", "restore-skip", "no-command-context");
			return;
		}
		const before = shared.cmdCtx;
		let switched = false;
		shared.pendingSwitchAt = Date.now();
		try {
			const result = await cmd.switchSession(target, {
				withSession: async (next) => {
					adoptControlSession(next, true, undefined, "explicit");
					switched = true;
				},
			});
			if (result.cancelled) {
				shared.pendingSwitchAt = null;
				imDebug("owner", "restore-cancelled");
				return;
			}
		} catch (e) {
			shared.pendingSwitchAt = null;
			if (isStaleApiError(e)) shared.cmdCtx = null;
			imDebug(
				"owner",
				"restore-failed",
				e instanceof Error ? e.message : String(e),
			);
			return;
		}
		const landed = await landedOnNewSession(switched, before);
		imDebug("owner", "restored", target, landed ? "landed" : "unconfirmed");
	} finally {
		shared.restoring = false;
	}
}
async function runAutostart(): Promise<void> {
	try {
		await refreshSharedMeta();
	} catch {
		// 元信息刷新失败不阻断启动
	}
	// Two processes (TUI + pi-web) must not both poll: only the IM owner runs
	// bots. The mode is unknown this early (it arrives with the first
	// session_start), so a fallback may get here once with gateways already up —
	// session_start stops them right after the claim (see stopAllChannels call
	// there), and the start helpers refuse a gateway that lost the lock mid-start.
	if (!isImOwner()) return;
	const dir = piImDir();
	const feishuFile = await readJson<FeishuFileConfig>(
		join(dir, "feishu.json"),
		{},
	);
	const tgFile = await readJson<TelegramFileConfig>(
		join(dir, "telegram.json"),
		{},
	);
	getBridge();
	const fCred = resolveFeishuCredentials(process.env, feishuFile);
	if (
		fCred &&
		shouldAutoStart("feishu", process.env, feishuFile) &&
		isImOwner()
	) {
		await startFeishuSilent(fCred, feishuFile).catch(() => undefined);
	}
	const tCred = resolveTelegramCredentials(process.env, tgFile);
	if (
		tCred &&
		shouldAutoStart("telegram", process.env, tgFile) &&
		isImOwner()
	) {
		await startTelegramSilent(tCred, tgFile).catch(() => undefined);
	}
	// The lock can be lost while a gateway is coming up (a TUI started in
	// parallel); the loser must not keep serving.
	if (!isImOwner()) await stopAllChannels();
}
/**
 * Re-apply the model the user last picked over IM.
 *
 * ExtensionAPI.setModel has no `persist` option (agent-session.js:2743 calls
 * `setModel(model)` with none), so pi's `persist: true` branch that writes
 * settings.json is unreachable from an extension — every /new silently drops
 * back to the configured default. Remembering the pick ourselves is the only
 * lever available.
 *
 * Only fires for reason "new": resuming or restarting a session should keep the
 * model that session recorded, not be dragged to the IM preference.
 */
async function restorePreferredModel(
	event: { reason?: string },
	context: import("@earendil-works/pi-coding-agent").ExtensionContext,
): Promise<void> {
	if (event.reason !== "new") return;
	const cfg = await readPiImConfig(piImDir()).catch(() => null);
	const pref = cfg?.preferredModel;
	const prefName = pref?.name ?? pref?.id;

	// Never picked a model over IM: the session simply runs pi's default.
	// Say so — a silently-reverted model is what made this confusing to begin with.
	if (!pref?.id) {
		reportLiveModel(context, "新会话使用默认模型", "info");
		return;
	}

	const model = (() => {
		try {
			return context.modelRegistry
				.getAvailable()
				.find(
					(m) =>
						m.id === pref.id &&
						(pref.provider === undefined || m.provider === pref.provider),
				);
		} catch {
			// Registry not ready, or the model is gone from the catalogue.
			return undefined;
		}
	})();
	if (!model) {
		reportLiveModel(
			context,
			`未能恢复你上次选择的模型 ${prefName}(已下架或不在模型目录中)`,
			"warning",
		);
		return;
	}

	try {
		applyingRestore = true;
		await getCurrentPi().setModel(model);
	} catch {
		// pi mid-swap, or the provider lost its key: not worth failing session start.
		reportLiveModel(
			context,
			`未能恢复你上次选择的模型 ${prefName}(切换失败,可能缺少 API key)`,
			"warning",
		);
		return;
	} finally {
		applyingRestore = false;
	}

	const mm = model as { id?: string; name?: string };
	notify(
		context as ExtensionCommandContext,
		`pi-im:已恢复你上次选择的模型,当前模型: ${mm.name ?? mm.id}`,
		"info",
	);
}

/**
 * Tell the user which model the session is *actually* running right now.
 * Read from the live ctx rather than from config: after a failed restore the
 * two disagree, and only the live value is the truth.
 */
function reportLiveModel(
	context: import("@earendil-works/pi-coding-agent").ExtensionContext,
	prefix: string,
	kind: "info" | "warning",
): void {
	const m = (() => {
		try {
			return context.model as { id?: string; name?: string } | undefined;
		} catch {
			return undefined;
		}
	})();
	const name = m?.name ?? m?.id;
	notify(
		context as ExtensionCommandContext,
		name ? `pi-im:${prefix},当前模型: ${name}` : `pi-im:${prefix}`,
		kind,
	);
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
/**
 * The bridge is cached in process-global state and outlives the factory call
 * that created it, so it must resolve the API at send time (see ./pi-ref.ts)
 * rather than capture the `pi` argument.
 */
export function getBridge(): PiAgentBridge {
	const shared = getShared();
	if (!shared.bridge) {
		shared.bridge = new PiAgentBridge(
			async (prompt) => {
				await sendViaCurrentPiWhenReady(prompt);
			},
			async (text) => {
				try {
					sendViaCurrentPi(text, "steer");
					return true;
				} catch {
					return false;
				}
			},
		);
	}
	return shared.bridge;
}
async function startTelegram(
	ctx: ExtensionCommandContext,
	api: ExtensionAPI,
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
	const gw = new TelegramGateway({
		botToken: cred.botToken,
		parseMode: file.parseMode,
	});
	const c = new ImController(gw, getBridge(), {
		allowlist: file.allowlist ?? [],
		channelName: "telegram",
		locale: shared.locale,
		sessionScope: holderSessionScope,
		progressMode: file.progressMode ?? "text",
	});
	attachRuntime(c);
	gw.onMessage((m) => dispatchInbound(c, m, "telegram"));
	await gw.start();
	shared.tg.gateway = gw;
	shared.tg.controller = c;
	adoptControlSession(ctx, true, api, "explicit");
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
	ctx: ExtensionCommandContext,
	api: ExtensionAPI,
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
	const c = new ImController(gw, getBridge(), {
		allowlist: file.allowlist ?? [],
		channelName: "feishu",
		locale: shared.locale,
		sessionScope: holderSessionScope,
		progressMode: file.progressMode ?? "card",
	});
	attachRuntime(c);
	gw.onMessage((m) => dispatchInbound(c, m, "feishu"));
	await gw.start();
	shared.feishu.gateway = gw;
	shared.feishu.controller = c;
	adoptControlSession(ctx, true, api, "explicit");
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
/**
 * The allowlist subcommand, shared by the Telegram and Feishu handlers.
 * Editable only from the TUI: the IM path is what the allowlist locks out.
 */
async function allowlistCommand(
	filePath: string,
	sub: string,
	args: string,
): Promise<string> {
	const file = await readJson<TelegramFileConfig & FeishuFileConfig>(
		filePath,
		{},
	);
	const current = file.allowlist ?? [];
	if (sub === "allowlist") {
		return current.length === 0
			? "白名单为空,当前任何人都无法使用。/tg allow <id> 添加。"
			: `白名单 (${current.length}): ${current.join(", ")}`;
	}
	const id = args.trim();
	if (!id) return `用法: /tg ${sub} <user id>`;
	const next =
		sub === "allow"
			? current.includes(id)
				? current
				: [...current, id]
			: current.filter((x) => x !== id);
	await saveJsonAtomic(filePath, { ...file, allowlist: next });
	if (sub === "allow") return `已添加 ${id}。白名单: ${next.join(", ")}`;
	return next.length === current.length
		? `${id} 不在白名单中,无需移除。`
		: `已移除 ${id}。白名单: ${next.join(", ") || "(空)"}`;
}

/** One line for /status so a locked-down bot explains itself. */
function describeAllowlist(list: string[] | undefined): string {
	if (!list || list.length === 0) return "未配置(全员拒绝)";
	if (list.includes("*")) return "全部放行(!)";
	return `${list.length} 人: ${list.join(", ")}`;
}

async function handleTg(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	api: ExtensionAPI,
): Promise<void> {
	const { cmd, rest } = parseTuiArgs(rawArgs || "help");
	const dir = piImDir();
	adoptControlSession(ctx, true, api, "explicit");
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
				await startTelegram(ctx, api);
				return;
			}
			case "start":
				await startTelegram(ctx, api);
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
					`TG 状态\n  配置: ${file.botToken ? `已配置(${mask(file.botToken)})` : "未配置"}\n  连接: ${running ? "运行中" : "未运行"}\n  队列: ${q}\n  白名单: ${describeAllowlist(file.allowlist)}\n  自启动: ${shouldAutoStart("telegram", process.env, file) ? "开" : "关"}`,
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
			case "allow":
			case "deny":
			case "allowlist": {
				const path = join(dir, "telegram.json");
				notify(ctx, await allowlistCommand(path, cmd, rest), "info");
				// Take effect now rather than on the next restart: an owner who
				// unlocks the bot and is still refused has nothing to go on.
				const file = await readJson<TelegramFileConfig>(path, {});
				getShared().tg.controller?.setAllowlist(file.allowlist ?? []);
				return;
			}
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
					"tg 命令: setup <Token> | start | stop | status | allow <id> | deny <id> | allowlist | config | logout | help",
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
	rawArgs: string,
	ctx: ExtensionCommandContext,
	api: ExtensionAPI,
): Promise<void> {
	const { cmd, rest } = parseTuiArgs(rawArgs || "help");
	const dir = piImDir();
	adoptControlSession(ctx, true, api, "explicit");
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
				await saveJsonAtomic(
					join(dir, "feishu.json"),
					feishuSetupConfig(prev, appId, appSecret),
				);
				notify(ctx, `✅ 飞书凭据已保存: ${appId}。正在启动…`, "info");
				await startFeishu(ctx, api);
				return;
			}
			case "start":
				await startFeishu(ctx, api);
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
					`飞书状态\n  配置: ${file.appId ? `已配置(${file.appId})` : "未配置"}\n  连接: ${running ? "运行中" : "未运行"}\n  白名单: ${describeAllowlist(file.allowlist)}\n  自启动: ${shouldAutoStart("feishu" as ChannelKind, process.env, file) ? "开" : "关"}`,
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
			case "allow":
			case "deny":
			case "allowlist": {
				const path = join(dir, "feishu.json");
				notify(ctx, await allowlistCommand(path, cmd, rest), "info");
				const file = await readJson<FeishuFileConfig>(path, {});
				getShared().feishu.controller?.setAllowlist(file.allowlist ?? []);
				return;
			}
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
			case "card":
			case "text": {
				// Same write-then-apply order as the IM hook, so a failed write
				// leaves the live mode reporting what is actually in effect.
				const path = join(dir, "feishu.json");
				const prev = await readJson<FeishuFileConfig>(path, {});
				await saveJsonAtomic(path, { ...prev, progressMode: cmd });
				getShared().feishu.controller?.setProgressMode(cmd);
				notify(ctx, `进度展示已切换到 ${cmd},下一轮对话生效。`, "info");
				return;
			}
			default:
				notify(
					ctx,
					"feishu 命令: setup <ID> <Secret> | start | stop | status | config | logout | card|text | help",
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
/**
 * Refresh the live ctx when the event belongs to the holder; report whether it does.
 *
 * Passive events are filtered here as well as in the send path: a pi-web user
 * working in another workspace must not stream their tools/thinking into an
 * IM card, and their `agent_settled` must not end the IM turn early.
 */
function trackContext(
	context: import("@earendil-works/pi-coding-agent").ExtensionContext,
): boolean {
	if (!isHolderContext(context)) return false;
	const shared = getShared();
	shared.latestCtx = context;
	try {
		shared.workspaces = mergeWorkspaces(
			shared.workspaces,
			context.cwd ?? holderCwdNow(),
		).slice(0, 20);
	} catch {}
	return true;
}
/**
 * Decide whether this `session_start` may move the holder, and how it counts.
 *
 * Default is no. pi-web mints a new wrapper (and re-runs every extension
 * factory) whenever the browser opens another session — that is the "switch to
 * a workspace" path — so an unconditional adopt here is exactly what used to
 * change the IM task's cwd out from under it.
 *
 *  - and never at all when another process holds the lock (a TUI running next to
 *    pi-web): the fallback has to stay where it is until it takes IM over.
 *
 * Allowed, in order:
 *  - an IM switch is in flight (pi-web's wrapper is brand new and reports no
 *    previousSessionFile) → explicit;
 *  - the session is the current holder coming back (reload / reopened tab) →
 *    keep its source;
 *  - it replaces the holder (`previousSessionFile`, reported by pi's TUI
 *    runtime for /new and /resume) → explicit;
 *  - nothing is adopted yet → auto. This is deliberately provisional: IM must
 *    have something to drive even when the recorded holder is slow to return,
 *    and the last rule upgrades it once the real one starts;
 *  - a holder that was not deliberately chosen (auto / restored) is replaced
 *    by the session that matches the persisted record → restored. This is how
 *    a warmup resumes the previous conversation after a restart, and how a
 *    holder handed to the wrong tab recovers. Matching is on session file/id
 *    only: "same cwd" is not identity (pi-web restores same-directory tabs),
 *    and the swap waits until no IM turn is running. An explicit holder is
 *    never displaced this way — the user's pick stands until they pick again.
 */
function mayAdoptHolder(
	event: { reason?: string; previousSessionFile?: string },
	context: import("@earendil-works/pi-coding-agent").ExtensionContext,
): { source: "auto" | "explicit" | "restored" } | null {
	const shared = getShared();
	// A fallback process must never move the pin. When pi-web runs next to a TUI
	// its every browser click is a `session_start` in this process, and adopting
	// it there is what dragged IM's workspace and session into the clicked tab.
	if (!isImOwner()) return null;
	if (shared.pendingSwitchAt !== null) {
		if (Date.now() - shared.pendingSwitchAt <= PENDING_SWITCH_TTL_MS) {
			return { source: "explicit" };
		}
		shared.pendingSwitchAt = null;
	}
	const ident = holderIdentityOf(context);
	if (sameAsHolder(ident)) return { source: shared.holderSource };
	if (
		event.previousSessionFile &&
		shared.holderFile &&
		event.previousSessionFile === shared.holderFile
	) {
		return { source: "explicit" };
	}
	if (!shared.holderAdopted) return { source: "auto" };
	if (
		shared.holderSource !== "explicit" &&
		matchesSeed(shared.holderSeed, ident)
	) {
		// Not while a turn is running: swapping the holder mid-answer would leave
		// that turn's settle/tool events looking for a session it no longer owns,
		// and the user would sit on a "处理中" card forever. Staying put is never
		// worse than today's behaviour (no restore at all) — the rule still fires
		// on a later session_start, just once the channel is idle.
		if (hasActiveImTurn()) return null;
		// Only the exact recorded session can get here (matchesSeed no longer
		// settles for a shared cwd), and it may take the pin back even from a
		// "restored" holder: both are provisional, so this also repairs a holder
		// that an older build handed to the wrong tab. A deliberate pick
		// ("explicit") stays put until the user chooses again.
		return { source: "restored" };
	}
	return null;
}
export default function piImExtension(pi: ExtensionAPI): void {
	// pi re-runs this factory on every session replacement and hands us a fresh
	// API. Deliberately NOT publishing it here: the newest factory run belongs to
	// whichever session pi-web just opened, and pinning it would move IM with it.
	// The holder's session_start pins it via adoptControlSession() instead.
	getShared();
	// 不依赖任何会话：extension 加载即尝试拉起 Telegram / Feishu 网关。
	// 但只在没有别的 pi 进程持有 IM 时真的联网（见 runAutostart 的 ownership 门），
	// 否则 TUI + pi-web 会各开一条长轮询，谁抢到更新谁回答。
	void autostartBots().catch(() => undefined);
	pi.registerCommand("feishu", {
		description:
			"pi-im feishu setup|start|stop|status|config|logout|card|text|help",
		handler: async (args, ctx) => {
			await handleFeishu(args ?? "", ctx, pi);
		},
	});
	pi.registerCommand("tg", {
		description: "pi-im tg setup|start|stop|status|config|logout|help",
		handler: async (args, ctx) => {
			await handleTg(args ?? "", ctx, pi);
		},
	});
	// 静默的会话控制认领。claimCommandContext() 自己触发它，走的是 pi 的命令
	// 派发路径，所以 handler 拿到的是货真价实的 ExtensionCommandContext。
	// 不复用 /tg status：那个会打一整屏状态还写配置，启动时纯属噪音。
	pi.registerCommand(ADOPT_COMMAND, {
		description: "internal: claim session-control context for IM",
		handler: async (_args, ctx) => {
			// Only the holder may claim. pi-web runs this handler's factory in every
			// session it opens; without the guard the silent round trip itself would
			// undo the pin. When the host reports no identity at all there is
			// nothing to compare, so let it through rather than leaving IM unable
			// to control sessions.
			const shared = getShared();
			const pendingFresh =
				shared.pendingSwitchAt !== null &&
				Date.now() - shared.pendingSwitchAt <= PENDING_SWITCH_TTL_MS;
			const identified = Boolean(
				(ctxSessionFile(ctx) ?? "") || safeSessionId(ctx),
			);
			// The replacement wrapper reports its session_start first in practice
			// (which flips holderFile); the pending marker is the fallback for the
			// reverse order and for hosts that only dispatch the command.
			// An IM owner that has pinned nothing yet is the other exception: that is
			// exactly the state of a fallback process right after taking over, and it
			// needs the handle to resume the recorded session. It cannot move the pin
			// by itself — mayAdoptHolder already answered "no" for this session.
			if (
				identified &&
				!isHolderContext(ctx) &&
				!pendingFresh &&
				!(holdsImLock() && !shared.holderAdopted)
			) {
				return;
			}
			const source =
				pendingFresh && !isHolderContext(ctx)
					? "explicit"
					: shared.holderSource;
			adoptControlSession(ctx, true, pi, source);
		},
	});
	// A model picked in the TUI is a real choice too — it just must not outrank
	// a deliberate IM pick, which recordFallbackModel enforces by refusing to
	// write once an "im" pick exists.
	pi.on("model_select", async (event) => {
		if (applyingRestore) return;
		const m = event.model as { id?: string; name?: string; provider?: unknown };
		if (!m.id) return;
		await recordFallbackModel(piImDir(), {
			id: m.id,
			name: m.name,
			provider: typeof m.provider === "string" ? m.provider : undefined,
		}).catch(() => undefined);
	});
	pi.on("session_start", (event, context) => {
		// This event is the only place pi tells us which host we are ("tui" or
		// "rpc"), and the claim must be in place before mayAdoptHolder reads it —
		// hence synchronous, before the (equally synchronous) decision below.
		ensureOwnership(processModeOf(context.mode));
		const shared = getShared();
		shared.sessionStart = { context, api: pi };
		if (!isImOwner()) {
			// We may have started bots at factory time, when the mode was still
			// unknown. Now that another process owns IM, go quiet before serving a
			// single update: two pollers means neither can claim them reliably.
			void stopAllChannels().catch(() => undefined);
		}
		// Decided synchronously: a browser-opened session must not slip in while an
		// async refresh runs. The holder was seeded in getShared().
		const decision = mayAdoptHolder(event, context);
		if (decision) {
			setCurrentPi(pi);
			adoptControlSession(context, false, pi, decision.source);
			claimCommandContext(pi);
		} else if (holdsImLock() && !shared.holderAdopted) {
			// Owner with nothing pinned: it still needs session control, so that a
			// takeover can resume the recorded conversation (restorePinnedHolder).
			claimCommandContext(pi);
		}
		void (async () => {
			await autostartBots();
			if (decision) await restorePreferredModel(event, context);
		})().catch((e) => {
			notify(
				context as ExtensionCommandContext,
				`pi-im自启动失败:${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
		});
	});
	pi.on("message_end", (e, c) => {
		if (!trackContext(c)) return;
		getShared().bridge?.captureMessage(e.message);
	});
	pi.on("message_update", (e, c) => {
		if (!trackContext(c)) return;
		getShared().bridge?.captureStreamingMessage(e.message);
	});
	pi.on("tool_execution_start", (e, c) => {
		if (!trackContext(c)) return;
		getShared().bridge?.captureToolStart(
			e.toolCallId as string,
			e.toolName as string,
			e.args,
		);
	});
	pi.on("tool_execution_end", (e, c) => {
		if (!trackContext(c)) return;
		getShared().bridge?.captureToolEnd(
			e.toolCallId as string,
			e.result,
			e.isError === true,
			typeof e.durationMs === "number" ? e.durationMs : undefined,
		);
	});
	pi.on("agent_settled", (_e, c) => {
		if (!trackContext(c)) return;
		getShared().bridge?.settle();
	});
	pi.on("session_shutdown", (_event, context) => {
		const shared = getShared();
		const file = ctxSessionFile(context);
		const id = safeSessionId(context);
		const holding = file
			? shared.holderFile === file
			: Boolean(id) && shared.holderSessionId === id;
		if (!holding) return;
		// Keep holderFile/id/cwd: a TUI replacement reports it as
		// `previousSessionFile`, and after a pi-web restart the persisted record is
		// how warmup finds the same workspace again. Only the live handles go.
		shared.latestCtx = null;
		shared.cmdCtx = null;
		shared.holderAdopted = false;
		shared.release?.();
		shared.release = null;
	});
}
async function startTelegramSilent(
	cred: { botToken: string },
	file: TelegramFileConfig,
): Promise<void> {
	const shared = getShared();
	if (shared.tg.gateway) return;
	const gw = new TelegramGateway({
		botToken: cred.botToken,
		parseMode: file.parseMode,
	});
	const c = new ImController(gw, getBridge(), {
		allowlist: file.allowlist ?? [],
		channelName: "telegram",
		locale: shared.locale,
		sessionScope: holderSessionScope,
		progressMode: file.progressMode ?? "text",
	});
	attachRuntime(c);
	gw.onMessage((m) => dispatchInbound(c, m, "telegram"));
	await gw.start();
	// The lock can be lost while start() is in flight (a TUI claimed IM in the
	// same second). Storing the gateway anyway would leave a fallback polling
	// next to the owner forever, so close it and let the owner serve.
	if (!isImOwner()) {
		await gw.stop().catch(() => undefined);
		return;
	}
	shared.tg.gateway = gw;
	shared.tg.controller = c;
}
async function startFeishuSilent(
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
	const c = new ImController(gw, getBridge(), {
		allowlist: file.allowlist ?? [],
		channelName: "feishu",
		locale: shared.locale,
		sessionScope: holderSessionScope,
		progressMode: file.progressMode ?? "card",
	});
	attachRuntime(c);
	gw.onMessage((m) => dispatchInbound(c, m, "feishu"));
	await gw.start();
	// Same race as the Telegram path: a lock lost mid-start must not leave a
	// second websocket serving the same bot.
	if (!isImOwner()) {
		await gw.stop().catch(() => undefined);
		return;
	}
	shared.feishu.gateway = gw;
	shared.feishu.controller = c;
	// The Feishu "/" panel is server-side state this integration owns, so
	// reconcile it on every start: it is idempotent, so a run that only added a
	// command (or a fresh panel) converges and an unchanged panel costs one read.
	// Deliberately not awaited — the panel is a client-side convenience and must
	// not delay or fail the gateway coming up.
	void syncSlashCommands({
		appId: cred.appId,
		appSecret: cred.appSecret,
		domain: cred.domain,
	}).catch(() => undefined);
}
