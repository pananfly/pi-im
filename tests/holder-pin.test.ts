// tests/holder-pin.test.ts
//
// Regression cover for "switching workspace in pi-web moved the IM task".
//
// pi-web mints a new wrapper (and re-runs every extension factory) whenever the
// browser opens another session. A session_start handler that unconditionally
// re-claims the command context and re-registers liveness therefore hands the
// IM channel to whatever the browser just opened. The holder must instead stay
// pinned to the session pi-im chose; only an IM-issued switch, an explicit TUI
// command, or a real replacement of that session may move it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
	listPiWebWorkspacesSync,
	piImDir,
	recordHolder,
} from "../src/config.js";
import { ImController } from "../src/controller.js";
import piImExtension, { attachRuntime, getBridge } from "../src/extension.js";
import { livenessKey } from "../src/liveness.js";
import { __resetCurrentPiForTests } from "../src/pi-ref.js";

/** Fixture workspaces live under tmpdir(): the suite must not assume a POSIX
 *  /tmp (Windows has no such path) and must never point at a real project. */
const WS_A = join(tmpdir(), "pi-im-ws-a");
const WS_B = join(tmpdir(), "pi-im-ws-b");

interface FakeSession {
	file: string;
	cwd: string;
	api: ExtensionAPI;
	handlers: Map<string, (e: unknown, c: unknown) => unknown>;
	sent: string[];
	ctx: Record<string, unknown>;
}

interface Harness {
	open(file: string, cwd: string): FakeSession;
	start(session: FakeSession, reason?: string): Promise<void>;
	sessions: FakeSession[];
}

