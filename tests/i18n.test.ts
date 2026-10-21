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

describe("version", () => {
	it("reads the real package version instead of a hardcoded string", async () => {
		// Self-updating on purpose: bumping package.json must break this test,
		// which is the whole point. A literal "0.1.0" here would let the banner
		// keep lying across a release.
		const { readFile } = await import("node:fs/promises");
		const { fileURLToPath } = await import("node:url");
		const pkg = JSON.parse(
			await readFile(
				fileURLToPath(new URL("../package.json", import.meta.url)),
				"utf8",
			),
		) as { version: string };

		expect(getStrings("zh").statusVersion).toBe(`pi-im ${pkg.version}`);
		expect(getStrings("en").statusVersion).toBe(`pi-im ${pkg.version}`);
	});

	it("never claims a version it did not read", () => {
		// "unknown" is honest; a stale number is not.
		for (const l of ["zh", "en"] as const) {
			expect(getStrings(l).statusVersion).not.toContain("undefined");
		}
	});

	it("degrades to unknown when the manifest cannot be read", async () => {
		// This is the assertion that separates "reads package.json" from
		// "happens to say 0.1.0 today". A hardcoded constant cannot fail.
		const { piImVersion } = await import("../src/config.js");

		expect(
			piImVersion(new URL("./no-such-manifest.json", import.meta.url)),
		).toBe("unknown");
	});

	it("falls back to unknown rather than a partial version", async () => {
		const { piImVersion } = await import("../src/config.js");
		const { mkdtemp, writeFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { pathToFileURL } = await import("node:url");
		const dir = await mkdtemp(join(tmpdir(), "pi-im-pkg-"));

		// A manifest with no version field must not render as "pi-im undefined".
		const noVersion = join(dir, "a.json");
		await writeFile(noVersion, JSON.stringify({ name: "pi-im" }));
		expect(piImVersion(pathToFileURL(noVersion))).toBe("unknown");

		const malformed = join(dir, "b.json");
		await writeFile(malformed, "{ not json");
		expect(piImVersion(pathToFileURL(malformed))).toBe("unknown");
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
