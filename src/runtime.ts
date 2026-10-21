import { join } from "node:path";
import {
	type FeishuFileConfig,
	listPiWebWorkspacesSync,
	listWorkspaceSessionsSync,
	mergeWorkspaces,
	piImDir,
	recordPreferredModel,
	recordWorkspace,
	saveJsonAtomic,
	type TelegramFileConfig,
} from "./config.js";
import type { ImController } from "./controller.js";
import {
	adoptControlSession,
	holderCwdNow,
	landedOnNewSession,
} from "./holder.js";
import { getStrings } from "./i18n.js";
import { readJson } from "./json.js";
import {
	getCurrentPi,
	isStaleApiError,
	StaleExtensionApiError,
} from "./pi-ref.js";
import { getShared } from "./shared.js";

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
