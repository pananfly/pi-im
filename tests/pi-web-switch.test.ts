// tests/pi-web-switch.test.ts
//
// Regression cover for `/workspace` and `/session` failing with "工作区切换被取消"
// under pi-web.
//
// pi-web's control unit is the AgentSessionWrapper, not the AgentSession: a wrapper
// binds one AgentSession for its whole life and never reassigns `inner`, so
// "switch session" means minting a new wrapper and registering it
// (rpc-manager.ts createExtensionCommandContextActions). It does not expose
// createCommandContext on its runner, so it cannot build the ExtensionCommandContext
// that `withSession` requires and therefore never invokes that callback.
//
// pi-im used to treat "withSession was not called" as failure
// (`if (!switched) throw new Error(workspaceCancelled)`), so every switch under
// pi-web reported cancellation no matter what actually happened. The real landing
// path is pi-im's own: the new wrapper re-runs the extension factory, session_start
// fires, claimCommandContext() dispatches the silent /_piim-adopt, and that adopts a
// *different* ctx object. So the question is "did cmdCtx get replaced", not "did the
// callback run".

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import piImExtension, { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";

const ADOPT_CMD = "_piim-adopt";

/**
 * Models the two hosts side by side.
 *
 * `invokeWithSession` reproduces pi's TUI: the callback runs and hands over the new
 * session synchronously. `rebindAfterSwitch` reproduces pi-web: no callback, but a
 * new wrapper appears a tick later, which re-runs the factory and dispatches
 * /_piim-adopt with a brand new command ctx.
 */
function fakePi(opts: {
	invokeWithSession: boolean;
	rebindAfterSwitch: boolean;
}) {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const commands = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const leakedToModel: string[] = [];

	const mintCommandCtx = (cwd: string, file: string) => {
		return {
			cwd,
			sessionManager: { getSessionFile: () => file },
			newSession: async () => ({ cancelled: false }),
			switchSession: async (
				_path: string,
				o?: { withSession?: (c: unknown) => Promise<void> },
			) => {
				if (opts.invokeWithSession) {
					await o?.withSession?.(
						mintCommandCtx("/tmp/other", "/tmp/other.jsonl"),
					);
					return { cancelled: false };
				}
				if (opts.rebindAfterSwitch) {
					// pi-web builds the new wrapper asynchronously; the extension
					// factory inside it re-registers /_piim-adopt and session_start
					// dispatches it a tick later.
					setTimeout(() => {
						dispatch(`/${ADOPT_CMD}`, "/tmp/other");
					}, 0);
				}
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: false }),
			ui: { notify: () => {} },
			isIdle: () => true,
		};
	};

	const dispatch = (text: string, cwd: string) => {
		const space = text.indexOf(" ");
		const name = space === -1 ? text.slice(1) : text.slice(1, space);
		const handler = commands.get(name);
		if (!handler) return;
		void handler("", mintCommandCtx(cwd, join(cwd, "s.jsonl")));
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
			const expand = options?.expandPromptTemplates ?? false;
			if (typeof content === "string" && content.startsWith("/")) {
				if (expand) dispatch(content, "/tmp/proj");
				else leakedToModel.push(content);
			}
		},
		sendMessage: () => {},
		setModel: () => Promise.resolve(true),
		setThinkingLevel: () => {},
	};

	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		commands,
		leakedToModel,
	};
}

/** Boot the extension and let session_start + the adopt round trip settle. */
async function boot(pi: ReturnType<typeof fakePi>) {
	piImExtension(pi.api);
	await pi.handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		{
			cwd: "/tmp/proj",
			sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
			modelRegistry: { getAvailable: () => [] },
			scopedModels: [],
			isIdle: () => true,
			ui: { notify: () => {} },
		},
	);
	await new Promise((r) => setTimeout(r, 10));
}

function makeController() {
	const c = new ImController(
		{
			async sendText() {
				return "m";
			},
			async editText() {},
		} as never,
		new PiAgentBridge(async () => {}),
		{ allowlist: [], channelName: "telegram" },
	);
	attachRuntime(c);
	return c;
}

beforeEach(() => {
	delete (globalThis as Record<string, unknown>).__piImShared__;
	process.env.PIIM_REBIND_TIMEOUT_MS = "300";
	process.env.PI_IM_LOCALE = "en";
});

afterEach(() => {
	delete process.env.PIIM_REBIND_TIMEOUT_MS;
	delete process.env.PI_IM_LOCALE;
});

describe("session switch under a host that never calls withSession", () => {
	it("succeeds once the new session re-claims the command context", async () => {
		const pi = fakePi({ invokeWithSession: false, rebindAfterSwitch: true });
		await boot(pi);
		const c = makeController();

		// The exact symptom: an absolute .jsonl path resolves without needing the
		// session index, so this isolates the landing logic from session listing.
		await expect(
			c.runtime?.switchSession?.("/tmp/proj/target.jsonl"),
		).resolves.toBeTypeOf("string");

		// The adopt payload still must not reach the model.
		expect(pi.leakedToModel).toEqual([]);
	});

	it("switches the workspace to a real directory with a real session file", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "piim-agent-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const workspace = mkdtempSync(join(tmpdir(), "piim-ws-"));
			const bucket = join(agentDir, "sessions");
			// Mirror pi's layout: sessions/<encodeCwdSubdir(cwd)>/<ts>_<uuid>.jsonl
			const encoded = `--${workspace.replace(/^\//, "").replace(/\//g, "-")}--`;
			mkdirSync(join(bucket, encoded), { recursive: true });
			writeFileSync(
				join(
					bucket,
					encoded,
					"2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl",
				),
				`${JSON.stringify({ cwd: workspace, sessionId: "11111111-2222-3333-4444-555555555555" })}\n`,
			);

			const pi = fakePi({ invokeWithSession: false, rebindAfterSwitch: true });
			await boot(pi);
			const c = makeController();

			await expect(c.runtime?.switchWorkspace?.(workspace)).resolves.toContain(
				"11111111",
			);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
	});

	it("reports a host limitation, not a bogus 'directory is gone', when nothing rebinds", async () => {
		const pi = fakePi({ invokeWithSession: false, rebindAfterSwitch: false });
		await boot(pi);
		const c = makeController();

		await expect(
			c.runtime?.switchSession?.("/tmp/proj/target.jsonl"),
		).rejects.toThrow(/restart the server/i);
		// The old copy blamed a missing cwd, which is a different failure entirely
		// and sent debugging in the wrong direction.
		await expect(
			c.runtime?.switchSession?.("/tmp/proj/target.jsonl"),
		).rejects.not.toThrow(/directory/i);
	});

	it("still succeeds immediately when the host does call withSession", async () => {
		const pi = fakePi({ invokeWithSession: true, rebindAfterSwitch: false });
		await boot(pi);
		const c = makeController();

		// No rebind is scheduled; only the TUI-style callback can save this. It
		// returns well before the 300ms timeout the fake is configured with.
		const started = Date.now();
		await expect(
			c.runtime?.switchSession?.("/tmp/proj/target.jsonl"),
		).resolves.toBeTypeOf("string");
		expect(Date.now() - started).toBeLessThan(200);
	});
});
