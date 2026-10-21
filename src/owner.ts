/**
 * Cross-process ownership of IM.
 *
 * Two pi processes run the extension at the same time all the time: the TUI in
 * a terminal and the `pi-web` server the browser drives. Each one has its own
 * `globalThis`, so `SharedState` — the in-memory holder pin — cannot arbitrate
 * between them. Both processes used to autostart the bots, and whichever lost
 * the Telegram long-poll 409 merely backed off and retried, so the two took
 * turns answering. The visible symptom was worse than a flap: clicking any
 * session in pi-web adopted it as holder, which dragged IM's workspace and
 * session over to the tab the user had merely opened.
 *
 * This module is the missing coordinate: one `owner.json` on disk, claimed by
 * whichever process should serve IM, refreshed by a heartbeat, and released on
 * the way out. Only the owner runs bots and only the owner adopts a session
 * into the pin.
 *
 * The priority order is TUI first, then web:
 *
 *   tui > rpc > json/print
 *
 * A TUI that starts while pi-web owns the lock takes it over (the user is right
 * there in a terminal; that is the pin they mean). pi-web never takes it from a
 * live TUI; it waits until the TUI's heartbeat goes stale or the process
 * removes the file, then claims on its next beat. Two TUI processes leave the
 * incumbent alone — "first terminal wins" instead of a takeover fight.
 *
 * A crashed owner leaves the file behind, which is what the heartbeat is for:
 * anything can claim once `staleMs` has passed since the last beat.
 */

import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Mirror of pi's `ExtensionMode`, plus the "host did not say" case. */
export type ProcessMode = "tui" | "rpc" | "json" | "print" | "unknown";

/** How long without a beat before the owner is presumed dead. */
export const OWNER_STALE_MS = 30_000;
/** How often the live owner refreshes its beat. */
export const OWNER_HEARTBEAT_MS = 10_000;

export interface OwnerRecord {
	/** Process id of the owner. */
	pid: number;
	/** Why it claimed the lock; used for preemption. */
	mode: ProcessMode;
	/** When this claim began, so a takeover is distinguishable from a beat. */
	startedAt: number;
	/** Last refresh; staleness is judged from this alone. */
	heartbeatAt: number;
}

export type ClaimReason =
	| "free"
	| "stale"
	| "same-process"
	| "preempt"
	| "held-by-other";

export interface OwnershipDecision {
	own: boolean;
	reason: ClaimReason;
	/** The record that was on disk when the decision was made. */
	incumbent: OwnerRecord | null;
}

/** Higher wins; ties keep the incumbent. */
export function modePriority(mode: ProcessMode): number {
	switch (mode) {
		case "tui":
			return 3;
		case "rpc":
			return 2;
		case "json":
		case "print":
			return 1;
		default:
			return 0;
	}
}

function isMode(v: unknown): v is ProcessMode {
	return (
		v === "tui" ||
		v === "rpc" ||
		v === "json" ||
		v === "print" ||
		v === "unknown"
	);
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Tolerant parse: a corrupt or half-written file must read as "no owner". */
export function parseOwnerRecord(raw: unknown): OwnerRecord | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const pid = num(o.pid);
	const startedAt = num(o.startedAt);
	const heartbeatAt = num(o.heartbeatAt);
	if (pid === null || startedAt === null || heartbeatAt === null) return null;
	if (!Number.isInteger(pid) || pid <= 0) return null;
	return {
		pid,
		mode: isMode(o.mode) ? o.mode : "unknown",
		startedAt,
		heartbeatAt,
	};
}

export function readOwnerRecordSync(file: string): OwnerRecord | null {
	try {
		return parseOwnerRecord(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

export function writeOwnerRecordSync(
	file: string,
	record: OwnerRecord,
): boolean {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0x180 });
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		return false;
	}
}

/**
 * The arbitration rule, pure so it is testable without a clock or a disk.
 *
 * `now` is injected rather than read from `Date.now()` so a stale record can be
 * exercised deterministically.
 */
export function decideOwnership(opts: {
	current: OwnerRecord | null;
	pid: number;
	mode: ProcessMode;
	now: number;
	staleMs?: number;
}): OwnershipDecision {
	const staleMs = opts.staleMs ?? OWNER_STALE_MS;
	const cur = opts.current;
	if (!cur) return { own: true, reason: "free", incumbent: null };
	if (cur.pid === opts.pid)
		return { own: true, reason: "same-process", incumbent: cur };
	if (opts.now - cur.heartbeatAt > staleMs) {
		return { own: true, reason: "stale", incumbent: cur };
	}
	if (modePriority(opts.mode) > modePriority(cur.mode)) {
		return { own: true, reason: "preempt", incumbent: cur };
	}
	return { own: false, reason: "held-by-other", incumbent: cur };
}

