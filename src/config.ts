import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
export type ChannelKind = "feishu" | "telegram";
export interface PiImFileConfig {
	workspaces?: string[];
	holderSessionId?: string;
	holderCwd?: string;
	/**
	 * Absolute path of the session file the holder was last bound to.
	 *
	 * The id alone is not enough to resume: pi-web's `/api/agent/<id>` resolves
	 * through its session index, which a brand-new session may not have reached
	 * yet, while the file is what `switchSession` actually opens.
	 */
	holderSessionFile?: string;
	locale?: string;
	/**
	 * Model the user last picked over IM. Re-applied when a *new* session starts,
	 * because ExtensionAPI.setModel has no `persist` option and every /new
	 * otherwise resets to pi's configured default.
	 */
	preferredModel?: PreferredModel;
}
export interface PreferredModel {
	provider?: string;
	id: string;
	name?: string;
	/**
	 * Where the pick came from. An "im" pick outranks a "tui" one forever:
	 * switching remotely is a deliberate act, and it must not be undone by
	 * later model cycling at the terminal.
	 */
	via?: "im" | "tui";
}
export interface FeishuFileConfig {
	appId?: string;
	appSecret?: string;
	domain?: "feishu" | "lark";
	autoStart?: boolean;
	allowlist?: string[];
	/**
	 * How a running turn is shown. "text" is a plain message edited in place;
	 * "card" posts one interactive card and replaces it in place.
	 *
	 * Defaults to "card" for Feishu (see feishuSetupConfig); "text" stays the
	 * Telegram default because that gateway exposes no card capability at all,
	 * so a "card" value there would be a silent no-op.
	 */
	progressMode?: "text" | "card";
}
export interface TelegramFileConfig {
	botToken?: string;
	autoStart?: boolean;
	allowlist?: string[];
	/**
	 * How a running turn is shown. "text" is a plain message edited in place.
	 * A "card" value is accepted for forward compatibility with a Telegram-side
	 * inline keyboard, but the gateway exposes no card capability yet, so the
	 * controller's capability check falls back to text — setting this alone
	 * changes nothing.
	 */
	progressMode?: "text" | "card";
	/**
	 * How outgoing text is formatted.
	 *
	 * "plain" (default) sends the model's Markdown verbatim, which Telegram
	 * shows unrendered — literal `**bold**` and ``` fences. "markdownV2" asks
	 * Telegram to render it, and escapes `_ * [ ] ( ) ~ ` > # + - = | { } . !`
	 * to keep the rest literal. Opt in deliberately: the escape set is large and
	 * applies to every answer.
	 */
	parseMode?: "plain" | "markdownV2";
}
export function piImDir(): string {
	// Test/debug escape hatch; mirrors pi's own PI_CODING_AGENT_DIR convention.
	const override = process.env.PI_IM_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent", "pi-im");
}

let cachedVersion: { url: string; version: string } | undefined;

/**
 * The real version, read from package.json.
 *
 * `/version` and the `/status` banner used to carry a hardcoded "pi-im 0.1.0".
 * That agrees with package.json only until the next release, at which point the
 * bot starts reporting a version it is not — and nothing fails, because a string
 * literal always works. Reading the manifest removes the possibility.
 *
 * Resolved relative to this module, so it is the same file from src/ (tests) and
 * from dist/ (the extension pi actually loads); both sit one level under the
 * package root.
 *
 * @param manifestUrl override, so the failure paths are testable without
 * mocking fs. Defaults to the shipped manifest.
 * @returns the version, or "unknown" if it cannot be read or is malformed.
 * "unknown" is deliberate: it is visibly wrong, where a plausible-looking
 * number would not be.
 */
