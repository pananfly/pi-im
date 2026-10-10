// tests/i18n.test.ts
import { describe, expect, it } from "vitest";
import { mergeWorkspaces } from "../src/config.js";
import { parseMention } from "../src/feishu/gateway.js";
import { getStrings, resolveLocale } from "../src/i18n.js";

describe("i18n", () => {
	it("defaults to zh", () => {
		expect(resolveLocale({}, {})).toBe("zh");
		expect(getStrings("zh").stopDone).toContain("中止");
	});
	it("en via env or file", () => {
		expect(resolveLocale({ PI_IM_LOCALE: "en" }, {})).toBe("en");
		expect(resolveLocale({}, { locale: "en-US" })).toBe("en");
		expect(getStrings("en").stopDone).toContain("Abort");
	});
	it("unknown locale falls back to zh", () => {
		expect(resolveLocale({}, { locale: "fr" })).toBe("zh");
	});
});

describe("workspaces history", () => {
	it("merges current first, dedupes", () => {
		expect(mergeWorkspaces(["/b", "/a"], "/a")).toEqual(["/a", "/b"]);
		expect(mergeWorkspaces(undefined, "/x")).toEqual(["/x"]);
	});
});

describe("feishu parseMention", () => {
	it("detects own-bot tags only", () => {
		expect(parseMention('<at user_id="ou_1">bot</at> hi', "ou_1")).toBe(true);
		expect(parseMention('<at user_id="ou_2">x</at> hi', "ou_1")).toBe(false);
		expect(parseMention("plain hello", "ou_9")).toBe(false);
		expect(parseMention("", "ou_9")).toBe(false);
	});
});
