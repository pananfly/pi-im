// tests/allowlist-commands.test.ts
//
// The allowlist is only usable if it can be edited without hand-editing JSON.
// It has to be a TUI command, because the IM path is exactly what the
// allowlist locks out.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piImExtension from "../src/extension.js";
import { setCurrentPi } from "../src/pi-ref.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-im-allow-"));
	process.env.PI_IM_DIR = dir;
});

afterEach(() => {
	delete process.env.PI_IM_DIR;
});

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

/** Boot the real factory and return a `run` helper for its /tg subcommands. */
async function boot() {
	const pi = fakePi();
	piImExtension(pi.api);
	setCurrentPi(pi.api);
	const tg = pi.commands.get("tg");
	if (!tg) throw new Error("/tg was not registered");
	return {
		notices: pi.notices,
		run: (args: string) => tg(args, fakeCtx(pi.notices)),
	};
}

async function config() {
	try {
		return JSON.parse(await readFile(join(dir, "telegram.json"), "utf8")) as {
			allowlist?: string[];
		};
	} catch {
		return {} as { allowlist?: string[] };
	}
}

async function seed(file: Record<string, unknown>) {
	await writeFile(join(dir, "telegram.json"), JSON.stringify(file));
}

describe("/tg allowlist management", () => {
	it("adds a sender and keeps them", async () => {
		await seed({ botToken: "t" });
		const { run } = await boot();

		await run("allow 424242");

		expect((await config()).allowlist).toEqual(["424242"]);
	});

	it("never duplicates an id that is already listed", async () => {
		await seed({ botToken: "t", allowlist: ["424242"] });
		const { run } = await boot();

		await run("allow 424242");

		expect((await config()).allowlist).toEqual(["424242"]);
	});

	it("removes a sender", async () => {
		await seed({ botToken: "t", allowlist: ["1", "2"] });
		const { run } = await boot();

		await run("deny 1");

		expect((await config()).allowlist).toEqual(["2"]);
	});

	it("lists the current allowlist", async () => {
		await seed({ botToken: "t", allowlist: ["1", "2"] });
		const { run, notices } = await boot();

		await run("allowlist");

		expect(notices.join("\n")).toContain("1");
		expect(notices.join("\n")).toContain("2");
	});

	it("says the allowlist is empty rather than printing nothing", async () => {
		await seed({ botToken: "t" });
		const { run, notices } = await boot();

		await run("allowlist");

		expect(notices.join("\n")).toMatch(/空|empty/i);
	});

	it("refuses an empty id instead of writing a blank entry", async () => {
		await seed({ botToken: "t" });
		const { run } = await boot();

		await run("allow");

		expect((await config()).allowlist).toBeUndefined();
	});

	it("preserves the bot token and other settings", async () => {
		await seed({ botToken: "t", autoStart: true });
		const { run } = await boot();

		await run("allow 1");

		const cfg = (await config()) as { botToken?: string; autoStart?: boolean };
		expect(cfg.botToken).toBe("t");
		expect(cfg.autoStart).toBe(true);
	});
});
