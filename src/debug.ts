// src/debug.ts
//
// 可开关的排查日志:开了之后把关键节点写到 pi-im 目录下的 debug.log。
//
// 开关有两种,任一生效即可:
//   - 环境变量 `PI_IM_DEBUG=1`(需要在启动 pi / pi-web 时就带上)
//   - pi-im 目录下的 `debug.on` 文件(`touch ~/.pi/agent/pi-im/debug.on`)
// 后者是给「进程已经跑起来才发现要查」的场景准备的:每次写日志都会看一次文件,
// 建了就开始记,删了就立刻停,不用重启。
//
// 为什么需要它:IM 的链路是「消息进来 — 谁也不看的过程 — 回答出去」,断在哪一步
// 在聊天里完全看不出来(消息没被当答案消化时,既没有报错也不会回话)。pi-web 的
// 日志只落在它自己的终端里,人不在电脑前就拿不到证据。一个默认静默、按需打开的
// 文件日志是唯一能远程取证的东西。
//
// 约束:默认必须完全静默(不建文件、不占 IO),写日志本身绝不能抛错影响正事。

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { piImDir } from "./config.js";

/** 超过这个大小就把旧日志清掉:调试日志只需要覆盖最近一次现场。 */
const MAX_BYTES = 1_000_000;
/** 单条日志里字符串字段的上限,避免把整段聊天记录抄进去。 */
const MAX_VALUE_CHARS = 400;
/** 只要这个文件存在就记日志:比改环境变量少一次重启。 */
export const DEBUG_MARKER = "debug.on";

let sizeChecked = false;

export function imDebugEnabled(): boolean {
	const value = process.env.PI_IM_DEBUG?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes") return true;
	// 进程已经在跑了才想起来要查的时候,改环境变量要重启;放个文件就不用。
	try {
		return existsSync(join(piImDir(), DEBUG_MARKER));
	} catch {
		return false;
	}
}

function render(value: unknown): string {
	if (typeof value === "string") {
		return value.length > MAX_VALUE_CHARS
			? `${value.slice(0, MAX_VALUE_CHARS)}…(${value.length})`
			: value;
	}
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

export function imDebug(...parts: unknown[]): void {
	if (!imDebugEnabled()) return;
	try {
		const dir = piImDir();
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "debug.log");
		if (!sizeChecked) {
			sizeChecked = true;
			try {
				if (statSync(path).size > MAX_BYTES) writeFileSync(path, "");
			} catch {
				// 文件还不存在,第一次 append 会建。
			}
		}
		// 本地时间:排查时是拿它去对飞书里的消息时间,UTC 会多一道心算。
		const stamp = new Date().toLocaleString("sv-SE");
		const line = parts.map(render).join(" ");
		appendFileSync(path, `${stamp} ${line}\n`);
	} catch {
		// 日志永远不该影响正事。
	}
}

/** 只给测试用:让下一次写入重新检查文件大小。 */
export function resetDebugForTests(): void {
	sizeChecked = false;
}
