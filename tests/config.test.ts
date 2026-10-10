// tests/config.test.ts
import { describe, expect, it } from "vitest";
import {
	discoverSessionWorkspaces,
	mergeWorkspaces,
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
