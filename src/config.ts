import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export type ChannelKind = "feishu" | "telegram";
export interface PiImFileConfig { workspaces?: string[]; holderSessionId?: string; holderCwd?: string; }
export interface FeishuFileConfig { appId?: string; appSecret?: string; domain?: "feishu" | "lark"; autoStart?: boolean; allowlist?: string[]; }
export interface TelegramFileConfig { botToken?: string; autoStart?: boolean; allowlist?: string[]; }
export function piImDir(): string { return join(homedir(), ".pi", "agent", "pi-im"); }
export async function saveJsonAtomic(path: string, obj: unknown): Promise<void> {
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
export function shouldAutoStart(kind: ChannelKind, env: NodeJS.ProcessEnv, file: { autoStart?: boolean }): boolean {
  void kind;
  const envFlag = isTruthyEnv(env.PI_IM_AUTO_START);
  if (envFlag !== undefined) return envFlag;
  return file.autoStart ?? true;
}
export function resolveFeishuCredentials(env: NodeJS.ProcessEnv, file: FeishuFileConfig): { appId: string; appSecret: string; domain: "feishu" | "lark" } | null {
  const appId = env.FEISHU_APP_ID ?? file.appId;
  const appSecret = env.FEISHU_APP_SECRET ?? file.appSecret;
  if (!appId || !appSecret) return null;
  return { appId, appSecret, domain: file.domain ?? "feishu" };
}
export function resolveTelegramCredentials(env: NodeJS.ProcessEnv, file: TelegramFileConfig): { botToken: string } | null {
  const botToken = env.TELEGRAM_BOT_TOKEN ?? file.botToken;
  if (!botToken) return null;
  return { botToken };
}
