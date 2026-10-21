// tests/feishu-slash-commands.test.ts
//
// Feishu's "/" panel is server-side state per bot application; the client
// fetches it and nothing in the developer console configures it. pi-im must
// register its command names itself via
//   POST /open-apis/application/v7/app_slash_commands
// (scopes application:app_slash_command:read/write, both already granted).
//
// Registering is purely a client-side convenience: tapping an entry sends the
// bot an ordinary text message, which the IM controller already matches. So a
// name in the manifest must be a command pi-im actually handles.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PI_IM_SLASH_MANIFEST,
	syncSlashCommands,
} from "../src/feishu/slash-commands.js";
import { KNOWN } from "../src/remote-commands.js";

/**
 * The two reply shapes, as the live API actually returns them: the token
 * endpoint puts tenant_access_token at the TOP level, everything else nests
 * under `data`. Getting this wrong makes every sync report "auth failed: ok"
 * while the tests stay green, so it is pinned here deliberately.
 */
interface TokenReply {
	code: number;
	msg?: string;
	tenant_access_token?: string;
}

interface DataReply {
	code: number;
	msg?: string;
	data?: {
		command_id?: string;
		items?: Array<{ command: string; command_id: string }>;
	};
}

type Reply = DataReply;

function fakeFeishu(
	reply: (url: string, init?: RequestInit) => TokenReply | Reply,
) {
	const calls: Array<{ url: string; method: string; body?: unknown }> = [];
	const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url: u, method: init?.method ?? "GET", body });
		return { ok: true, json: async () => reply(u, init) };
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const CREDS = { appId: "cli_x", appSecret: "s", domain: "feishu" as const };

