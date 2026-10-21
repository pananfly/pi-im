// src/extension.ts

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
	readPiImConfigSync,
	recordFallbackModel,
	recordHolder,
	recordPreferredModel,
	recordWorkspace,
	resolveFeishuCredentials,
	resolveTelegramCredentials,
	saveJsonAtomic,
	shouldAutoStart,
	type TelegramFileConfig,
	updatePiImConfig,
} from "./config.js";
import { ImController } from "./controller.js";
import { isChannelHealthy } from "./core/types.js";
import { imDebug } from "./debug.js";
import { SdkFeishuGateway } from "./feishu/gateway.js";
import { syncSlashCommands } from "./feishu/slash-commands.js";
import { getStrings, type Locale, resolveLocale } from "./i18n.js";
import { registerPiWebLiveness } from "./liveness.js";
import { PiAgentBridge } from "./pi-bridge.js";
import {
	getCurrentPi,
	isStaleApiError,
	StaleExtensionApiError,
	sendViaCurrentPi,
	sendViaCurrentPiWhenReady,
	setCurrentPi,
} from "./pi-ref.js";
import { TelegramGateway } from "./telegram/gateway.js";
import {
	hasActiveImTurn,
	type ImSessionScope,
	installImUiBridge,
} from "./ui-bridge.js";

async function readJson<T>(p: string, fb: T): Promise<T> {
	try {
		return JSON.parse(await readFile(p, "utf8")) as T;
	} catch {
		return fb;
	}
}
const SKEY = "__piImShared__";
/**
 * The slice of a session entry /history needs. sessionManager.getEntries()
 * returns SessionEntry[], where a chat turn is wrapped as
 * `{ type: "message", message: { role, content } }` — the payload is nested, not
 * on the entry itself.
 */
interface SessionEntryLike {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }> | string;
	};
}
/**
 * True only while pi-im itself is re-applying the remembered model. pi emits
 * model_select from setModel(), so without this the restore would look like a
 * fresh TUI pick and stamp itself into config as one.
 */
let applyingRestore = false;
interface ChannelState {
	gateway: {
		stop(): Promise<void>;
		getHealth?(): import("./core/types.js").ChannelHealth;
	} | null;
	controller: ImController | null;
}
interface SharedState {
	feishu: ChannelState;
	tg: ChannelState;
	bridge: PiAgentBridge | null;
	autostartDone: boolean;
	/** The in-flight autostart run, so a second caller awaits instead of returning early. */
	autostartPromise: Promise<void> | null;
	release: (() => void) | null;
	latestCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null;
	cmdCtx: ExtensionCommandContext | null;
	/**
	 * The session IM actually drives. Pinned: pi-web re-runs the extension factory
	 * (and fires session_start) every time a browser opens another session, and that
	 * must not move this. Only IM's own switch commands, an explicit TUI command, or
	 * a real replacement of this very session may change it.
	 */
	holderFile: string | null;
	holderSessionId: string | null;
	/** holder 会话对应的工作区路径（用于列举会话、显示 /status 的 cwd）。 */
	holderCwd: string | null;
	/** True once any session was adopted in this process. */
	holderAdopted: boolean;
	/** True once the persisted record was loaded into `holderSeed`. */
	holderSeeded: boolean;
	/**
	 * How the current holder was chosen. "auto" is the provisional holder a
	 * restart starts with; "restored" means the persisted record already took
	 * over; "explicit" is a deliberate IM/TUI pick.
	 */
	holderSource: "auto" | "explicit" | "restored";
	/**
	 * The last deliberately chosen holder (IM command or TUI command), persisted
	 * for warmup. A provisional auto-adopt after a restart must not overwrite it;
	 * that record is what lets the recorded session take the holder back when it
	 * finally starts.
	 */
	holderSeed: HolderRecord | null;
	/** Set by an IM switch; the replacement session may take over inside this window. */
	pendingSwitchAt: number | null;
	locale: Locale;
	workspaces: string[];
}
/** How long an IM-issued switch may wait for pi-web to mint the replacement wrapper. */
const PENDING_SWITCH_TTL_MS = 20_000;
function getShared(): SharedState {
	const host = globalThis as Record<string, unknown>;
	if (!host[SKEY]) {
		host[SKEY] = {
			feishu: { gateway: null, controller: null },
			tg: { gateway: null, controller: null },
			bridge: null,
			autostartDone: false,
			autostartPromise: null,
			release: null,
			latestCtx: null,
			cmdCtx: null,
			holderFile: null,
			holderSessionId: null,
			holderCwd: null,
			holderAdopted: false,
			holderSeeded: false,
			holderSource: "auto",
			holderSeed: null,
			pendingSwitchAt: null,
			locale: "zh" as Locale,
			workspaces: [],
		};
	}
	const s = host[SKEY] as SharedState;
	if (!s.locale) s.locale = "zh";
	if (!s.workspaces) s.workspaces = [];
	// 热更新兼容：旧版 globalThis 里没有这些字段。
	// `in` rather than a read: the key is absent from the old shape, so the cast
	// is the only way to ask without lying about the declared type.
	const legacy = s as unknown as Record<string, unknown>;
	if (!("holderFile" in legacy)) s.holderFile = null;
	if (!("holderSessionId" in legacy)) s.holderSessionId = null;
	if (!("holderCwd" in legacy)) s.holderCwd = null;
	if (!("holderAdopted" in legacy)) s.holderAdopted = Boolean(s.holderFile);
	if (!("holderSeeded" in legacy)) s.holderSeeded = false;
	if (!("holderSource" in legacy)) s.holderSource = "auto";
	if (!("holderSeed" in legacy)) s.holderSeed = null;
	if (!("pendingSwitchAt" in legacy)) s.pendingSwitchAt = null;
	if (!("autostartPromise" in legacy)) s.autostartPromise = null;
	seedHolderFromDisk(s);
	return s;
}
/**
 * The session this bot is driving right now, for the UI bridge's fallback.
 *
 * Only an identity (not a lookup): the bridge compares it with the session whose
 * `ctx.ui` it patched, so a turn running here cannot claim a prompt raised in
 * another session of the same pi process. Empty until a session is adopted, which
 * keeps the bridge permissive rather than silently deaf.
 */
