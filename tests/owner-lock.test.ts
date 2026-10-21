// tests/owner-lock.test.ts
//
// Why this exists: the TUI and the pi-web server run pi-im in two separate
// processes, and each has its own `globalThis` — so the in-memory holder pin
// could not stop the two from both polling Telegram (409 ping-pong) and from
// adopting whatever session the user merely *clicked* in the browser. The
// arbitration lives in src/owner.ts; these tests pin its rule table and the
// file lifecycle down.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decideOwnership,
	OWNER_STALE_MS,
	openOwnerLock,
	parseOwnerRecord,
	readOwnerRecordSync,
} from "../src/owner.js";

const dirs: string[] = [];
function scratch(): string {
	const d = mkdtempSync(join(tmpdir(), "piim-owner-"));
	dirs.push(d);
	return join(d, "owner.json");
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rec = (
	over: Partial<{
		pid: number;
		mode: "tui" | "rpc" | "json" | "print" | "unknown";
		startedAt: number;
		heartbeatAt: number;
	}> = {},
) => ({
	pid: 100,
	mode: "rpc" as const,
	startedAt: 1_000,
	heartbeatAt: 1_000,
	...over,
});

async function waitFor(cond: () => boolean, ms = 500): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("decideOwnership", () => {
	const now = 10_000;

	it("claims a missing file", () => {
		expect(
			decideOwnership({ current: null, pid: 1, mode: "rpc", now }),
		).toEqual({ own: true, reason: "free", incumbent: null });
	});

	it("re-claims its own file", () => {
		const d = decideOwnership({
			current: rec({ pid: 7 }),
			pid: 7,
			mode: "rpc",
			now,
		});
		expect(d).toMatchObject({ own: true, reason: "same-process" });
	});

	it("claims a stale heartbeat", () => {
		const d = decideOwnership({
			current: rec({ pid: 8, heartbeatAt: now - OWNER_STALE_MS - 1 }),
			pid: 9,
			mode: "rpc",
			now,
		});
		expect(d).toMatchObject({ own: true, reason: "stale" });
	});

	it("keeps the live incumbent when the beat is fresh", () => {
		const d = decideOwnership({
			current: rec({ pid: 8, mode: "tui", heartbeatAt: now - 1_000 }),
			pid: 9,
			mode: "rpc",
			now,
		});
		expect(d).toMatchObject({ own: false, reason: "held-by-other" });
	});

	it("lets a TUI preempt a live rpc owner", () => {
		const d = decideOwnership({
			current: rec({ pid: 8, mode: "rpc", heartbeatAt: now - 1_000 }),
			pid: 9,
			mode: "tui",
			now,
		});
		expect(d).toMatchObject({ own: true, reason: "preempt" });
	});

	it("never lets two TUIs fight over the lock", () => {
		const d = decideOwnership({
			current: rec({ pid: 8, mode: "tui", heartbeatAt: now - 1_000 }),
			pid: 9,
			mode: "tui",
			now,
		});
		expect(d.own).toBe(false);
	});

	it("lets rpc preempt a print/json run", () => {
		for (const mode of ["json", "print"] as const) {
			expect(
				decideOwnership({
					current: rec({ pid: 8, mode, heartbeatAt: now - 1_000 }),
					pid: 9,
					mode: "rpc",
					now,
				}).reason,
			).toBe("preempt");
		}
	});

	it("treats an unknown host mode as the lowest priority", () => {
		expect(
			decideOwnership({
				current: rec({ pid: 8, mode: "unknown", heartbeatAt: now - 1_000 }),
				pid: 9,
				mode: "unknown",
				now,
			}).own,
		).toBe(false);
		expect(
			decideOwnership({
				current: rec({ pid: 8, mode: "rpc", heartbeatAt: now - 1_000 }),
				pid: 9,
				mode: "unknown",
				now,
			}).own,
		).toBe(false);
	});
});

describe("parseOwnerRecord", () => {
	it("rejects garbage instead of trusting it", () => {
		for (const raw of [
			null,
			0,
			"x",
			{},
			{ pid: 1 },
			{ pid: -1, heartbeatAt: 5 },
		]) {
			expect(parseOwnerRecord(raw)).toBeNull();
		}
	});

	it("keeps a real record and defaults an unknown mode", () => {
		expect(
			parseOwnerRecord({ pid: 3, mode: "weird", startedAt: 1, heartbeatAt: 2 }),
		).toEqual({ pid: 3, mode: "unknown", startedAt: 1, heartbeatAt: 2 });
	});

	it("reads a missing file as no owner", () => {
		expect(readOwnerRecordSync(scratch())).toBeNull();
	});
});

describe("openOwnerLock", () => {
	it("claims a free file and releases it on stop", () => {
		const file = scratch();
		const lock = openOwnerLock({ file, mode: "tui", pid: 4_242 });
		expect(lock.owned).toBe(true);
		expect(readOwnerRecordSync(file)).toMatchObject({
			pid: 4_242,
			mode: "tui",
		});
		lock.stop();
		expect(readOwnerRecordSync(file)).toBeNull();
	});

	it("refuses a live rpc lock while running as rpc", () => {
		const file = scratch();
		writeFileSync(
			file,
			JSON.stringify(rec({ pid: 11, mode: "rpc", heartbeatAt: Date.now() })),
		);
		const lock = openOwnerLock({ file, mode: "rpc", pid: 12 });
		expect(lock.owned).toBe(false);
		// A loser must not delete the winner's file on the way out.
		lock.stop();
		expect(readOwnerRecordSync(file)).toMatchObject({ pid: 11 });
	});

	it("stops the previous owner and lets it regain after release", async () => {
		const file = scratch();
		const events: string[] = [];
		const web = openOwnerLock({
			file,
			mode: "rpc",
			pid: 21,
			heartbeatMs: 5,
			onLost: () => events.push("web:lost"),
			onRegain: () => events.push("web:regain"),
		});
		expect(web.owned).toBe(true);

		const tui = openOwnerLock({ file, mode: "tui", pid: 22, heartbeatMs: 5 });
		expect(tui.owned).toBe(true);
		await waitFor(() => events.includes("web:lost"));
		expect(web.owned).toBe(false);
		expect(readOwnerRecordSync(file)).toMatchObject({ pid: 22, mode: "tui" });

		tui.stop();
		await waitFor(() => web.owned && events.includes("web:regain"));
		expect(events).toEqual(["web:lost", "web:regain"]);
		expect(readOwnerRecordSync(file)).toMatchObject({ pid: 21 });

		web.stop();
		tui.stop();
		expect(readOwnerRecordSync(file)).toBeNull();
	});
	it("tells a fallback when it becomes the owner for the first time", async () => {
		// The regression this guards: pi-web boots behind a live TUI, so it opens
		// the lock as the loser. Its first claim is not a re-claim, but it still has
		// to be announced — nobody else will start its gateways again, and a mute
		// bot that owns the lock is exactly what "commands do nothing" looked like.
		const file = scratch();
		const tui = openOwnerLock({ file, mode: "tui", pid: 32, heartbeatMs: 5 });
		const events: string[] = [];
		const web = openOwnerLock({
			file,
			mode: "rpc",
			pid: 33,
			heartbeatMs: 5,
			onLost: () => events.push("web:lost"),
			onRegain: () => events.push("web:regain"),
		});
		expect(tui.owned).toBe(true);
		expect(web.owned).toBe(false);
		// Opening behind an owner is not a loss either: nothing to announce yet.
		expect(events).toEqual([]);

		tui.stop();
		await waitFor(() => web.owned && events.length > 0);
		expect(events).toEqual(["web:regain"]);
		expect(readOwnerRecordSync(file)).toMatchObject({ pid: 33 });

		web.stop();
	});

	it("keeps beating so the record stays fresh", async () => {
		const file = scratch();
		const lock = openOwnerLock({ file, mode: "tui", pid: 31, heartbeatMs: 5 });
		const first = readOwnerRecordSync(file);
		await waitFor(() => {
			const cur = readOwnerRecordSync(file);
			return Boolean(cur && first && cur.heartbeatAt > first.heartbeatAt);
		});
		lock.stop();
	});

	it("does not resurrect a file it no longer names", () => {
		const file = scratch();
		const lock = openOwnerLock({ file, mode: "rpc", pid: 41 });
		expect(lock.owned).toBe(true);
		writeFileSync(
			file,
			JSON.stringify(rec({ pid: 41, mode: "tui", heartbeatAt: Date.now() })),
		);
		// Someone else's file with our pid is a preempt marker in tests only;
		// what matters here is that stop() does not unlink a foreign record.
		writeFileSync(
			file,
			JSON.stringify(rec({ pid: 42, mode: "tui", heartbeatAt: Date.now() })),
		);
		lock.stop();
		expect(readOwnerRecordSync(file)).toMatchObject({ pid: 42 });
		expect(readFileSync(file, "utf8")).toContain("42");
	});
});
