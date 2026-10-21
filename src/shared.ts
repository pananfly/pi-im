import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type HolderRecord, piImDir, readPiImConfigSync } from "./config.js";
import type { ImController } from "./controller.js";
import type { Locale } from "./i18n.js";
import type { OwnerLock, ProcessMode } from "./owner.js";
import type { PiAgentBridge } from "./pi-bridge.js";

const SKEY = "__piImShared__";

export interface ChannelState {
	gateway: {
		stop(): Promise<void>;
		getHealth?(): import("./core/types.js").ChannelHealth;
	} | null;
	controller: ImController | null;
}
export interface SharedState {
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
	/**
	 * The host mode this process runs in — "tui" in a terminal, "rpc" under
	 * pi-web — or null until the first `session_start` reports it. Only a known
	 * mode turns on cross-process arbitration: a host that never says which it is
	 * keeps the old single-process behaviour, which is also what every existing
	 * test expects.
	 */
	ownerMode: ProcessMode | null;
	/** This process's IM lock; null until the mode is known (see src/owner.ts). */
	owner: OwnerLock | null;
	/** The newest `session_start`, so a regained owner can act without waiting for one. */
	sessionStart: { context: ExtensionContext; api: ExtensionAPI } | null;
	/** Guards the regained-owner restore against overlapping runs. */
	restoring: boolean;
}

/** How long an IM-issued switch may wait for pi-web to mint the replacement wrapper. */
export const PENDING_SWITCH_TTL_MS = 20_000;

export function getShared(): SharedState {
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
			ownerMode: null,
			owner: null,
			sessionStart: null,
			restoring: false,
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
	if (!("ownerMode" in legacy)) s.ownerMode = null;
	if (!("owner" in legacy)) s.owner = null;
	if (!("sessionStart" in legacy)) s.sessionStart = null;
	if (!("restoring" in legacy)) s.restoring = false;
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
