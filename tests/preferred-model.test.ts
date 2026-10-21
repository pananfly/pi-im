// tests/preferred-model.test.ts
//
// Every /new starts the session on pi's configured default model, because
// ExtensionAPI.setModel has no `persist` option:
//
//   agent-session.js:2743  setModel: async (model) => { await this.setModel(model) }
//   agent-session.js:1952  if (options.persist) { settingsManager.setDefaultModelAndProvider(...) }
//
// So a model picked over IM silently reverted on the next /new. pi-im therefore
// remembers the pick and re-applies it when a *new* session starts — and only
// then, so resuming or restarting an old session keeps the model it recorded.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import piImExtension from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { setCurrentPi } from "../src/pi-ref.js";

type Reason = "startup" | "reload" | "new" | "resume" | "fork";

const CATALOG = [
	{ id: "m1", name: "M1", provider: "p" },
	{ id: "m2", name: "M2", provider: "p" },
];

/** What the live session is actually running, as ctx.model would report it. */
let currentModel: { id?: string; name?: string; provider?: string } =
	CATALOG[0];
let setModelRejects = false;
let notices: string[] = [];

function resetFakes() {
	currentModel = CATALOG[0];
	setModelRejects = false;
	notices = [];
}

function fakePi() {
	const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
	const setModelCalls: unknown[] = [];
	const api = {
		on: (event: string, h: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, h);
		},
		registerCommand: () => {},
		sendUserMessage: () => {},
		setModel: (m: unknown) => {
			setModelCalls.push(m);
			if (setModelRejects) return Promise.reject(new Error("no key"));
			currentModel = m as typeof currentModel;
			return Promise.resolve(true);
		},
		setThinkingLevel: () => {},
	};
	return {
		api: api as unknown as ExtensionAPI,
		handlers,
		setModelCalls,
		/** Mimic the user switching model inside the TUI. */
		selectModel: async (m: unknown) => {
			currentModel = m as typeof currentModel;
			await handlers.get("model_select")?.(
				{ type: "model_select", model: m, source: "set" },
				fakeCtx(),
			);
		},
		/**
		 * The session_start handler kicks off a fire-and-forget async chain
		 * (autostart, then the model restore), so the assertion races it.
		 * Every reason="new" path ends in exactly one notify; reasons that
		 * should stay silent pass {silent:true} to skip the wait entirely.
		 */
		fire: async (reason: Reason, opts: { silent?: boolean } = {}) => {
			const h = handlers.get("session_start");
			expect(h).toBeTypeOf("function");
			const before = notices.length;
			h?.({ type: "session_start", reason }, fakeCtx());
			if (opts.silent) return;
			const deadline = Date.now() + 300;
			while (notices.length === before && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 5));
			}
		},
	};
}

function fakeCtx() {
	return {
		cwd: "/tmp/proj",
		scopedModels: [],
		isIdle: () => true,
		sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
		modelRegistry: { getAvailable: () => CATALOG },
		get model() {
			return currentModel;
		},
		ui: {
			notify: (m: string) => {
				notices.push(m);
			},
		},
	};
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-im-model-"));
	process.env.PI_IM_DIR = dir;
	resetFakes();
});

afterEach(() => {
	delete process.env.PI_IM_DIR;
});

async function writePref(model: unknown) {
	await writeFile(
		join(dir, "config.json"),
		JSON.stringify({ preferredModel: model }),
	);
}

async function boot() {
	const pi = fakePi();
	piImExtension(pi.api);
	setCurrentPi(pi.api);
	return pi;
}

