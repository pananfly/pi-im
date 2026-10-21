// src/feishu/slash-commands.ts — register pi-im's commands in Feishu's "/" panel.
//
// The panel is server-side state per bot application. The client fetches it
// when you type "/", and nothing in the Feishu developer console configures
// it, so an integration that wants a command panel has to register its names
// itself. That is why dsh-im has this and pi-im did not: pi-im never made the
// call. The permissions were already in place.
//
// Registering is a pure client-side convenience. Tapping an entry sends the bot
// an ordinary text message through im.message.receive_v1, which the IM
// controller already matches — so no command handling changes here, and a
// manifest name that the controller does not answer would be a lie. A test
// checks the manifest against remote-commands.KNOWN.

/** Feishu OpenAPI. v7 is the only one that exposes the slash panel. */
const SLASH_ENDPOINT = "/open-apis/application/v7/app_slash_commands";
const TOKEN_ENDPOINT = "/open-apis/auth/v3/tenant_access_token/internal";

/** Feishu's own "agent" icon; used when an entry does not pick one. */
const DEFAULT_ICON = "ai-agent_outlined";

/** 99991672 = scope missing, 99991640 = app state. Both mean "stop asking". */
const FATAL_CODES = new Set(["99991640", "99991672"]);

function origin(domain: "feishu" | "lark"): string {
	return domain === "lark"
		? "https://open.larksuite.com"
		: "https://open.feishu.cn";
}

export interface SlashCommandEntry {
	/** Registered WITHOUT a leading slash; Feishu renders and sends "/x". */
	command: string;
	default: string;
	en_us: string;
	icon?: string;
}

/**
 * Every KNOWN command except the aliases (/ws, /sessions, /reasoning): a panel
 * entry is a fixed command name, so listing an alias would show the user two
 * rows that do the same thing. Tests assert this list stays in step with
 * KNOWN — add a command there and this fails until you describe it here.
 */
export const PI_IM_SLASH_MANIFEST: readonly SlashCommandEntry[] = [
	{
		command: "help",
		default: "查看帮助",
		en_us: "Show help",
		icon: "promptword_outlined",
	},
	{
		command: "status",
		default: "查看机器人状态",
		en_us: "Show bot status",
		icon: "ai-functions_outlined",
	},
	{
		command: "version",
		default: "查看 pi-im 版本",
		en_us: "Show pi-im version",
	},
	{
		command: "new",
		default: "开启全新会话",
		en_us: "Start a fresh session",
		icon: "ai-deepthink_outlined",
	},
	{
		command: "stop",
		default: "停止当前任务",
		en_us: "Stop the running task",
		icon: "clear_outlined",
	},
	{
		command: "steer",
		default: "向当前任务追加指令",
		en_us: "Steer the running task",
	},
	{
		command: "compact",
		default: "压缩会话上下文",
		en_us: "Compact the session context",
		icon: "ai-block_outlined",
	},
	{
		command: "history",
		default: "查看最近历史消息",
		en_us: "Show recent history",
		icon: "chat-ai_outlined",
	},
	{
		command: "models",
		default: "列出可用模型",
		en_us: "List available models",
		icon: "ai-functions_outlined",
	},
	{
		command: "model",
		default: "查看或切换模型",
		en_us: "Show or switch model",
	},
	{
		command: "thinking",
		default: "查看或切换思考档位",
		en_us: "Show or switch thinking level",
		icon: "ai-deepthink_outlined",
	},
	{
		command: "workspace",
		default: "切换工作区",
		en_us: "Switch workspace",
		icon: "folder_outlined",
	},
	{
		command: "wsl",
		default: "列出工作区",
		en_us: "List workspaces",
		icon: "folder_outlined",
	},
	{
		command: "sessionlist",
		default: "列出会话",
		en_us: "List sessions",
		icon: "chat-ai_outlined",
	},
	{
		command: "session",
		default: "绑定已有会话",
		en_us: "Bind an existing session",
		icon: "chat-ai_outlined",
	},
	{ command: "batch", default: "开启批量输入", en_us: "Start batch input" },
	{ command: "send", default: "提交批量输入", en_us: "Send batch input" },
	{
		command: "cancel",
		default: "取消批量输入",
		en_us: "Cancel batch input",
		icon: "clear_outlined",
	},
	{
		command: "repair",
		default: "修复提示信息",
		en_us: "Repair prompt context",
	},
	{
		command: "clear",
		default: "清空会话上下文",
		en_us: "Clear the session context",
		icon: "clear_outlined",
	},
	// No icon: DEFAULT_ICON is a value already in use, and an invented icon_key
	// risks rendering the whole panel entry as a failure. Not worth an icon.
	{
		command: "feishu",
		default: "查看或切换进度展示(纯文本/卡片)",
		en_us: "Show or switch progress display (text/card)",
	},
];

