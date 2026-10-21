// tests/progress-mode-persist.test.ts
//
// The switch has to survive a restart, so it is written to feishu.json before
// the live mode is touched. The order matters: a failed write must leave the
// running mode alone, or /status would advertise a switch a restart undoes.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImController } from "../src/controller.js";
import type { ChannelLike } from "../src/core/types.js";
import piImExtension, { attachRuntime } from "../src/extension.js";
import { PiAgentBridge } from "../src/pi-bridge.js";
import { setCurrentPi } from "../src/pi-ref.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-im-pmode-"));
	process.env.PI_IM_DIR = dir;
});

afterEach(() => {
	delete process.env.PI_IM_DIR;
});

function controller(channelName: string) {
	const c = new ImController(
		{
			async sendText() {
				return "m";
			},
			async editText() {},
		} as unknown as ChannelLike,
		new PiAgentBridge(async () => {}),
		{ allowlist: [], channelName, progressMode: "text" },
	);
	attachRuntime(c);
	return c;
}

/**
 * The gateway publishes the live controller in the shared slot; the hook reads
 * that slot rather than closing over the controller it was attached to. Call
 * only after controller(), which is what creates the shared state.
 */
function publish(channelName: string, c: ImController) {
	const shared = (globalThis as Record<string, unknown>).__piImShared__ as {
		feishu: { controller: ImController | null };
		tg: { controller: ImController | null };
	};
	(channelName === "telegram" ? shared.tg : shared.feishu).controller = c;
}

async function readJson(name: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(dir, name), "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

describe("/feishu card persistence", () => {
	it("writes the mode and applies it to the live controller", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x", allowlist: ["u1"] }),
		);
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("card");

		expect(await readJson("feishu.json")).toEqual({
			appId: "cli_x",
			allowlist: ["u1"],
			progressMode: "card",
		});
		expect(c.progressMode()).toBe("card");
	});

	it("writes text back without touching the credentials", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x", appSecret: "s" }),
		);
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("text");

		expect(await readJson("feishu.json")).toEqual({
			appId: "cli_x",
			appSecret: "s",
			progressMode: "text",
		});
	});

	it("creates the config file when there is none yet", async () => {
		const c = controller("feishu");
		publish("feishu", c);

		await c.runtime?.setProgressMode?.("card");

		expect((await readJson("feishu.json")).progressMode).toBe("card");
	});

	it("keeps the live mode when the write fails", async () => {
		// A directory where the file belongs: saveJsonAtomic's rename onto it
		// fails, which is the closest portable stand-in for a read-only volume.
		await mkdir(join(dir, "feishu.json"));
		await writeFile(join(dir, "feishu.json", "blocker"), "x");
		const c = controller("feishu");
		publish("feishu", c);

		await expect(c.runtime?.setProgressMode?.("card")).rejects.toThrow();

		expect(c.progressMode()).toBe("text");
	});

	it("writes telegram.json for a Telegram controller and leaves feishu.json alone", async () => {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ appId: "cli_x" }),
		);
		const c = controller("telegram");
		publish("telegram", c);

		await c.runtime?.setProgressMode?.("card");

		// Proves the slot lookup: the shared keys are `feishu` and `tg`, so a
		// naive shared[channel] would be undefined and silently skip this.
		expect(c.progressMode()).toBe("card");
		expect((await readJson("telegram.json")).progressMode).toBe("card");
		expect(await readJson("feishu.json")).toEqual({ appId: "cli_x" });
	});
});

/** The real factory, so the registered /feishu command can be driven directly. */
function fakePi() {
	const commands = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const notices: string[] = [];
	const api = {
		on: () => {},
		registerCommand: (
			name: string,
			o: { handler: (a: string, c: unknown) => Promise<void> },
		) => {
			commands.set(name, o.handler);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		sendUserMessage: () => {},
		setModel: () => Promise.resolve(true),
		setThinkingLevel: () => {},
	};
	return { api: api as unknown as ExtensionAPI, commands, notices };
}

function fakeCtx(notices: string[]) {
	return {
		cwd: "/tmp/proj",
		isIdle: () => true,
		scopedModels: [],
		sessionManager: { getSessionFile: () => "/tmp/proj/s.jsonl" },
		modelRegistry: { getAvailable: () => [] },
		ui: {
			notify: (m: string) => {
				notices.push(m);
			},
		},
	};
}

describe("/feishu card from the terminal", () => {
	// No credentials in the fixture: autostart then finds nothing to connect to,
	// so booting the factory here does not open a real WebSocket.
	async function bootTui() {
		await writeFile(
			join(dir, "feishu.json"),
			JSON.stringify({ allowlist: ["u1"] }),
		);
		const pi = fakePi();
		piImExtension(pi.api);
		setCurrentPi(pi.api);
		const c = controller("feishu");
		publish("feishu", c);
		const run = pi.commands.get("feishu");
		if (!run) throw new Error("/feishu was not registered");
		return {
			c,
			notices: pi.notices,
			run: (args: string) => run(args, fakeCtx(pi.notices)),
		};
	}

	it("switches the mode without restarting anything", async () => {
		const { c, run } = await bootTui();

		await run("card");

		expect(await readJson("feishu.json")).toEqual({
			allowlist: ["u1"],
			progressMode: "card",
		});
		expect(c.progressMode()).toBe("card");
	});

	it("switches back to plain text", async () => {
		const { c, run } = await bootTui();

		await run("text");

		expect((await readJson("feishu.json")).progressMode).toBe("text");
		expect(c.progressMode()).toBe("text");
	});

	it("says which mode is live", async () => {
		const { notices, run } = await bootTui();

		await run("card");

		expect(notices.join("\n")).toContain("card");
	});

	// The usage line is the only place a terminal user learns the subcommands
	// exist, so omitting it makes the command undiscoverable from the TUI.
	it("advertises card|text in the usage line", async () => {
		const { notices, run } = await bootTui();

		await run("nonsense");

		expect(notices.join("\n")).toMatch(/card\|text/);
	});
});