describe("preferred model survives /new", () => {
	it("re-applies the remembered model when a new session starts", async () => {
		await writePref({ provider: "p", id: "m2", name: "M2" });
		const pi = await boot();

		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([CATALOG[1]]);
		expect(notices.join("\n")).toContain("M2");
	});

	it("reports the restored model so the switch is never silent", async () => {
		await writePref({ provider: "p", id: "m2", name: "M2" });
		const pi = await boot();

		await pi.fire("new");

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/当前模型.*M2/);
	});

	it("says which model is live when nothing was ever picked", async () => {
		const pi = await boot();

		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/当前模型.*M1/);
	});

	it("warns instead of silently keeping the default when the model is gone", async () => {
		await writePref({ provider: "p", id: "gone", name: "Gone" });
		const pi = await boot();

		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/Gone/);
		expect(notices[0]).toMatch(/当前模型.*M1/);
	});

	it("warns when re-applying the model fails", async () => {
		await writePref({ provider: "p", id: "m2", name: "M2" });
		setModelRejects = true;
		const pi = await boot();

		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([CATALOG[1]]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/M2/);
		expect(notices[0]).toMatch(/当前模型.*M1/);
	});

	it("leaves resumed and startup sessions on the model pi chose", async () => {
		await writePref({ provider: "p", id: "m2", name: "M2" });

		for (const reason of ["resume", "startup", "fork", "reload"] as const) {
			resetFakes();
			const pi = await boot();
			await pi.fire(reason, { silent: true });
			expect(pi.setModelCalls, `reason=${reason}`).toEqual([]);
			expect(notices, `reason=${reason}`).toEqual([]);
		}
	});

	it("does nothing when no model was ever picked", async () => {
		const pi = await boot();
		await pi.fire("new");
		expect(pi.setModelCalls).toEqual([]);
	});

	it("ignores a remembered model that is no longer in the catalogue", async () => {
		await writePref({ provider: "p", id: "gone", name: "Gone" });
		const pi = await boot();

		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([]);
	});

	it("records a TUI pick and restores it when IM never chose", async () => {
		const pi = await boot();

		await pi.selectModel(CATALOG[1]); // user picks in the TUI
		await pi.fire("new");

		expect(pi.setModelCalls).toEqual([CATALOG[1]]);
	});

	it("keeps the IM pick when a TUI pick happens later", async () => {
		const pi = await boot();

		await switchVia(makeController().c, "m2"); // IM picks M2
		await pi.selectModel(CATALOG[0]); // user then picks M1 in the TUI
		const before = pi.setModelCalls.length;
		await pi.fire("new");

		// Only the restore counts; the IM switch above already called setModel.
		expect(pi.setModelCalls.slice(before)).toEqual([CATALOG[1]]); // M2 still wins
	});

	it("lets a later IM pick override an earlier TUI pick", async () => {
		const pi = await boot();

		await pi.selectModel(CATALOG[0]);
		await switchVia(makeController().c, "m2");
		const before = pi.setModelCalls.length;
		await pi.fire("new");

		expect(pi.setModelCalls.slice(before)).toEqual([CATALOG[1]]);
	});

	it("does not record its own restore as a TUI pick", async () => {
		await writePref({ provider: "p", id: "m2", name: "M2", via: "tui" });
		const pi = await boot();

		await pi.fire("new");

		// If the restore fed back into preferredModel it would be tagged "im"
		// and become un-overridable by the TUI forever after.
		const cfg = JSON.parse(
			await readFile(join(dir, "config.json"), "utf8"),
		) as { preferredModel?: { via?: string } };
		expect(cfg.preferredModel?.via).toBe("tui");
	});

	it("records the model when /model switches it", async () => {
		const pi = await boot();
		await pi.fire("new");
		const { c } = makeController();
		c.runtime = { switchModel: undefined };

		await switchVia(c, "m2");

		const cfg = JSON.parse(
			await readFile(join(dir, "config.json"), "utf8"),
		) as { preferredModel?: unknown };
		expect(cfg.preferredModel).toMatchObject({ provider: "p", id: "m2" });
	});
});

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
	return { c };
}

/** Drive /model through the runtime the extension attaches to IM controllers. */
async function switchVia(c: ImController, query: string) {
	const { attachRuntime } = await import("../src/extension.js");
	attachRuntime(c);
	return c.runtime?.switchModel?.(query);
}