function idFor(file: string): string {
	return `id-${file.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

/** A session's command context. pi-web never invokes withSession; the new
 *  wrapper's session_start is the real landing signal. */
function commandCtx(h: () => Harness, file: string, cwd: string) {
	const bridge: Harness = h();
	return {
		cwd,
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => file,
			getSessionId: () => idFor(file),
		},
		ui: { notify: () => {} },
		async newSession() {
			const created = bridge.open(`${cwd}/new.jsonl`, cwd);
			await bridge.start(created);
			return { cancelled: false };
		},
		async switchSession(target: string) {
			// pi-web's implementation: open the target file in a NEW wrapper, do
			// not call withSession, leave the old wrapper running.
			const created = bridge.open(target, cwdOfTarget(target));
			await bridge.start(created);
			return { cancelled: false };
		},
		async fork() {
			return { cancelled: false };
		},
		async navigateTree() {
			return { cancelled: false };
		},
		async reload() {},
		async waitForIdle() {},
	};
}

/** The cwd recorded in a session file's first line. */
function cwdOfTarget(file: string): string {
	try {
		const first = readFileSync(file, "utf8").split("\n")[0] ?? "";
		const cwd = (JSON.parse(first) as { cwd?: unknown }).cwd;
		return typeof cwd === "string" ? cwd : join(tmpdir(), "unknown");
	} catch {
		return join(tmpdir(), "unknown");
	}
}

let harnessRef: Harness | null = null;

function makeSession(file: string, cwd: string): FakeSession {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const commands = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const sent: string[] = [];
	const ctx = {
		cwd,
		scopedModels: [],
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => file,
			getSessionId: () => idFor(file),
		},
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
		abort: () => {},
		compact: () => {},
		ui: { notify: () => {} },
	};
	const api = {
		on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, h);
		},
		registerCommand: (
			name: string,
			o: { handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands.set(name, o.handler);
		},
		sendUserMessage: (
			content: string,
			options?: { expandPromptTemplates?: boolean },
		) => {
			if (typeof content === "string" && content.startsWith("/")) {
				const name = content.slice(1).split(/\s+/)[0] as string;
				const handler = commands.get(name);
				if (handler && options?.expandPromptTemplates) {
					void handler(
						"",
						commandCtx(() => harnessRef as Harness, file, cwd),
					);
				} else {
					sent.push(content);
				}
				return;
			}
			sent.push(content);
		},
		sendMessage: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	return { file, cwd, api, handlers, sent, ctx };
}

function makeHarness(): Harness {
	const sessions: FakeSession[] = [];
	const harness: Harness = {
		sessions,
		open(file, cwd) {
			const session = makeSession(file, cwd);
			sessions.push(session);
			piImExtension(session.api);
			return session;
		},
		async start(session, reason = "startup") {
			await session.handlers.get("session_start")?.(
				{ type: "session_start", reason },
				session.ctx,
			);
		},
	};
	harnessRef = harness;
	return harness;
}

function makeController() {
	const out: string[] = [];
	const c = new ImController(
		{
			async sendText(_chat: string, text: string) {
				out.push(text);
				return "m1";
			},
			async editText(_chat: string, _id: string, text: string) {
				out.push(text);
			},
		} as never,
		getBridge(),
		{ allowlist: ["u1"], channelName: "telegram" },
	);
	attachRuntime(c);
	return { c, out };
}

function makeWorkspaceSession(agentDir: string, cwd: string): string {
	const encoded = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
	const bucket = join(agentDir, "sessions", encoded);
	mkdirSync(bucket, { recursive: true });
	// pi's layout: <ISO timestamp>_<uuid>.jsonl, so listWorkspaceSessionsSync's
	// directory-scan fallback resolves the id.
	const file = join(
		bucket,
		"2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl",
	);
	writeFileSync(
		file,
		`${JSON.stringify({
			cwd,
			sessionId: "11111111-2222-3333-4444-555555555555",
		})}\n`,
	);
	return file;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piImShared__;
	__resetCurrentPiForTests();
	harnessRef = null;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(
		join(tmpdir(), "pi-im-holder-agent-"),
	);
	// The liveness stub mimics pi-web: one provider per name, replaced on register.
	const providers: Array<{
		name: string;
		sessionId: string;
		sessionFile?: string;
	}> = [];
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for(livenessKey())] = {
		version: 1,
		register: (p: (typeof providers)[number]) => {
			providers.push(p);
			return () => {
				const at = providers.indexOf(p);
				if (at >= 0) providers.splice(at, 1);
			};
		},
	};
});

describe("holder pinning", () => {
	it("does not move to a session pi-web opens in another workspace", async () => {
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);

		const { c } = makeController();
		expect(c.runtime?.cwd?.()).toBe(WS_A);

		// The browser switches workspace: pi-web starts a brand-new wrapper.
		const b = h.open(join(WS_B, "s.jsonl"), WS_B);
		await h.start(b);

		expect(c.runtime?.cwd?.()).toBe(WS_A);
		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));

		// The IM message must land in A, not in the newest factory's session.
		const run = c.handleInbound({
			messageId: "m1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "only for A",
			timestampMs: Date.now(),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(a.sent).toEqual(["only for A"]);
		expect(b.sent).toEqual([]);
		await a.handlers.get("agent_settled")?.({}, a.ctx);
		await run;
	});

	it("does not hand the holder to another session in the same workspace", async () => {
		// 2026-10-21 的真实事故:holder 是 01a159ff,浏览器把同工作区的另一个会话
		// 01a12882 恢复起来,matchesSeed 退回比较 cwd 就判定"是 holder 回来了",
		// 于是以 restored 身份覆盖 —— 会话被换掉,IM 还在"继续之前的提问"里。
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c } = makeController();
		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));

		// 同目录、不同会话文件:浏览器恢复的另一个 tab。
		const sibling = h.open(join(WS_A, "other.jsonl"), WS_A);
		await h.start(sibling);

		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));

		const run = c.handleInbound({
			messageId: "m1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "still A",
			timestampMs: Date.now(),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(a.sent).toEqual(["still A"]);
		expect(sibling.sent).toEqual([]);
		await a.handlers.get("agent_settled")?.({}, a.ctx);
		await run;
	});

	it("waits for a running turn before restoring the recorded holder", async () => {
		// 重启后浏览器先打开的可能是别的会话,于是临时 holder 落到它身上,真正记录
		// 下来的会话稍后才冒出来。这种"恢复"必须等当前这一轮答完,否则那一轮的
		// settle/tool 事件就认不回自己的会话了。
		const h = makeHarness();
		const seedFile = join(WS_A, "recorded.jsonl");
		await recordHolder(piImDir(), {
			sessionFile: seedFile,
			sessionId: idFor(seedFile),
			cwd: WS_A,
		});
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c } = makeController();
		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));

		const run = c.handleInbound({
			messageId: "m1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "go",
			timestampMs: Date.now(),
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(a.sent).toEqual(["go"]);

		// 记录的会话出现了,但这一轮还在跑:按兵不动。
		const recorded = h.open(seedFile, WS_A);
		await h.start(recorded);
		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));

		a.handlers.get("agent_settled")?.({}, a.ctx);
		await run;

		// 空闲之后,同一个事件就能把 pin 收回到记录的会话上。
		await h.start(recorded);
		expect(c.runtime?.sessionFile?.()).toBe(seedFile);
	});

	/** 把内存里的 holder 造成"被旧版本抢过"的样子:记录是 R,holder 却是别人。 */
	function poisonHolder(source: "restored" | "explicit", seedFile: string) {
		const shared = (
			globalThis as unknown as {
				__piImShared__: Record<string, unknown>;
			}
		).__piImShared__;
		shared.holderSeed = {
			sessionFile: seedFile,
			sessionId: idFor(seedFile),
			cwd: WS_A,
		};
		shared.holderSource = source;
	}

	it("lets the recorded session take back a holder it never chose", async () => {
		// 旧版本可能把 holder 判给了同一工作区的另一个 tab(2026-10-21 06:38:48)。
		// 记录里的会话再次出现时,应当把 pin 收回来 —— 不必等重启。
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c } = makeController();

		const seedFile = join(WS_A, "recorded.jsonl");
		poisonHolder("restored", seedFile);
		const recorded = h.open(seedFile, WS_A);
		await h.start(recorded);

		expect(c.runtime?.sessionFile?.()).toBe(seedFile);
	});

	it("never lets the recorded session undo a deliberate switch", async () => {
		// auto / restored 只是临时顶班;用户明确选过的会话(explicit)不许被兜底
		// 逻辑改回去,否则 /wsl、/new 就白切了。
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c } = makeController();

		const seedFile = join(WS_A, "recorded.jsonl");
		poisonHolder("explicit", seedFile);
		const recorded = h.open(seedFile, WS_A);
		await h.start(recorded);

		expect(c.runtime?.sessionFile?.()).toBe(join(WS_A, "s.jsonl"));
	});

	it("ignores another session's tools, text and settle while a run is active", async () => {
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c, out } = makeController();

		const run = c.handleInbound({
			messageId: "m1",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "go",
			timestampMs: Date.now(),
		});
		await new Promise((r) => setTimeout(r, 20));

		const b = h.open(join(WS_B, "s.jsonl"), WS_B);
		await h.start(b);
		b.handlers.get("message_update")?.(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "B-SECRET" }],
				},
			},
			b.ctx,
		);
		b.handlers.get("agent_settled")?.({}, b.ctx); // must not end A's turn

		a.handlers.get("message_end")?.(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "A-ANSWER" }],
				},
			},
			a.ctx,
		);
		a.handlers.get("agent_settled")?.({}, a.ctx);
		await run;

		const text = out.join("\n");
		expect(text).toContain("A-ANSWER");
		expect(text).not.toContain("B-SECRET");
	});

	it("moves when IM asks for another workspace (pi-web wrapper)", async () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR as string;
		const targetCwd = mkdtempSync(join(tmpdir(), "pi-im-target-"));
		const target = makeWorkspaceSession(agentDir, targetCwd);
		const h = makeHarness();
		const a = h.open(join(WS_A, "s.jsonl"), WS_A);
		await h.start(a);
		const { c } = makeController();

		const reply = await c.runtime?.switchWorkspace?.(targetCwd);
		expect(reply).toContain(targetCwd);
		expect(c.runtime?.cwd?.()).toBe(targetCwd);
		expect(c.runtime?.sessionFile?.()).toBe(target);

		const run = c.handleInbound({
			messageId: "m2",
			chatId: "c1",
			chatType: "p2p",
			senderId: "u1",
			text: "new place",
			timestampMs: Date.now(),
		});
		await new Promise((r) => setTimeout(r, 20));
		const moved = h.sessions.find((s) => s.file === target);
		expect(moved?.sent).toEqual(["new place"]);
		expect(a.sent).toEqual([]);
		await moved?.handlers.get("agent_settled")?.({}, moved.ctx);
		await run;
	});

	it("restores a persisted holder only when its identity shows up", async () => {
		const dir = process.env.PI_IM_DIR as string;
		const holderFile = join(WS_A, "persisted.jsonl");
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				holderCwd: WS_A,
				holderSessionId: idFor(holderFile),
				holderSessionFile: holderFile,
			}),
		);

		const h = makeHarness();
		// A browser-opened session in another workspace is a provisional holder:
		// IM must be usable immediately after a restart.
		const b = h.open(join(WS_B, "s.jsonl"), WS_B);
		await h.start(b);
		const { c } = makeController();
		expect(c.runtime?.cwd?.()).toBe(WS_B);

		// Once the recorded holder starts (warmup resumes it), it takes over.
		const a = h.open(holderFile, WS_A);
		await h.start(a);
		expect(c.runtime?.cwd?.()).toBe(WS_A);
		expect(c.runtime?.sessionFile?.()).toBe(holderFile);
	});
});

describe("workspace discovery", () => {
	it("lists cwds straight from pi-web's session index", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-ws-index-"));
		const older = mkdtempSync(join(tmpdir(), "pi-im-ws-old-"));
		const newer = mkdtempSync(join(tmpdir(), "pi-im-ws-new-"));
		writeFileSync(
			join(dir, "pi-web-session-index.json"),
			JSON.stringify({
				version: 1,
				entries: {
					a: {
						info: {
							path: "/x/a.jsonl",
							id: "a",
							cwd: older,
							modified: "2026-01-01T00:00:00.000Z",
						},
					},
					b: {
						info: {
							path: "/x/b.jsonl",
							id: "b",
							cwd: newer,
							modified: "2026-02-01T00:00:00.000Z",
						},
					},
					gone: {
						info: {
							path: "/x/gone.jsonl",
							id: "g",
							cwd: "/definitely/not/here",
							modified: "2026-03-01T00:00:00.000Z",
						},
					},
				},
			}),
		);
		expect(listPiWebWorkspacesSync(dir)).toEqual([newer, older]);
	});
});