function tokenThen(list: Reply, create?: Reply) {
	return (url: string, init?: RequestInit) => {
		if (url.includes("tenant_access_token")) {
			// Top level, exactly like the real endpoint.
			return { code: 0, msg: "ok", tenant_access_token: "t-1" };
		}
		// Same URL for both, so the method is the only way to tell them apart.
		return init?.method === "POST" && create ? create : list;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Feishu slash-command panel", () => {
	it("registers every manifest entry, without the leading slash", async () => {
		const { impl, calls } = fakeFeishu(
			tokenThen(
				{ code: 0, data: { items: [] } },
				{ code: 0, data: { command_id: "7" } },
			),
		);
		vi.stubGlobal("fetch", impl);

		const report = await syncSlashCommands(CREDS);

		const created = calls
			.filter((c) => c.method === "POST" && c.url.includes("v7"))
			.map((c) => (c.body as { command: string }).command);
		expect(created).toEqual(PI_IM_SLASH_MANIFEST.map((e) => e.command));
		expect(created.every((c) => !c.startsWith("/"))).toBe(true);
		expect(report.created).toHaveLength(PI_IM_SLASH_MANIFEST.length);
		expect(report.failed).toEqual([]);
	});

	it("hits the v7 endpoint with the tenant token", async () => {
		const { impl, calls } = fakeFeishu(
			tokenThen({ code: 0, data: { items: [] } }),
		);
		vi.stubGlobal("fetch", impl);

		await syncSlashCommands(CREDS);

		expect(calls[0]?.url).toContain(
			"/open-apis/auth/v3/tenant_access_token/internal",
		);
		const list = calls.find((c) => c.method === "GET");
		expect(list?.url).toContain("/open-apis/application/v7/app_slash_commands");
		expect(list?.url).toContain("open.feishu.cn");
		const create = calls.find(
			(c) => c.method === "POST" && c.url.includes("v7"),
		);
		expect(create?.url).toContain(
			"/open-apis/application/v7/app_slash_commands",
		);
	});

	it("is idempotent: a second sync creates nothing", async () => {
		const { impl, calls } = fakeFeishu(
			tokenThen({ code: 0, data: { items: [] } }),
		);
		vi.stubGlobal("fetch", impl);

		await syncSlashCommands(CREDS);
		const first = calls.filter(
			(c) => c.method === "POST" && c.url.includes("v7"),
		).length;
		calls.length = 0;

		const { impl: impl2 } = fakeFeishu(
			tokenThen({
				code: 0,
				data: {
					items: PI_IM_SLASH_MANIFEST.map((e, i) => ({
						command: e.command,
						command_id: String(i + 1),
					})),
				},
			}),
		);
		vi.stubGlobal("fetch", impl2);

		const report = await syncSlashCommands(CREDS);

		expect(first).toBeGreaterThan(0);
		expect(report.created).toEqual([]);
		expect(report.failed).toEqual([]);
	});

	it("creates only what is missing and never touches foreign commands", async () => {
		const { impl, calls } = fakeFeishu(
			tokenThen({
				code: 0,
				data: {
					items: [
						{ command: "help", command_id: "1" },
						{ command: "status", command_id: "2" },
						{ command: "someone_elses", command_id: "3" },
					],
				},
			}),
		);
		vi.stubGlobal("fetch", impl);

		const report = await syncSlashCommands(CREDS);

		const created = calls
			.filter((c) => c.method === "POST" && c.url.includes("v7"))
			.map((c) => (c.body as { command: string }).command);
		expect(created).not.toContain("help");
		expect(created).not.toContain("status");
		expect(created).not.toContain("someone_elses");
		// Deleting somebody else's registration would be rude and unrecoverable.
		expect(calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(report.external).toContain("someone_elses");
	});

	it("stops the batch on a permission error instead of retrying 20 times", async () => {
		const { impl, calls } = fakeFeishu((url, init) =>
			url.includes("tenant_access_token")
				? { code: 0, msg: "ok", tenant_access_token: "t-1" }
				: init?.method === "POST"
					? { code: 99991672, msg: "lacks permission" }
					: { code: 0, data: { items: [] } },
		);
		vi.stubGlobal("fetch", impl);

		const report = await syncSlashCommands(CREDS);

		const attempts = calls.filter(
			(c) => c.method === "POST" && c.url.includes("v7"),
		);
		expect(attempts).toHaveLength(1);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.error).toMatch(/permission/i);
	});

	it("treats an already-exists race as success", async () => {
		const { impl } = fakeFeishu((url, init) =>
			url.includes("tenant_access_token")
				? { code: 0, msg: "ok", tenant_access_token: "t-1" }
				: init?.method === "POST"
					? { code: 40000000, msg: "command already exists" }
					: { code: 0, data: { items: [] } },
		);
		vi.stubGlobal("fetch", impl);

		const report = await syncSlashCommands(CREDS);

		expect(report.failed).toEqual([]);
		expect(report.created).toEqual([]);
	});

	it("never throws, so a sync problem cannot stop the gateway", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch,
		);

		// The failure is recorded, not thrown: the panel is a convenience and
		// must never be able to stop the gateway from starting.
		const report = await syncSlashCommands(CREDS);
		expect(report.created).toEqual([]);
		expect(report.failed[0]?.error).toMatch(/network down/);
	});

	it("refuses to run without credentials", async () => {
		const { impl, calls } = fakeFeishu(
			tokenThen({ code: 0, data: { items: [] } }),
		);
		vi.stubGlobal("fetch", impl);

		const report = await syncSlashCommands({
			appId: "",
			appSecret: "",
			domain: "feishu",
		});

		expect(calls).toHaveLength(0);
		expect(report.failed).toEqual([]);
	});
});

describe("manifest stays honest", () => {
	it("only names commands the IM controller actually handles", () => {
		for (const entry of PI_IM_SLASH_MANIFEST) {
			expect(KNOWN).toContain(`/${entry.command}`);
		}
	});

	it("does not register aliases, so the panel has no duplicates", () => {
		const names = PI_IM_SLASH_MANIFEST.map((e) => e.command);
		for (const alias of ["ws", "sessions", "reasoning"]) {
			expect(names).not.toContain(alias);
		}
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every command a zh and en description", () => {
		for (const entry of PI_IM_SLASH_MANIFEST) {
			expect(entry.default.length).toBeGreaterThan(0);
			expect(entry.en_us.length).toBeGreaterThan(0);
		}
	});

	it("covers every non-alias command pi-im supports", () => {
		const aliases = new Set(["ws", "sessions", "reasoning"]);
		const expected = KNOWN.map((n) => n.slice(1)).filter(
			(n) => !aliases.has(n),
		);
		expect(PI_IM_SLASH_MANIFEST.map((e) => e.command).sort()).toEqual(
			expected.sort(),
		);
	});
});
