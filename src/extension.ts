// src/extension.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	piImDir,
	resolveFeishuCredentials,
	resolveTelegramCredentials,
	shouldAutoStart,
} from "./config.js";
import { ImController } from "./controller.js";
import { SdkFeishuGateway } from "./feishu/gateway.js";
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
export default function piImExtension(pi: ExtensionAPI): void {
	const host = globalThis as Record<string, unknown>;
	if (!host[SKEY])
		host[SKEY] = { gateways: [], started: false, release: null as unknown };
	const shared = host[SKEY] as {
		gateways: Array<{ stop(): Promise<void> }>;
		started: boolean;
		release: (() => void) | null;
	};
	pi.registerCommand("feishu", {
		description: "pi-im feishu setup|start|stop|status|config|logout|help",
		handler: async (args, ctx) => {
			ctx.ui.notify(`feishu ${args ?? ""} (V1最小实现)`, "info");
		},
	});
	pi.registerCommand("tg", {
		description: "pi-im tg setup|start|stop|status|config|logout|help",
		handler: async (args, ctx) => {
			ctx.ui.notify(`tg ${args ?? ""} (V1最小实现)`, "info");
		},
	});
	let latest: unknown;
	const track = (_e: unknown, ctx: unknown) => {
		latest = ctx;
	};
	pi.on("session_start", (event, context) => {
		track(event, context);
		void (async () => {
			if (shared.started) return;
			const dir = piImDir();
			const feishuFile = await readJson(join(dir, "feishu.json"), {});
			const tgFile = await readJson(join(dir, "telegram.json"), {});
			const bridge = new PiAgentBridge(async (prompt) => {
				pi.sendUserMessage(prompt);
			});
			void bridge;
			void latest;
			const fCred = resolveFeishuCredentials(process.env, feishuFile as never);
			if (
				fCred &&
				shouldAutoStart("feishu", process.env, feishuFile as never)
			) {
				const gw = new SdkFeishuGateway({
					appId: fCred.appId,
					appSecret: fCred.appSecret,
					domain: fCred.domain,
				});
				await gw.start().catch(() => undefined);
				const c = new ImController(gw, bridge, {
					allowlist: [],
					channelName: "feishu",
				});
				gw.onMessage((m) => void c.handleInbound(m));
				shared.gateways.push(gw);
			}
			const tCred = resolveTelegramCredentials(process.env, tgFile as never);
			if (tCred && shouldAutoStart("telegram", process.env, tgFile as never)) {
				const gw = new TelegramGateway({ botToken: tCred.botToken });
				await gw.start().catch(() => undefined);
				const c = new ImController(gw, bridge, {
					allowlist: [],
					channelName: "telegram",
				});
				gw.onMessage((m) => void c.handleInbound(m));
				shared.gateways.push(gw);
			}
			shared.started = true;
			const sid = (context as { sessionId?: string }).sessionId ?? "holder";
			shared.release?.();
			shared.release = registerPiWebLiveness(
				sid,
				() => shared.gateways.length > 0,
			);
		})().catch((e) => {
			(context.ui as { notify(msg: string, kind: string): void }).notify(
				`pi-im自启动失败:${String(e)}`,
				"error",
			);
		});
	});
	pi.on("message_end", (e, c) => {
		track(e, c);
	});
	pi.on("session_shutdown", () => {});
}
