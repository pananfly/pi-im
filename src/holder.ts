import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	type HolderRecord,
	mergeWorkspaces,
	piImDir,
	recordHolder,
} from "./config.js";
import { isChannelHealthy } from "./core/types.js";
import { imDebug } from "./debug.js";
import { registerPiWebLiveness } from "./liveness.js";
import { setCurrentPi } from "./pi-ref.js";
import { type ChannelState, getShared } from "./shared.js";
import { type ImSessionScope, installImUiBridge } from "./ui-bridge.js";

/**
 * The session this bot is driving right now, for the UI bridge's fallback.
 *
 * Only an identity (not a lookup): the bridge compares it with the session whose
 * `ctx.ui` it patched, so a turn running here cannot claim a prompt raised in
 * another session of the same pi process. Empty until a session is adopted, which
 * keeps the bridge permissive rather than silently deaf.
 */
export function holderSessionScope(): ImSessionScope | null {
	const s = getShared();
	if (!s.holderFile && !s.holderSessionId) return null;
	return { file: s.holderFile, id: s.holderSessionId };
}
/** 安全读取会话文件路径（stale ctx 可能抛错）。 */
export function ctxSessionFile(
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
export function safeSessionId(
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
export function channelAlive(state: ChannelState): boolean {
	if (!state.gateway) return false;
	return isChannelHealthy(state.gateway.getHealth?.());
}
/** Whether `ctx` is the session IM is currently driving. */
export function isHolderContext(
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
export function holderCwdNow(): string {
	const shared = getShared();
	try {
		return shared.latestCtx?.cwd ?? shared.holderCwd ?? process.cwd();
	} catch {
		return shared.holderCwd ?? process.cwd();
	}
}
/** The identity of a context, in the shape the config record uses. */
export function holderIdentityOf(
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
export function matchesSeed(
	seed: HolderRecord | null,
	ident: HolderRecord,
): boolean {
	if (!seed) return false;
	const seedFile = seed.sessionFile ?? "";
	const seedId = seed.sessionId ?? "";
	if (seedFile && ident.sessionFile && seedFile === ident.sessionFile)
		return true;
	if (seedId && ident.sessionId && seedId === ident.sessionId) return true;
	if (seedFile || seedId) return false;
	return Boolean(seed.cwd && ident.cwd && seed.cwd === ident.cwd);
}
export function sameAsHolder(ident: HolderRecord): boolean {
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
export function persistHolder(record: HolderRecord): void {
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
export function adoptControlSession(
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

export const REBIND_POLL_MS = 50;
/** 5s 足够覆盖 pi-web 新 wrapper 启动 + 扩展 factory 重跑 + 一次命令派发。 */
export function rebindTimeoutMs(): number {
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
export async function landedOnNewSession(
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
