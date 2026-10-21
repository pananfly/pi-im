// tests/im-owner.test.ts
//
// Why this exists: IM is a per-machine resource, not a per-window one. A TUI and
// pi-web both load this extension in separate processes, and until now nothing
// arbitrated between them, so both ran `autostartBots()`: two Telegram
// long-polls (the loser gets 409, backs off, retries, and each one keeps
// stealing the other's updates) and two Feishu websockets. Worse, the second
// process happily adopted any session its host opened, so a click in the
// browser dragged the IM task along even though IM was following the terminal.
//
// owner.json now names the single process allowed to serve IM: a TUI outranks
// pi-web, a live owner is never evicted, and a process without the lock neither
// starts a gateway nor adopts a session. Captured here because the symptom
// (messages silently answered in the wrong session) looks like a routing bug
// somewhere else entirely.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piImDir } from "../src/config.js";
import piImExtension from "../src/extension.js";
import { __resetCurrentPiForTests } from "../src/pi-ref.js";

interface Shared {
	ownerMode: string | null;
	owner: { owned: boolean; stop: () => void } | null;
	holderFile: string | null;
	holderSessionId: string | null;
	holderAdopted: boolean;
	holderSource: "auto" | "explicit" | "restored";
	cmdCtx: unknown;
	tg: { gateway: unknown };
	feishu: { gateway: unknown };
}

/** The state object the extension keeps on globalThis, so a test can look at
 *  what it decided instead of inferring it from a chat reply. */
function shared(): Shared {
	return (globalThis as unknown as { __piImShared__: Shared }).__piImShared__;
}

interface FakeSession {
	file: string;
	cwd: string;
	api: ExtensionAPI;
	handlers: Map<string, (e: unknown, c: unknown) => unknown>;
	commands: Map<string, (a: string, c: unknown) => Promise<void>>;
	sent: string[];
	ctx: Record<string, unknown>;
}

/**
 * A session wrapper, as the host builds it. `mode` is only passed when the test
 * wants to model a host that reports it: pi exposes the mode on the
 * session_start context ("tui" in a terminal, "rpc" under pi-web), and a host
 * that never reports one must keep the old single-process behaviour.
 */
