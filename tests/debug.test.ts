// tests/debug.test.ts
//
// PI_IM_DEBUG 是唯一能远程取证的手段,所以它的两条硬约束都要钉住:
// 默认一个字节都不写,打开后写在 pi-im 目录、且自己绝不抛错。

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEBUG_MARKER,
	imDebug,
	imDebugEnabled,
	resetDebugForTests,
} from "../src/debug.js";

let dir: string;
const env = { ...process.env };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-im-debug-"));
	process.env.PI_IM_DIR = join(dir, "pi-im");
	resetDebugForTests();
});

afterEach(() => {
	process.env = { ...env };
	rmSync(dir, { recursive: true, force: true });
});

const logPath = () => join(dir, "pi-im", "debug.log");
const read = () => readFileSync(logPath(), "utf8");

describe("imDebug", () => {
	it("stays completely silent by default", () => {
		delete process.env.PI_IM_DEBUG;
		expect(imDebugEnabled()).toBe(false);
		imDebug("inbound", "feishu", "oc_1", "你好");
		expect(() => read()).toThrow();
	});

	it("accepts the documented truthy spellings", () => {
		for (const value of ["1", "true", "yes", " TRUE "]) {
			process.env.PI_IM_DEBUG = value;
			expect(imDebugEnabled()).toBe(true);
		}
		for (const value of ["", "0", "off", "false"]) {
			process.env.PI_IM_DEBUG = value;
			expect(imDebugEnabled()).toBe(false);
		}
	});

	it("turns on from the debug.on marker without restarting the process", () => {
		delete process.env.PI_IM_DEBUG;
		expect(imDebugEnabled()).toBe(false);
		const marker = join(dir, "pi-im", DEBUG_MARKER);
		mkdirSync(join(dir, "pi-im"), { recursive: true });
		writeFileSync(marker, "");
		expect(imDebugEnabled()).toBe(true);
		imDebug("bridge:boot", "ab12cd");
		expect(read()).toContain("bridge:boot ab12cd");
		// 删掉文件就该立刻停下来,不必等下一次重启。
		rmSync(marker);
		expect(imDebugEnabled()).toBe(false);
	});

	it("writes one line per call into the pi-im directory", () => {
		process.env.PI_IM_DEBUG = "1";
		imDebug("inbound", "feishu", "oc_1", "技术栈选哪个?");
		imDebug("answer", "ab12cd", "feishu:oc_1", "select", "2");
		const lines = read().trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("inbound feishu oc_1 技术栈选哪个?");
		expect(lines[1]).toContain("answer ab12cd feishu:oc_1 select 2");
		// 本地时间戳,便于对着聊天记录看。
		expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
	});

	it("truncates long values instead of dumping a whole chat", () => {
		process.env.PI_IM_DEBUG = "1";
		imDebug("inbound", "x".repeat(1000));
		const line = read().trim();
		expect(line).toContain("…(1000)");
		expect(line.length).toBeLessThan(600);
	});

	it("serializes objects and survives circular ones", () => {
		process.env.PI_IM_DEBUG = "1";
		const circular: Record<string, unknown> = { reason: "dm_disabled" };
		circular.self = circular;
		imDebug("feishu:reject", { reason: "no_mention" });
		expect(() => imDebug("feishu:unparsed", circular)).not.toThrow();
		const lines = read().trim().split("\n");
		expect(lines[0]).toContain('{"reason":"no_mention"}');
		// 循环结构退化成 String(value),仍然留下痕迹。
		expect(lines[1]).toContain("feishu:unparsed");
	});

	it("restarts the file once it grows past the cap", () => {
		process.env.PI_IM_DEBUG = "1";
		const file = logPath();
		// 第一次写入会建目录,之后手工灌到超过上限。
		imDebug("seed", "1");
		writeFileSync(file, "x".repeat(1_000_001));
		// resetDebugForTests 让下一次写入重新检查大小。
		resetDebugForTests();
		imDebug("after-rotation", "ok");
		const text = read();
		expect(text).not.toContain("xxxxxxxxxx");
		expect(text).toContain("after-rotation ok");
	});

	it("never throws, even when the directory cannot be created", () => {
		process.env.PI_IM_DEBUG = "1";
		// 让 pi-im 目录的父级是一个文件,递归建目录必然失败。
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a dir");
		process.env.PI_IM_DIR = join(blocker, "pi-im");
		expect(() => imDebug("inbound", "still fine")).not.toThrow();
	});
});