export interface OwnerLockOptions {
	/** Absolute path of `owner.json`. */
	file: string;
	mode: ProcessMode;
	/** Override for tests; defaults to this process. */
	pid?: number;
	now?: () => number;
	staleMs?: number;
	heartbeatMs?: number;
	/** Fired when another process takes the lock away. */
	onLost?: () => void;
	/**
	 * Fired on every false -> true transition after open, except the very first
	 * claim of a process that opened as the owner (the caller is starting up and
	 * handles that inline). A process that opened as the fallback does get it —
	 * that is how pi-web learns that IM became its job after the TUI exited.
	 */
	onRegain?: () => void;
}

export interface OwnerLock {
	/** Whether this process currently owns IM. Read on every check. */
	readonly owned: boolean;
	readonly record: OwnerRecord;
	/** Stop beating and drop the file if it is still ours. */
	stop(): void;
}

interface Tracked {
	file: string;
	pid: number;
}

const tracked = new Map<string, Tracked>();

function trackedKey(file: string, pid: number): string {
	return `${pid}\u0000${file}`;
}

function releaseSync(t: Tracked): void {
	const cur = readOwnerRecordSync(t.file);
	if (cur && cur.pid === t.pid) {
		try {
			rmSync(t.file, { force: true });
		} catch {}
	}
}

// One process-wide hook instead of one per lock: a lock lives for the whole
// process, so this fires exactly once, and it must not keep an unrelated
// interval or listener alive.
process.once("exit", () => {
	for (const t of tracked.values()) releaseSync(t);
});

/**
 * Claim (or wait for) the lock and keep beating.
 *
 * Never throws: an unwritable directory means "no lock on this profile", which
 * must fall back to single-process behaviour instead of taking IM offline.
 */
export function openOwnerLock(opts: OwnerLockOptions): OwnerLock {
	const pid = opts.pid ?? process.pid;
	const now = opts.now ?? (() => Date.now());
	const staleMs = opts.staleMs ?? OWNER_STALE_MS;
	const heartbeatMs = opts.heartbeatMs ?? OWNER_HEARTBEAT_MS;

	let record: OwnerRecord = {
		pid,
		mode: opts.mode,
		startedAt: now(),
		heartbeatAt: now(),
	};
	let owned = false;
	// Whether the next false -> true transition has to be announced. The startup
	// claim is not announced (the caller handles it inline); everything later is
	// news, including the first claim of a process that opened as the fallback.
	let announce = false;
	let startedAt = 0;
	let stopped = false;

	const claim = (at: number): void => {
		if (startedAt === 0) startedAt = at;
		record = { pid, mode: opts.mode, startedAt, heartbeatAt: at };
		writeOwnerRecordSync(opts.file, record);
	};

	const first = decideOwnership({
		current: readOwnerRecordSync(opts.file),
		pid,
		mode: opts.mode,
		now: now(),
		staleMs,
	});
	if (first.own) {
		owned = true;
		claim(record.heartbeatAt);
	} else {
		// Queued behind a live owner: whoever gets here must be told when it wins.
		announce = true;
	}

	const beat = (): void => {
		if (stopped) return;
		const at = now();
		const cur = readOwnerRecordSync(opts.file);
		if (cur && cur.pid === pid) {
			if (!owned) {
				// We had been preempted but the file still names us (the other
				// process died before it could claim): take our own beat back.
				owned = true;
				claim(at);
				if (announce) {
					announce = false;
					opts.onRegain?.();
				}
				return;
			}
			claim(at);
			return;
		}
		const decision = decideOwnership({
			current: cur,
			pid,
			mode: opts.mode,
			now: at,
			staleMs,
		});
		if (decision.own) {
			owned = true;
			claim(at);
			if (announce) {
				announce = false;
				opts.onRegain?.();
			}
			return;
		}
		if (owned) {
			owned = false;
			announce = true;
			opts.onLost?.();
		}
	};

	const timer = setInterval(beat, heartbeatMs);
	// A heartbeat must never be a reason for pi to stay alive.
	timer.unref?.();

	tracked.set(trackedKey(opts.file, pid), { file: opts.file, pid });

	return {
		get owned() {
			return owned;
		},
		get record() {
			return record;
		},
		stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			const key = trackedKey(opts.file, pid);
			const t = tracked.get(key);
			if (t) {
				tracked.delete(key);
				releaseSync(t);
			}
		},
	};
}