function makeSession(file: string, cwd: string, mode?: string): FakeSession {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const commands = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const sent: string[] = [];
	const dispatch = (payload: string, target = file) => {
		const space = payload.indexOf(" ");
		const name = space === -1 ? payload.slice(1) : payload.slice(1, space);
		void commands.get(name)?.("", {
			cwd,
			isIdle: () => true,
			sessionManager: { getSessionFile: () => target },
			ui: { notify: () => {} },
			async switchSession() {
				return { cancelled: false };
			},
			async newSession() {
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
		});
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
		registerShortcut: () => {},
		registerFlag: () => {},
		sendUserMessage: (
			content: string,
			options?: { expandPromptTemplates?: boolean },
		) => {
			if (typeof content === "string" && content.startsWith("/")) {
				// Only an expanded payload becomes a command with a command-capable
				// context; anything else would be an ordinary user message.
				if (options?.expandPromptTemplates) dispatch(content);
				else sent.push(content);
				return;
			}
			sent.push(content);
		},
		sendMessage: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx: Record<string, unknown> = {
		cwd,
		scopedModels: [],
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => file,
			getSessionId: () => "id-1",
		},
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
		abort: () => {},
		compact: () => {},
		ui: { notify: () => {} },
	};
	if (mode !== undefined) ctx.mode = mode;
	return { file, cwd, api, handlers, commands, sent, ctx };
}

/** Load the extension into a fresh process image, as the host does per session. */
function boot(session: FakeSession): FakeSession {
	piImExtension(session.api);
	return session;
}

async function start(session: FakeSession, reason = "startup"): Promise<void> {
	await session.handlers.get("session_start")?.(
		{ type: "session_start", reason },
		session.ctx,
	);
	await new Promise((r) => setTimeout(r, 10));
}

/** Poll for a decision the heartbeat timer has to make on its own. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not met in time");
}

let dir: string;
let cwd: string;

/** A session file pi would report: first line carries cwd and id. */
function sessionFile(name: string): string {
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ cwd, sessionId: `id-${name}` })}\n`);
	return file;
}

/** Write an owner record the way a running process leaves it behind. */
function claimOwnerFile(mode: string, heartbeatAgo: number): void {
	writeFileSync(
		join(piImDir(), "owner.json"),
		JSON.stringify({
			pid: 999999,
			mode,
			startedAt: Date.now(),
			heartbeatAt: Date.now() - heartbeatAgo,
		}),
	);
}

function ownerFilePid(): number {
	return (
		JSON.parse(readFileSync(join(piImDir(), "owner.json"), "utf8")) as {
			pid: number;
		}
	).pid;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piImShared__;
	__resetCurrentPiForTests();
	dir = mkdtempSync(join(tmpdir(), "pi-im-owner-ext-"));
	cwd = join(dir, "proj");
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	// Each claimed lock holds a heartbeat timer; stop it so a test's decision
	// cannot keep writing into a later test's directory.
	shared().owner?.stop();
});

describe("cross-process IM ownership", () => {
	it("keeps the old behaviour when the host does not report a mode", async () => {
		const file = sessionFile("a");
		const pi = boot(makeSession(file, cwd));
		await start(pi, "startup");

		// No mode means no arbitration at all: no claim, no lock file, and the
		// session_start adoption still happens exactly as before.
		expect(shared().ownerMode).toBeNull();
		expect(shared().owner).toBeNull();
		expect(existsSync(join(piImDir(), "owner.json"))).toBe(false);
		expect(shared().holderFile).toBe(file);
		expect(shared().holderSource).toBe("auto");
		expect(shared().cmdCtx).not.toBeNull();
	});

	it("claims IM for a TUI and adopts its session right away", async () => {
		const file = sessionFile("tui");
		const pi = boot(makeSession(file, cwd, "tui"));
		await start(pi, "startup");

		expect(shared().ownerMode).toBe("tui");
		expect(shared().owner?.owned).toBe(true);
		expect(ownerFilePid()).toBe(process.pid);
		expect(shared().holderFile).toBe(file);
	});

	it("never lets pi-web adopt a session while a live TUI owns IM", async () => {
		// A live owner: a TUI whose heartbeat is fresh. Liveness is decided by the
		// heartbeat, not by signalling the pid, so this is a faithful stand-in.
		claimOwnerFile("tui", 0);

		const first = sessionFile("web-1");
		const pi = boot(makeSession(first, cwd, "rpc"));
		await start(pi, "startup");

		expect(shared().ownerMode).toBe("rpc");
		expect(shared().owner?.owned).toBe(false);
		expect(shared().holderFile).toBeNull();
		expect(shared().holderAdopted).toBe(false);

		// Browser clicks open (and re-run the factory for) other sessions. Each one
		// is another session_start for a session IM must not follow.
		const second = sessionFile("web-2");
		const other = boot(makeSession(second, cwd, "rpc"));
		await start(other, "new");

		expect(shared().holderFile).toBeNull();
		expect(shared().holderAdopted).toBe(false);

		// And it stayed out of the way of the owner: no gateway of its own, and the
		// owner's record is untouched.
		expect(shared().tg.gateway).toBeNull();
		expect(shared().feishu.gateway).toBeNull();
		expect(ownerFilePid()).toBe(999999);
	});

	it("takes IM over once the owning process stops beating", async () => {
		// Past OWNER_STALE_MS: the terminal is gone (or killed) without unlinking.
		claimOwnerFile("tui", 31_000);

		const file = sessionFile("web-after-tui");
		const pi = boot(makeSession(file, cwd, "rpc"));
		await start(pi, "startup");

		expect(shared().owner?.owned).toBe(true);
		expect(ownerFilePid()).toBe(process.pid);
		// A fallback that takes over picks the session it was given, so IM is not
		// left without anything to drive.
		expect(shared().holderFile).toBe(file);
	});

	it("refuses to hand a non-owner the command context", async () => {
		claimOwnerFile("tui", 0);

		const file = sessionFile("web-click");
		const pi = boot(makeSession(file, cwd, "rpc"));
		await start(pi, "startup");
		expect(shared().cmdCtx).toBeNull();

		// The adopt round trip is how a command-capable context gets in. It must not
		// work for a process that does not own IM: the context is what /new and
		// /workspace are executed on, i.e. what moves the visible session.
		pi.api.sendUserMessage("/_piim-adopt", { expandPromptTemplates: true });
		await new Promise((r) => setTimeout(r, 10));
		expect(shared().cmdCtx).toBeNull();
	});

	it("stops bots a fallback may have started once it learns it is not the owner", async () => {
		claimOwnerFile("tui", 0);
		// Valid-looking credentials: if the fallback still ran autostart it would
		// try to connect, which is exactly the double-poll this guards against.
		writeFileSync(
			join(piImDir(), "telegram.json"),
			JSON.stringify({ botToken: "1:test", allowlist: [] }),
		);

		const file = sessionFile("web-creds");
		const pi = boot(makeSession(file, cwd, "rpc"));
		await start(pi, "startup");

		expect(shared().tg.gateway).toBeNull();
		expect(shared().owner?.owned).toBe(false);
	});

	it("comes back online by itself when the owning TUI exits", async () => {
		// The TUI quits while pi-web stays open. Nothing else re-runs autostart —
		// a page refresh does not create a session, and the extension gets no event
		// — so the heartbeat is the only thing that can notice IM is free again.
		// Before, the first claim of a process that opened as the fallback was not
		// announced and pi-web sat there owning IM with no gateway: every command,
		// /status included, got no reply at all.
		process.env.PIIM_OWNER_HEARTBEAT_MS = "5";
		try {
			claimOwnerFile("tui", 0);

			const file = sessionFile("web-alone");
			const pi = boot(makeSession(file, cwd, "rpc"));
			await start(pi, "startup");
			expect(shared().owner?.owned).toBe(false);
			expect(shared().holderAdopted).toBe(false);

			rmSync(join(piImDir(), "owner.json"), { force: true });
			await waitFor(() => shared().owner?.owned === true);
			expect(shared().ownerMode).toBe("rpc");
			expect(ownerFilePid()).toBe(process.pid);

			// And it has something to drive: the record on disk names no session, so
			// the takeover keeps the one it is already on instead of coming back mute.
			await waitFor(() => shared().holderAdopted === true);
			expect(shared().holderFile).toBe(file);
		} finally {
			delete process.env.PIIM_OWNER_HEARTBEAT_MS;
		}
	});
});
