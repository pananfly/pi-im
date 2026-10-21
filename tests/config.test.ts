// tests/config.test.ts
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverSessionWorkspaces,
	feishuSetupConfig,
	mergeWorkspaces,
	readHolderRecordSync,
	readPiImConfig,
	recordHolder,
	recordPreferredModel,
	recordWorkspace,
	shouldAutoStart,
} from "../src/config.js";

describe("shouldAutoStart", () => {
	it("defaults true when file flag missing and no env", () => {
		expect(shouldAutoStart("feishu", {}, {})).toBe(true);
	});
	it("env 0 disables", () => {
		expect(
			shouldAutoStart("feishu", { PI_IM_AUTO_START: "0" }, { autoStart: true }),
		).toBe(false);
	});
});

describe("mergeWorkspaces", () => {
	it("current first, stored + discovered deduped", () => {
		expect(mergeWorkspaces(["/b", "/a"], "/a", ["/c", "/b", "/a"])).toEqual([
			"/a",
			"/b",
			"/c",
		]);
	});
});

describe("discoverSessionWorkspaces", () => {
	it("finds real session cwds from agent dir", async () => {
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		const found = await discoverSessionWorkspaces(
			join(homedir(), ".pi", "agent"),
		);
		expect(found).toContain("/Users/pan/Documents/Project/pi-im");
	});
});

describe("feishuSetupConfig", () => {
	it("turns on card rendering for a fresh setup", () => {
		expect(feishuSetupConfig({}, "cli_x", "s").progressMode).toBe("card");
	});

	it("never overwrites a progress mode the user already chose", () => {
		// Re-running setup to rotate credentials must not silently flip someone
		// back from the plain-text mode they deliberately switched to over IM.
		expect(
			feishuSetupConfig({ progressMode: "text" }, "cli_x", "s").progressMode,
		).toBe("text");
		expect(
			feishuSetupConfig({ progressMode: "card" }, "cli_x", "s").progressMode,
		).toBe("card");
	});

	it("keeps every other setting the config already had", () => {
		const next = feishuSetupConfig(
			{ allowlist: ["ou_1"], domain: "lark", autoStart: false },
			"cli_x",
			"s",
		);
		expect(next).toEqual({
			allowlist: ["ou_1"],
			domain: "lark",
			autoStart: false,
			appId: "cli_x",
			appSecret: "s",
			progressMode: "card",
		});
	});

	it("fills in the ordinary defaults on a first run", () => {
		expect(feishuSetupConfig({}, "cli_x", "s")).toMatchObject({
			domain: "feishu",
			autoStart: true,
		});
	});
});

describe("holder record", () => {
	it("round-trips the persisted holder", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-holder-cfg-"));
		expect(readHolderRecordSync(dir)).toBeNull();

		await recordHolder(dir, {
			sessionId: "s1",
			sessionFile: "/tmp/s1.jsonl",
			cwd: "/tmp/ws",
		});
		expect(readHolderRecordSync(dir)).toEqual({
			sessionId: "s1",
			sessionFile: "/tmp/s1.jsonl",
			cwd: "/tmp/ws",
		});
	});

	it("does not rewrite config.json when nothing changed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-holder-idem-"));
		const holder = {
			sessionId: "s1",
			sessionFile: "/tmp/s1.jsonl",
			cwd: "/tmp/ws",
		};
		await recordHolder(dir, holder);
		const before = readFileSync(join(dir, "config.json"), "utf8");
		await recordHolder(dir, holder);
		expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
	});
});

describe("config writes", () => {
	it("serializes concurrent writers so disjoint fields all survive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-cfg-race-"));
		// Holder persistence, workspace history and the remembered model each do
		// their own read-modify-write; unserialized they overwrite each other and
		// the holder (the one that matters across restarts) gets lost.
		await Promise.all([
			recordHolder(dir, {
				sessionId: "s1",
				sessionFile: "/tmp/s1.jsonl",
				cwd: "/tmp/ws",
			}),
			recordWorkspace(dir, "/tmp/ws"),
			recordPreferredModel(dir, { provider: "p", id: "m", via: "im" }),
		]);

		const cfg = await readPiImConfig(dir);
		expect(cfg.holderSessionFile).toBe("/tmp/s1.jsonl");
		expect(cfg.workspaces).toEqual(["/tmp/ws"]);
		expect(cfg.preferredModel).toMatchObject({ id: "m", via: "im" });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("leaves no temp file behind when writers overlap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-cfg-tmp-"));
		await Promise.all(
			Array.from({ length: 8 }, (_, i) => recordWorkspace(dir, `/tmp/ws-${i}`)),
		);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect((await readPiImConfig(dir)).workspaces?.length).toBe(8);
	});
});