export function piImVersion(
	manifestUrl: URL = new URL("../package.json", import.meta.url),
): string {
	// Keyed by url, so a test asking for some other manifest never poisons (or
	// is served from) the real one.
	if (cachedVersion?.url === manifestUrl.href) return cachedVersion.version;
	let version: string;
	try {
		const parsed = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
			version?: unknown;
		};
		version = typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		version = "unknown";
	}
	cachedVersion = { url: manifestUrl.href, version };
	return version;
}
export async function saveJsonAtomic(
	path: string,
	obj: unknown,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// Unique per call: holder persistence and a workspace refresh can overlap,
	// and a shared pid-only temp name would make one rename fail (and lose the
	// write) instead of merely letting the last writer win.
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0x180 });
	try {
		await rename(tmp, path);
	} catch (e: unknown) {
		const code = (e as { code?: string })?.code;
		if (code === "EEXIST" || code === "EPERM" || code === "EBUSY") {
			await rm(path, { force: true }).catch(() => {});
			await rename(tmp, path);
		} else {
			await rm(tmp, { force: true }).catch(() => {});
			throw e;
		}
	}
}
function isTruthyEnv(v: string | undefined): boolean | undefined {
	if (v === undefined) return undefined;
	const s = v.toLowerCase();
	if (["1", "true", "yes", "on"].includes(s)) return true;
	if (["0", "false", "no", "off"].includes(s)) return false;
	return undefined;
}
export function shouldAutoStart(
	kind: ChannelKind,
	env: NodeJS.ProcessEnv,
	file: { autoStart?: boolean },
): boolean {
	void kind;
	const envFlag = isTruthyEnv(env.PI_IM_AUTO_START);
	if (envFlag !== undefined) return envFlag;
	return file.autoStart ?? true;
}
/**
 * The shape `/feishu setup` persists.
 *
 * Card rendering is the default on a fresh setup: Feishu is the only channel
 * with a card surface, so plain text there means throwing away the thinking and
 * tool panels for no reason. An existing `progressMode` is never overwritten —
 * re-running setup to rotate credentials must not undo a `/feishu text` the user
 * deliberately chose.
 */
export function feishuSetupConfig(
	prev: FeishuFileConfig,
	appId: string,
	appSecret: string,
): FeishuFileConfig {
	return {
		...prev,
		appId,
		appSecret,
		domain: prev.domain ?? "feishu",
		autoStart: prev.autoStart ?? true,
		progressMode: prev.progressMode ?? "card",
	};
}

export function resolveFeishuCredentials(
	env: NodeJS.ProcessEnv,
	file: FeishuFileConfig,
): { appId: string; appSecret: string; domain: "feishu" | "lark" } | null {
	const appId = env.FEISHU_APP_ID ?? file.appId;
	const appSecret = env.FEISHU_APP_SECRET ?? file.appSecret;
	if (!appId || !appSecret) return null;
	return { appId, appSecret, domain: file.domain ?? "feishu" };
}
export function resolveTelegramCredentials(
	env: NodeJS.ProcessEnv,
	file: TelegramFileConfig,
): { botToken: string } | null {
	const botToken = env.TELEGRAM_BOT_TOKEN ?? file.botToken;
	if (!botToken) return null;
	return { botToken };
}

/** Read config.json (never throws, returns {} on missing/corrupt). */
export async function readPiImConfig(
	dir: string = piImDir(),
): Promise<PiImFileConfig> {
	try {
		const raw = await readFile(join(dir, "config.json"), "utf8");
		const parsed = JSON.parse(raw) as PiImFileConfig;
		if (parsed && typeof parsed === "object") return parsed;
		return {};
	} catch {
		return {};
	}
}

/**
 * Serialized read-modify-write for config.json.
 *
 * Several independent writers touch the same file (holder identity, workspace
 * history, the remembered model). Unsynchronized read-modify-write lets one
 * writer re-create a field another just removed. The queue only orders writes
 * inside this process, which is where they all come from.
 */
let configWriteTail: Promise<void> = Promise.resolve();
export function updatePiImConfig(
	dir: string,
	mutate: (prev: PiImFileConfig) => PiImFileConfig | null,
): Promise<void> {
	const path = join(dir, "config.json");
	const run = configWriteTail.then(async () => {
		const prev = await readPiImConfig(dir);
		const next = mutate(prev);
		if (next) await saveJsonAtomic(path, next);
	});
	configWriteTail = run.catch(() => undefined);
	return run;
}
/**
 * Sync variant for decisions that cannot await: `getShared()` seeding and the
 * first `session_start` must know about a persisted holder before the async
 * refresh has had a chance to finish.
 */