export interface SlashSyncReport {
	created: string[];
	/** Registered names that this manifest does not own. Never touched. */
	external: string[];
	failed: Array<{ command: string; error: string }>;
}

/**
 * The two Feishu reply shapes, which are NOT the same and both are verified
 * against the live API: the token endpoint returns tenant_access_token at the
 * top level, while every other endpoint nests its payload under `data`.
 */
interface TokenReply {
	code: number;
	msg?: string;
	tenant_access_token?: string;
}

interface DataReply {
	code: number;
	msg?: string;
	data?: { command_id?: string; items?: Array<{ command?: string }> };
}

/**
 * Talk to Feishu directly rather than through the Lark SDK: the panel API is
 * not part of that SDK's surface, and its client would only add a dependency
 * on the credential plumbing we already have here.
 */
async function post(
	url: string,
	token: string | null,
	body: unknown,
): Promise<DataReply> {
	const res = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"content-type": "application/json; charset=utf-8",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(15000),
	});
	return (await res.json()) as DataReply;
}

async function fetchToken(url: string, body: unknown): Promise<TokenReply> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15000),
	});
	return (await res.json()) as TokenReply;
}

/**
 * Bring the panel in line with the manifest, creating whatever is missing.
 *
 * Create-only by design: a panel entry costs nothing to leave alone, whereas
 * deleting one that someone registered by hand destroys work we cannot restore.
 * Registering is idempotent, so running this on every start is just one read
 * plus the creates a code change actually earned.
 *
 * Order is NOT controlled. Feishu returns the panel in creation order at
 * one-second precision, so a chosen order would mean recreating every command
 * one per second — 20+ seconds of startup to move rows around. Not worth it;
 * the panel is sorted by Feishu and the names are what matter.
 *
 * Never throws: the panel is a convenience, and failing to register it must not
 * stop the gateway from coming up.
 */
export async function syncSlashCommands(opts: {
	appId?: string;
	appSecret?: string;
	domain?: "feishu" | "lark";
	manifest?: readonly SlashCommandEntry[];
}): Promise<SlashSyncReport> {
	const report: SlashSyncReport = { created: [], external: [], failed: [] };
	const { appId, appSecret } = opts;
	if (!appId || !appSecret) return report;

	const domain = opts.domain ?? "feishu";
	const manifest = opts.manifest ?? PI_IM_SLASH_MANIFEST;

	try {
		const tokenReply = await fetchToken(`${origin(domain)}${TOKEN_ENDPOINT}`, {
			app_id: appId,
			app_secret: appSecret,
		});
		// Top level, not data.tenant_access_token — the token endpoint is the one
		// that does not nest its payload; verified against the live API.
		const token = tokenReply.tenant_access_token;
		if (tokenReply.code !== 0 || !token) {
			report.failed.push({
				command: "-",
				error: `auth failed: ${tokenReply.msg ?? `code ${tokenReply.code}`}`,
			});
			return report;
		}

		const url = `${origin(domain)}${SLASH_ENDPOINT}`;
		const listReply = await post(url, token, undefined);
		if (listReply.code !== 0) {
			report.failed.push({
				command: "-",
				error: `list failed: ${listReply.msg ?? `code ${listReply.code}`}`,
			});
			return report;
		}

		const items = listReply.data?.items ?? [];
		const registered = new Set(
			items.map((i) => i.command).filter((c): c is string => Boolean(c)),
		);
		const owned = new Set(manifest.map((e) => e.command));
		report.external = [...registered].filter((c) => !owned.has(c));

		for (const entry of manifest) {
			if (registered.has(entry.command)) continue;
			try {
				const created = await post(url, token, {
					command: entry.command,
					description: {
						default_value: entry.default,
						i18n: { zh_cn: entry.default, en_us: entry.en_us },
						icon: { icon_key: entry.icon ?? DEFAULT_ICON },
					},
				});
				if (created.code === 0 && created.data?.command_id) {
					report.created.push(entry.command);
					registered.add(entry.command);
					continue;
				}
				const msg = created.msg ?? `code ${created.code}`;
				// Another process registered it between our read and this write.
				if (/already exists/i.test(msg)) {
					registered.add(entry.command);
					continue;
				}
				report.failed.push({ command: entry.command, error: msg });
				// A missing scope fails identically for all 20 names; stop
				// instead of asking 20 more times for the same rejection.
				if (
					FATAL_CODES.has(String(created.code)) ||
					/lacks permission|access denied/i.test(msg)
				) {
					break;
				}
			} catch (e) {
				report.failed.push({
					command: entry.command,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
	} catch (e) {
		report.failed.push({
			command: "-",
			error: e instanceof Error ? e.message : String(e),
		});
	}

	if (report.failed.length > 0) {
		console.error(
			`[pi-im] 飞书快捷指令同步未完全成功: ${report.failed
				.map((f) => `${f.command}=${f.error}`)
				.join("; ")}`,
		);
	}
	return report;
}
