import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export type ChannelKind = "feishu" | "telegram";
export interface PiImFileConfig {
	workspaces?: string[];
	holderSessionId?: string;
	holderCwd?: string;
	locale?: string;
}
export interface FeishuFileConfig {
	appId?: string;
	appSecret?: string;
	domain?: "feishu" | "lark";
	autoStart?: boolean;
	allowlist?: string[];
}
export interface TelegramFileConfig {
	botToken?: string;
	autoStart?: boolean;
	allowlist?: string[];
}
export function piImDir(): string {
	return join(homedir(), ".pi", "agent", "pi-im");
}
export async function saveJsonAtomic(
	path: string,
	obj: unknown,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0x180 });
	await rename(tmp, path);
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
	const prev = await readPiImConfig(dir);
	const next = mergeWorkspaces(prev.workspaces, cwd).slice(0, 20);
	await saveJsonAtomic(join(dir, "config.json"), { ...prev, workspaces: next });
	return next;
}

/** One session row for /sessionlist (file = absolute .jsonl path for switchSession). */
export interface SessionListItem {
	id: string;
	title?: string;
	file: string;
}

/** Encode cwd to pi sessions subdir name, e.g. `/a/b` -> `--a-b--`. */
export function encodeCwdSubdir(cwd: string): string {
	const stripped = cwd.replace(/^\//, "").replace(/\//g, "-");
	return `--${stripped}--`;
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
				if (!info || info.cwd !== cwd) continue;
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