export function readPiImConfigSync(dir: string = piImDir()): PiImFileConfig {
	try {
		const parsed = JSON.parse(
			readFileSync(join(dir, "config.json"), "utf8"),
		) as PiImFileConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** The holder identity pi-im persists so a restart can come back to it. */
export interface HolderRecord {
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
}

/** The persisted holder, or null when this profile has never selected one. */
export function readHolderRecordSync(
	dir: string = piImDir(),
): HolderRecord | null {
	const cfg = readPiImConfigSync(dir);
	if (!cfg.holderSessionId && !cfg.holderSessionFile && !cfg.holderCwd)
		return null;
	return {
		...(cfg.holderSessionId ? { sessionId: cfg.holderSessionId } : {}),
		...(cfg.holderSessionFile ? { sessionFile: cfg.holderSessionFile } : {}),
		...(cfg.holderCwd ? { cwd: cfg.holderCwd } : {}),
	};
}

/**
 * Persist the holder identity.
 *
 * Only writes when one of the three fields actually changed: this runs on
 * every `session_start` (including re-claims) and a no-op rewrite would turn a
 * read-only state into disk churn. Failures are swallowed by the caller — the
 * holder still works for this process, only the restart restore is lost.
 */
export async function recordHolder(
	dir: string,
	holder: HolderRecord,
): Promise<void> {
	await updatePiImConfig(dir, (prev) => {
		const same =
			(prev.holderSessionId ?? "") === (holder.sessionId ?? "") &&
			(prev.holderSessionFile ?? "") === (holder.sessionFile ?? "") &&
			(prev.holderCwd ?? "") === (holder.cwd ?? "");
		if (same) return null;
		return {
			...prev,
			holderSessionId: holder.sessionId,
			holderSessionFile: holder.sessionFile,
			holderCwd: holder.cwd,
		};
	});
}

/** Resolve pi agent dir (env override or ~/.pi/agent). */
export function piAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent");
}

/** Discover workspace dirs from session files (first-line cwd), newest first. */
export async function discoverSessionWorkspaces(
	agentDir: string = piAgentDir(),
	maxDirs = 30,
): Promise<string[]> {
	const { readdir, open, stat } = await import("node:fs/promises");
	const sessionsDir = join(agentDir, "sessions");
	let subdirs: string[];
	try {
		subdirs = await readdir(sessionsDir);
	} catch {
		return [];
	}
	// newest subdirs first (best-effort, ignore errors)
	const withTime = await Promise.all(
		subdirs.map(async (d) => {
			try {
				const st = await stat(join(sessionsDir, d));
				return { d, mtime: st.mtimeMs };
			} catch {
				return { d, mtime: 0 };
			}
		}),
	);
	withTime.sort((a, b) => b.mtime - a.mtime);
	const out: string[] = [];
	for (const { d } of withTime.slice(0, maxDirs)) {
		const sub = join(sessionsDir, d);
		let files: string[];
		try {
			files = await readdir(sub);
		} catch {
			continue;
		}
		const jsonls = files.filter((f) => f.endsWith(".jsonl")).slice(-3);
		for (const f of jsonls) {
			try {
				const h = await open(join(sub, f), "r");
				try {
					const buf = Buffer.alloc(2048);
					const { bytesRead } = await h.read(buf, 0, 2048, 0);
					const firstLine = buf
						.toString("utf8", 0, bytesRead)
						.split("\n")[0] as string;
					const parsed = JSON.parse(firstLine ?? "") as {
						cwd?: unknown;
					};
					if (typeof parsed.cwd === "string" && parsed.cwd) {
						if (!out.includes(parsed.cwd)) out.push(parsed.cwd);
					}
				} finally {
					await h.close();
				}
			} catch {
				continue;
			}
			if (out.length >= maxDirs) break;
		}
		if (out.length >= maxDirs) break;
	}
	// keep only dirs that still exist (best-effort, cap checks)
	const existing: string[] = [];
	for (const p of out) {
		try {
			const st = await stat(p);
			if (st.isDirectory()) existing.push(p);
		} catch {}
	}
	return existing;
}
/** First-line cwd of a session file, or undefined when unreadable/not a session. */
function readSessionCwdSync(file: string): string | undefined {
	try {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(2048);
			const bytes = readSync(fd, buf, 0, 2048, 0);
			const firstLine = buf.toString("utf8", 0, bytes).split("\n")[0];
			const parsed = JSON.parse(firstLine ?? "") as { cwd?: unknown };
			return typeof parsed.cwd === "string" && parsed.cwd
				? parsed.cwd
				: undefined;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/**
 * Workspace history the way pi-web sees it.
 *
 * pi-im used to rely on its own config.json list, so a directory only appeared
 * in /wsl after someone had already selected it over IM — a workspace created in
 * pi-web (or the `pi` CLI) stayed invisible until then. Both hosts already
 * record the cwd: pi-web in `pi-web-session-index.json` (`info.cwd`), the CLI in
 * each session file's first line. Reading those is the source of truth, and a
 * workspace becomes switchable as soon as it has a session.
 *
 * Sync on purpose: `/wsl` and `/workspace <n>` must agree inside one message,
 * and the index is a single file. The sessions-dir scan stays as a fallback for
 * profiles that never ran pi-web.
 */
export function listPiWebWorkspacesSync(
	agentDir: string = piAgentDir(),
	maxItems = 20,
): string[] {
	// cwd -> newest timestamp we have seen for it
	const seen = new Map<string, number>();
	const add = (cwd: string, at: number) => {
		if (!cwd || !existsSync(cwd)) return;
		const prev = seen.get(cwd);
		if (prev === undefined || at > prev) seen.set(cwd, at);
	};
	// 1. pi-web's index: one entry per session it has ever listed.
	try {
		const raw = readFileSync(
			join(agentDir, "pi-web-session-index.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw) as {
			entries?: Record<string, WebIndexEntry>;
		};
		for (const entry of Object.values(parsed.entries ?? {})) {
			const info = entry.info;
			if (!info?.cwd) continue;
			add(info.cwd, Date.parse(info.modified ?? info.created ?? "") || 0);
		}
	} catch {
		// no index (never ran pi-web) — the sessions scan below still works
	}
	// 2. sessions/<encoded-cwd>/: the CLI layout. Filenames start with an ISO
	//    timestamp, so the lexicographic last file is the newest.
	try {
		const sessionsDir = join(agentDir, "sessions");
		for (const d of readdirSync(sessionsDir)) {
			const sub = join(sessionsDir, d);
			let mtime = 0;
			try {
				mtime = statSync(sub).mtimeMs;
			} catch {
				continue;
			}
			let files: string[];
			try {
				files = readdirSync(sub).filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}
			const newest = files.sort().at(-1);
			if (!newest) continue;
			const cwd = readSessionCwdSync(join(sub, newest));
			if (cwd) add(cwd, mtime);
		}
	} catch {}
	return [...seen.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([cwd]) => cwd)
		.slice(0, maxItems);
}

/** Merge stored history with current cwd: current first, then history, deduped. */
export function mergeWorkspaces(
	stored: string[] | undefined,
	current: string,
	extra?: string[],
): string[] {
	const out: string[] = [current];
	for (const w of [...(stored ?? []), ...(extra ?? [])]) {
		if (w !== current && !out.includes(w)) out.push(w);
	}
	return out;
}

/** Record a workspace dir into config.json history (prepend, dedupe, cap 20). */
export async function recordWorkspace(
	dir: string,
	cwd: string,
): Promise<string[]> {
	let recorded: string[] = mergeWorkspaces(undefined, cwd).slice(0, 20);
	await updatePiImConfig(dir, (prev) => {
		recorded = mergeWorkspaces(prev.workspaces, cwd).slice(0, 20);
		return { ...prev, workspaces: recorded };
	});
	return recorded;
}

/** Remember the model the user picked, so /new does not silently reset it. */
export async function recordPreferredModel(
	dir: string,
	model: PreferredModel,
): Promise<void> {
	await updatePiImConfig(dir, (prev) => ({
		...prev,
		preferredModel: model,
	}));
}

/**
 * Record a model picked in the TUI, but only as a fallback: once an "im" pick
 * exists it is left alone, so terminal model cycling cannot quietly override a
 * deliberate remote choice.
 */
export async function recordFallbackModel(
	dir: string,
	model: PreferredModel,
): Promise<void> {
	await updatePiImConfig(dir, (prev) =>
		prev.preferredModel?.via === "im"
			? null
			: { ...prev, preferredModel: { ...model, via: "tui" } },
	);
}

/** One session row for /sessionlist (file = absolute .jsonl path for switchSession). */
export interface SessionListItem {
	id: string;
	title?: string;
	file: string;
}

/** Encode cwd to pi sessions subdir name, e.g. `/a/b` -> `--a-b--`.
 *
 *  Mirrors pi's getDefaultSessionDirPath(): pi resolves the cwd with
 *  path.resolve before encoding, so a trailing separator or a "." segment never
 *  reaches the directory name. Resolving is platform-bound — on POSIX a
 *  "C:\\..." string is relative, and resolving it would prefix the process cwd
 *  — so only what this platform calls absolute is normalized, and separators are
 *  trimmed first because path.resolve keeps a trailing "\\" on POSIX. */
export function encodeCwdSubdir(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const normalized = isAbsolute(trimmed) ? resolve(trimmed) : trimmed;
	const stripped = normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return `--${stripped}--`;
}

/** True when two absolute paths name the same directory.
 *
 *  Plain `===` is platform-naive: Windows paths compare case-insensitively and
 *  tolerate either separator, so an index written as `C:\Users\pan\proj` would
 *  miss a `c:/Users/pan/proj` lookup. Only absolute inputs are resolved; a
 *  relative or foreign path is compared verbatim so nothing is invented. */
export function samePath(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (!isAbsolute(a) || !isAbsolute(b)) return false;
	const na = resolve(a);
	const nb = resolve(b);
	return process.platform === "win32"
		? na.toLowerCase() === nb.toLowerCase()
		: na === nb;
}

interface WebIndexEntry {
	fp?: { size?: number; mtimeMs?: number };
	info?: {
		path?: string;
		id?: string;
		cwd?: string;
		firstMessage?: string;
		messageCount?: number;
		created?: string;
		modified?: string;
	};
}

/**
 * List sessions of one workspace, newest first (sync: pi-web index is ~40KB).
 * Primary: pi-web-session-index.json (has id/cwd/firstMessage/path).
 * Fallback: scan sessions/<encoded-cwd>/ filenames when index is missing/stale.
 */
export function listWorkspaceSessionsSync(
	cwd: string,
	agentDir: string = piAgentDir(),
	maxItems = 50,
): SessionListItem[] {
	// --- primary: pi-web index ---
	try {
		const indexPath = join(agentDir, "pi-web-session-index.json");
		if (existsSync(indexPath)) {
			const raw = readFileSync(indexPath, "utf8");
			const parsed = JSON.parse(raw) as {
				entries?: Record<string, WebIndexEntry>;
			};
			const entries = parsed.entries ?? {};
			const rows: Array<SessionListItem & { modified: string }> = [];
			for (const entry of Object.values(entries)) {
				const info = entry.info;
				if (!info || !samePath(info.cwd, cwd)) continue;
				if (!info.id || !info.path) continue;
				rows.push({
					id: info.id,
					title: info.firstMessage?.slice(0, 80) || undefined,
					file: info.path,
					modified: info.modified ?? info.created ?? "",
				});
			}
			if (rows.length > 0) {
				rows.sort((a, b) => (b.modified < a.modified ? -1 : 1));
				return rows.slice(0, maxItems).map(({ id, title, file }) => ({
					id,
					title,
					file,
				}));
			}
		}
	} catch {
		// fall through to directory scan
	}
	// --- fallback: scan sessions/<encoded-cwd>/ ---
	try {
		const sub = join(agentDir, "sessions", encodeCwdSubdir(cwd));
		if (!existsSync(sub)) return [];
		const files = readdirSync(sub).filter((f: string) => f.endsWith(".jsonl"));
		const rows = files
			.map((f: string) => {
				const m = f.match(/_([0-9a-f-]{36})\.jsonl$/i);
				if (!m?.[1]) return null;
				let mtime = 0;
				try {
					mtime = statSync(join(sub, f)).mtimeMs;
				} catch {
					mtime = 0;
				}
				return { id: m[1] as string, file: join(sub, f), mtime };
			})
			.filter((x: unknown): x is { id: string; file: string; mtime: number } =>
				Boolean(x),
			)
			.sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime)
			.slice(0, maxItems)
			.map(({ id, file }: { id: string; file: string }) => ({ id, file }));
		return rows;
	} catch {
		return [];
	}
}