function holderSessionScope(): ImSessionScope | null {
	const s = getShared();
	if (!s.holderFile && !s.holderSessionId) return null;
	return { file: s.holderFile, id: s.holderSessionId };
}
/**
 * Load the persisted holder into the in-memory state once.
 *
 * Sync because `session_start` has to decide adoption immediately: awaiting the
 * async refresh there would let a browser-opened session win the race on a fresh
 * process. Only a process that has not adopted anything yet may be seeded.
 */
function seedHolderFromDisk(s: SharedState): void {
	if (s.holderSeeded || s.holderAdopted) return;
	s.holderSeeded = true;
	const cfg = readPiImConfigSync(piImDir());
	if (!cfg.holderSessionId && !cfg.holderSessionFile && !cfg.holderCwd) {
		return;
	}
	s.holderSeed = {
		...(cfg.holderSessionId ? { sessionId: cfg.holderSessionId } : {}),
		...(cfg.holderSessionFile ? { sessionFile: cfg.holderSessionFile } : {}),
		...(cfg.holderCwd ? { cwd: cfg.holderCwd } : {}),
	};
}
/** 安全读取会话文件路径（stale ctx 可能抛错）。 */
function ctxSessionFile(
	ctx:
		| import("@earendil-works/pi-coding-agent").ExtensionContext
		| null
		| undefined,
): string | undefined {
	try {
		return ctx?.sessionManager.getSessionFile() ?? undefined;
	} catch {
		return undefined;
	}
}
/** 安全读取会话 id；ExtensionContext 本身不带这个字段，只能问 session manager。 */
function safeSessionId(
	ctx:
		| import("@earendil-works/pi-coding-agent").ExtensionContext
		| null
		| undefined,
): string {
	try {
		return ctx?.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}
/**
 * Whether a channel justifies keeping its session alive.
 *
 * A missing gateway is dead, but a running gateway that cannot report health is
 * not: isChannelHealthy() treats "no report" as healthy, which is only correct
 * once we know there is something there.
 */
function channelAlive(state: ChannelState): boolean {
	if (!state.gateway) return false;
	return isChannelHealthy(state.gateway.getHealth?.());
}
/** Whether `ctx` is the session IM is currently driving. */
function isHolderContext(
	ctx:
		| import("@earendil-works/pi-coding-agent").ExtensionContext
		| null
		| undefined,
): boolean {
	const shared = getShared();
	const file = ctxSessionFile(ctx);
	if (shared.holderFile && file) return shared.holderFile === file;
	const id = safeSessionId(ctx);
	if (shared.holderSessionId && id) return shared.holderSessionId === id;
	return false;
}
/** cwd of the holder, or the best available fallback when it is gone. */
function holderCwdNow(): string {
	const shared = getShared();
	try {
		return shared.latestCtx?.cwd ?? shared.holderCwd ?? process.cwd();
	} catch {
		return shared.holderCwd ?? process.cwd();
	}
}
/** The identity of a context, in the shape the config record uses. */
function holderIdentityOf(
	ctx:
		| import("@earendil-works/pi-coding-agent").ExtensionContext
		| null
		| undefined,
): HolderRecord {
	const file = ctxSessionFile(ctx);
	const id = safeSessionId(ctx);
	let cwd = "";
	try {
		cwd = ctx?.cwd ?? "";
	} catch {}
	return {
		...(id ? { sessionId: id } : {}),
		...(file ? { sessionFile: file } : {}),
		...(cwd ? { cwd } : {}),
	};
}
/**
 * Whether `ident` is the recorded holder (same session file or id).
 *
 * cwd is only consulted when the record knows nothing else — i.e. a legacy
 * config that only ever stored a directory. Once a file or id is known, a
 * different session in the same workspace is *not* the holder: pi-web restores
 * the last tab it had open whenever a workspace is reopened, so "same cwd" would
 * otherwise let any of those tabs seize the holder mid-conversation (seen on
 * 2026-10-21 06:38:48, holder 01a159ff replaced by 01a12882).
 */
function matchesSeed(seed: HolderRecord | null, ident: HolderRecord): boolean {
	if (!seed) return false;
	const seedFile = seed.sessionFile ?? "";
	const seedId = seed.sessionId ?? "";
	if (seedFile && ident.sessionFile && seedFile === ident.sessionFile)
		return true;
	if (seedId && ident.sessionId && seedId === ident.sessionId) return true;
	if (seedFile || seedId) return false;
	return Boolean(seed.cwd && ident.cwd && seed.cwd === ident.cwd);
}
function sameAsHolder(ident: HolderRecord): boolean {
	const shared = getShared();
	if (
		shared.holderFile &&
		ident.sessionFile &&
		shared.holderFile === ident.sessionFile
	)
		return true;
	if (
		shared.holderSessionId &&
		ident.sessionId &&
		shared.holderSessionId === ident.sessionId
	)
		return true;
	return false;
}
/** Persist a chosen holder; failures only cost the restart restore. */
function persistHolder(record: HolderRecord): void {
	void recordHolder(piImDir(), record).catch(() => undefined);
}
/**
 * Make `ctx` the session IM drives.
 *
 * `isCommand` distinguishes the two contexts pi hands out: `session_start`
 * carries a plain ExtensionContext (no newSession/switchSession), while a real
 * command handler gets the command-capable one — only the latter may become
 * `shared.cmdCtx`. `api` is the factory's ExtensionAPI for this session; pinning
 * it here is what makes every later IM send target this session instead of the
 * newest factory run.
 *
 * `source` decides what survives a restart: only a deliberate choice (IM command,
 * TUI command, or the first-ever baseline) is written to config.json. A
 * provisional auto-adopt is left out on purpose, so a warmup can still bring the
 * recorded holder back after the browser opened some other session first.
 */
function adoptControlSession(
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
	isCommand: boolean,
	api: ExtensionAPI | undefined,
	source: "auto" | "explicit" | "restored",
): void {
	const shared = getShared();
	const ident = holderIdentityOf(ctx);
	shared.latestCtx = ctx;
	if (isCommand) shared.cmdCtx = ctx as ExtensionCommandContext;
	shared.holderFile = ident.sessionFile ?? null;
	shared.holderSessionId = ident.sessionId ?? null;
	shared.holderCwd = ident.cwd ?? shared.holderCwd ?? process.cwd();
	try {
		shared.workspaces = mergeWorkspaces(
			shared.workspaces,
			shared.holderCwd,
		).slice(0, 20);
	} catch {}
	shared.holderAdopted = true;
	shared.holderSeeded = true;
	shared.holderSource = source;
	shared.pendingSwitchAt = null;
	if (api) setCurrentPi(api);
	// Bridge this session's shared UI context so ask_user lands in the IM chat.
	//
	// `ctx.ui` is one object shared by every extension in the session (pi's
	// runner wraps it once), so patching it here also covers pi-ask-user. Only
	// the holder is patched, and the bridge itself only takes over prompts
	// raised inside an IM-driven turn — a browser turn keeps its own dialogs.
	//
	// The session identity goes with the patch: another session of the same pi
	// process keeps its own UI object, and only this one may answer to the
	// holder's turn.
	try {
		installImUiBridge(ctx.ui, ctx.mode, ctx.hasUI, holderSessionScope());
	} catch {
		// A host without a patchable UI context must not break adoption.
	}
	imDebug(
		"adopt",
		source,
		shared.holderCwd,
		ident.sessionId ?? "-",
		String(ctx.mode),
		`hasUI=${String(ctx.hasUI)}`,
	);
	// Liveness must follow the holder, not the newest factory run: a session the
	// browser merely opened must stay evictable, while the holder stays alive as
	// long as a gateway genuinely works.
	shared.release?.();
	shared.release = registerPiWebLiveness({
		sessionId: ident.sessionId ?? "",
		...(ident.sessionFile ? { sessionFile: ident.sessionFile } : {}),
		isActive: () => channelAlive(shared.feishu) || channelAlive(shared.tg),
	});
	if (source === "explicit" || !shared.holderSeed) {
		shared.holderSeed = ident;
		persistHolder(ident);
	}
}
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

const REBIND_POLL_MS = 50;
/** 5s 足够覆盖 pi-web 新 wrapper 启动 + 扩展 factory 重跑 + 一次命令派发。 */
function rebindTimeoutMs(): number {
	const n = Number(process.env.PIIM_REBIND_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : 5_000;
}

/**
 * 判断一次会话切换是否真的落位。
 *
 * TUI：switchSession 同步调用 withSession，回调里 adoptControlSession 就地换掉控制
 * 句柄，所以 switched 直接为真。
 *
 * pi-web：控制单位是 wrapper 而不是 AgentSession —— 每个 wrapper 一生只绑定一个
 * AgentSession（inner 从不重新赋值），"切换"其实是新建并注册一个 wrapper。它不暴露
 * createCommandContext，造不出 withSession 需要的 command context，所以该回调永远
 * 不会被调用。这是宿主限制，不是切换失败，早先的 `if (!switched) throw` 就是在这
 * 里误报的。
 *
 * pi-im 自己的落位链路：新 wrapper 会重跑 extension factory → session_start →
 * claimCommandContext() → /_piim-adopt → adoptControlSession(ctx, true)，换上一个新
 * ctx。所以判据从"回调有没有被调用"改成"cmdCtx 是不是换成了另一个对象"。
 *
 * 必须拿切换前的句柄做比较：旧句柄在新 session_start 到达之前一直有效，只判
 * Boolean(cmdCtx) 会立即为真，等于没等。
 */
async function landedOnNewSession(
	switched: boolean,
	before: ExtensionCommandContext | null,
): Promise<boolean> {
	if (switched) return true;
	const shared = getShared();
	const deadline = Date.now() + rebindTimeoutMs();
	for (;;) {
		const now = shared.cmdCtx;
		if (now && now !== before) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, REBIND_POLL_MS));
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
async function runAutostart(): Promise<void> {
	try {
		await refreshSharedMeta();
	} catch {
		// 元信息刷新失败不阻断启动
	}
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
	if (fCred && shouldAutoStart("feishu", process.env, feishuFile)) {
		await startFeishuSilent(fCred, feishuFile).catch(() => undefined);
	}
	const tCred = resolveTelegramCredentials(process.env, tgFile);
	if (tCred && shouldAutoStart("telegram", process.env, tgFile)) {
		await startTelegramSilent(tCred, tgFile).catch(() => undefined);
	}
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
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/**
 * Mirrors getSupportedThinkingLevels() from @earendil-works/pi-ai (models.js).
 *
 * `xhigh` and `max` are opt-in: a model must name them in thinkingLevelMap, so a
 * plain model silently loses them. That is why /thinking max used to report
 * success while the session stayed on the next level down.
 */
function supportedThinkingLevels(model: unknown): string[] {
	const m = model as {
		reasoning?: boolean;
		thinkingLevelMap?: Record<string, string | null>;
	} | null;
	if (!m?.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = m.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * Fire-and-forget inbound dispatch that never leaves a rejection unobserved.
 *
 * `void c.handleInbound(m)` discards the promise: any throw inside the handler
 * (a channel send failure, a stale context, anything raised while composing a
 * reply) becomes an unhandled rejection, and Node kills the pi process on it.
 * That is how one broken Feishu send took down the whole TUI.
 */
export function dispatchInbound(
	c: ImController,
	m: import("./core/types.js").InboundMessage,
	label: string,
): void {
	void c.handleInbound(m).catch((e) => {
		console.error(`[pi-im] ${label} 处理入站消息失败:`, e);
	});
}

export function attachRuntime(c: ImController): void {
	const shared = getShared();
	const t = () => getStrings(shared.locale);
	c.runtime = {
		newSession: async () => {
			const cmd = shared.cmdCtx;
			if (!cmd) throw new Error(t().sessionNoCtx);
			if (shared.latestCtx?.isIdle() === false) throw new Error(t().newBusy);
			// pi-web creates a brand-new wrapper without a previousSessionFile,
			// so the only way the replacement may take over is an explicit
			// in-flight marker. TUI also reports it, so this is safe there too.
			shared.pendingSwitchAt = Date.now();
			try {
				const r = await cmd.newSession({
					withSession: async (next) => {
						adoptControlSession(next, true, undefined, "explicit");
					},
				});
				if (r.cancelled) shared.pendingSwitchAt = null;
				return !r.cancelled;
			} catch (e) {
				shared.pendingSwitchAt = null;
				if (isStaleApiError(e)) {
					shared.cmdCtx = null;
					throw new Error(t().sessionStale);
				}
				throw e;
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
		cwd: () => holderCwdNow(),
		sessionFile: () => {
			if (shared.holderFile) return shared.holderFile;
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
		listThinkingLevels: () => supportedThinkingLevels(shared.latestCtx?.model),
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
		canControlSession: () => {
			// The auto-adopt round trip is deliberately indirect (it rides pi's own
			// command dispatch). If a future pi stops dispatching extension-issued
			// "/..." payloads, this is the only signal — otherwise /new would just
			// quietly keep failing with "run /tg status first".
			return Boolean(shared.cmdCtx);
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
			let ok: boolean;
			try {
				ok = await getCurrentPi().setModel(full);
			} catch (e) {
				if (isStaleApiError(e)) throw new StaleExtensionApiError(e);
				throw e;
			}
			if (!ok) throw new Error(t().modelNoKey);
			const mm = full as { id?: string; name?: string; provider?: unknown };
			const provider =
				typeof mm.provider === "string" ? mm.provider : undefined;
			// Remember the pick: /new would otherwise reset to the default model.
			await recordPreferredModel(piImDir(), {
				id: String(mm.id ?? q),
				name: mm.name,
				provider,
				via: "im",
			}).catch(() => undefined);
			return {
				id: String(mm.id ?? q),
				name: mm.name,
				provider,
			};
		},
		setThinking: (level: string) => {
			const wanted = level.trim().toLowerCase();
			const ctx = shared.latestCtx;
			if (!ctx) return { ok: false, reason: "no-session" as const };
			const available = supportedThinkingLevels(ctx.model);
			// pi would clamp an unknown level to the lowest supported one, which
			// reads as "you asked for off and got off". Reject it instead, with the
			// list that actually works.
			if (!(THINKING_LEVELS as readonly string[]).includes(wanted)) {
				return { ok: false, reason: "invalid" as const, available };
			}
			try {
				getCurrentPi().setThinkingLevel(
					wanted as Parameters<
						import("@earendil-works/pi-coding-agent").ExtensionAPI["setThinkingLevel"]
					>[0],
				);
			} catch (e) {
				if (isStaleApiError(e)) {
					return { ok: false, reason: "stale" as const, available };
				}
				return { ok: false, reason: "invalid" as const, available };
			}
			// setThinkingLevel returns void and clamps silently, so the only way to
			// learn what is live is to read it back off the context.
			let effective = wanted;
			try {
				const live = shared.latestCtx?.thinkingLevel;
				if (typeof live === "string") effective = live;
			} catch {
				// ctx swapped mid-call; fall back to the requested level.
			}
			return {
				ok: true,
				level: effective,
				clamped: effective !== wanted,
				available,
			};
		},
		readHistory: (n: number) => {
			try {
				const entries = shared.latestCtx?.sessionManager.getEntries() as
					| SessionEntryLike[]
					| undefined;
				if (!entries) return [];
				const out: string[] = [];
				for (const e of entries) {
					// getEntries() yields SessionEntry[], not AgentMessage[]. Only a
					// "message" entry carries the payload, and it lives one level
					// down under .message — reading .role here silently matched
					// nothing and made /history claim an empty session.
					if (e.type !== "message") continue;
					const m = e.message;
					if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
					let text = "";
					if (typeof m.content === "string") text = m.content;
					else if (Array.isArray(m.content)) {
						text = m.content
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
			const cur = holderCwdNow();
			// Live discovery, every call: a workspace created in pi-web after
			// startup must show up without restarting pi-im, and without having
			// been selected over IM before.
			return mergeWorkspaces(
				shared.workspaces,
				cur,
				listPiWebWorkspacesSync(),
			).slice(0, 20);
		},
		listSessions: () => {
			const cur = holderCwdNow();
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
			// Pi 会话的 cwd 不可变:process.chdir 切不动,必须切到目标目录的会话。
			// 记忆历史先落盘,切成功与否下次 /wsl 都可见。
			try {
				shared.workspaces = await recordWorkspace(piImDir(), resolved);
			} catch {}
			const targets = (() => {
				try {
					return listWorkspaceSessionsSync(resolved);
				} catch {
					return [];
				}
			})();
			if (targets.length === 0) return t().workspaceNoSession(resolved);
			const cmd = shared.cmdCtx;
			if (!cmd) throw new Error(t().sessionNoCtx);
			const first = targets[0];
			if (!first) return t().workspaceNoSession(resolved);
			const before = shared.cmdCtx;
			let switched = false;
			shared.pendingSwitchAt = Date.now();
			try {
				const result = await cmd.switchSession(first.file, {
					withSession: async (next) => {
						adoptControlSession(next, true, undefined, "explicit");
						switched = true;
					},
				});
				if (result.cancelled) throw new Error(t().workspaceCancelled);
			} catch (e) {
				shared.pendingSwitchAt = null;
				if (isStaleApiError(e)) {
					shared.cmdCtx = null;
					throw new Error(t().sessionStale);
				}
				throw e;
			}
			if (!(await landedOnNewSession(switched, before))) {
				shared.pendingSwitchAt = null;
				throw new Error(t().workspaceUnsupported);
			}
			shared.holderCwd = resolved;
			return t().workspaceSwitchedWithSession(
				resolved,
				first.title ?? first.id.slice(0, 8),
			);
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
				if (result.cancelled) throw new Error(t().sessionCancelled);
			} catch (e) {
				shared.pendingSwitchAt = null;
				if (isStaleApiError(e)) {
					shared.cmdCtx = null;
					throw new Error(t().sessionStale);
				}
				throw e;
			}
			if (!(await landedOnNewSession(switched, before))) {
				shared.pendingSwitchAt = null;
				throw new Error(t().sessionUnsupported);
			}
			return t().sessionBound(target);
		},
		setProgressMode: async (mode) => {
			// The controller already knows its channel, so the file name follows
			// from it instead of from a second attachRuntime() parameter.
			const channel = c.channelName();
			const path = join(piImDir(), `${channel}.json`);
			const prev = await readJson<FeishuFileConfig & TelegramFileConfig>(
				path,
				{},
			);
			// Disk first, memory second. A failed write must leave the live mode
			// untouched, so /status never advertises a switch a restart undoes.
			await saveJsonAtomic(path, { ...prev, progressMode: mode });
			// Read the shared slot rather than closing over `c`: the gateway may
			// have swapped in a newer controller, and setAllowlist already relies
			// on the slot being the authority.
			// The key is `tg`, not `telegram` — shared[channel] would be undefined.
			const slot = channel === "telegram" ? shared.tg : shared.feishu;
			slot.controller?.setProgressMode(mode);
		},
	};
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
			if (identified && !isHolderContext(ctx) && !pendingFresh) return;
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
		// Decided synchronously: a browser-opened session must not slip in while an
		// async refresh runs. The holder was seeded in getShared().
		const decision = mayAdoptHolder(event, context);
		if (decision) {
			setCurrentPi(pi);
			adoptControlSession(context, false, pi, decision.source);
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
