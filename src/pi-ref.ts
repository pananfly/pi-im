// src/pi-ref.ts
//
// Holds the ExtensionAPI belonging to the CURRENT extension runtime.
//
// pi re-runs the extension factory on every session replacement
// (AgentSessionRuntime.newSession/switchSession -> teardownCurrent ->
// AgentSession.dispose -> ExtensionRunner.invalidate) and hands the factory a
// fresh API. The previous one is permanently poisoned: runtime.assertActive()
// throws on every call afterwards.
//
// The IM gateways live in process-global state and outlive any single factory
// invocation, so they must resolve the API through here at call time. Capturing
// the `pi` argument instead is what made pi crash on the first Telegram message
// after a TUI session switch.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The API is unusable right now: pi is mid-swap, or has not finished loading.
 * Recoverable — the caller should tell the user to retry, not crash the host.
 */
export class StaleExtensionApiError extends Error {
	constructor(cause?: unknown) {
		super("本地 Pi 会话正在切换,请稍后重发这条消息。", { cause });
		this.name = "StaleExtensionApiError";
	}
}

/**
 * Whether `e` is pi reporting that the ExtensionAPI we hold has been
 * invalidated by a session replacement / reload.
 *
 * Only this justifies claiming "the session is switching". Any other SDK
 * failure has its own meaning and must keep it — swallowing them all is what
 * made an ordinary "agent is already processing" collision show up as a
 * session swap that never happened.
 */
export function isStaleApiError(e: unknown): boolean {
	const message = e instanceof Error ? e.message : String(e);
	return (
		message.includes("extension ctx is stale") ||
		message.includes("ctx is stale after session replacement")
	);
}

/** The last api proven to work. Never replaced by one that has not been proven. */
let current: ExtensionAPI | null = null;
/** The newest api handed to the factory; it may not be bound to a session yet. */
let candidate: ExtensionAPI | null = null;

/**
 * Move `candidate` to `current` once the host has actually bound it.
 *
 * pi creates a fresh runtime per load path and only replaces the throwing stubs
 * in `runner.bindCore`, which runs after the factory. So the api the factory is
 * handed may never be bound at all. Probing is the only way to tell "not yet"
 * from "never", and `getActiveTools` is a safe probe: it is itself a stub before
 * bind, and returns a plain array afterwards.
 *
 * @returns whether `candidate` was promoted.
 */
function promoteCandidate(): boolean {
	if (!candidate) return false;
	try {
		candidate.getActiveTools?.();
	} catch (e) {
		// A disposed session never becomes usable again. Keeping it would mean
		// probing a corpse on every call, forever.
		if (isStaleApiError(e)) candidate = null;
		return false;
	}
	current = candidate;
	candidate = null;
	return true;
}

/**
 * Offer the newest API. Called on every factory invocation.
 *
 * Publishing it unconditionally is what bricked the IM gateway: during a session
 * swap the factory hands us an api whose actions still throw, the gateway
 * survives on globalThis, and from then on every message hit a dead runtime.
 */
export function setCurrentPi(pi: ExtensionAPI): void {
	candidate = pi;
	promoteCandidate();
}

/**
 * Drop both slots.
 *
 * Test-only: `current` is process-global by design (the gateway outlives every
 * session), which means one test's api would otherwise satisfy the next test's
 * lookup and hide exactly the fallback behaviour these tests exist to pin.
 */
export function __resetCurrentPiForTests(): void {
	current = null;
	candidate = null;
}

export function hasCurrentPi(): boolean {
	return current !== null || candidate !== null;
}

/**
 * The live ExtensionAPI, resolved at call time.
 *
 * Prefer this over capturing the `pi` a long-lived object was built with:
 * attachRuntime() and the IM gateways outlive any single factory invocation.
 *
 * @throws StaleExtensionApiError when no factory run has bound an api yet.
 * A poisoned api is not detectable here — the caller's own call throws, so
 * call sites map that through isStaleCtxError / StaleExtensionApiError.
 */
export function getCurrentPi(): ExtensionAPI {
	promoteCandidate();
	const api = current ?? candidate;
	if (!api) throw new StaleExtensionApiError();
	return api;
}

/**
 * Send a user message through the current API.
 *
 * @throws StaleExtensionApiError only when the API is missing or genuinely
 * invalidated. Every other failure propagates untouched, so the caller can
 * tell a busy session apart from a swapped one.
 */
export function sendViaCurrentPi(
	prompt: string,
	deliverAs?: "steer" | "followUp",
): void {
	const api = getCurrentPi();
	try {
		if (deliverAs) api.sendUserMessage(prompt, { deliverAs });
		else api.sendUserMessage(prompt);
	} catch (e) {
		if (isStaleApiError(e)) {
			current = null;
			throw new StaleExtensionApiError(e);
		}
		throw e;
	}
}

/**
 * The loader's pre-bind stub message. Matched on a substring because pi does
 * not export the error type — it is a bare `new Error(...)`.
 */
const RUNTIME_NOT_READY = "Extension runtime not initialized";

export function isRuntimeNotReadyError(e: unknown): boolean {
	return (e instanceof Error ? e.message : String(e)).includes(
		RUNTIME_NOT_READY,
	);
}

/**
 * No ExtensionAPI could actually run a message: either none was ever bound, or
 * the only candidate is still an unbound loading stub.
 *
 * Deliberately distinct from StaleExtensionApiError: a swap resolves on its own
 * within seconds, whereas this does not. Telling the user to "wait and resend"
 * here is what made the failure look inexplicable.
 */
export class RuntimeNotReadyError extends Error {
	constructor(cause?: unknown) {
		super("Pi 会话尚未就绪。", { cause });
		this.name = "RuntimeNotReadyError";
	}
}

/** How long to keep waiting out the loading window before giving up on a message. */
const READY_TIMEOUT_MS = 5_000;
const READY_MIN_DELAY_MS = 25;
const READY_MAX_DELAY_MS = 250;

export interface ReadyRetryOptions {
	/** Total budget before a RuntimeNotReadyError is raised. */
	timeoutMs?: number;
	/** Injected so the tests do not spend real time sleeping. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Send a user message, waiting out the window where pi has run the extension
 * factory but has not yet bound the runtime's action methods.
 *
 * The gateway is a process-global singleton, so a message can arrive while the
 * newest api is still an unbound stub. Waiting is the only correct response: the
 * stub throws before doing anything, so the message was never delivered and a
 * retry cannot duplicate the turn. A previously working api is preferred over
 * waiting at all (see setCurrentPi) — this only matters when there is nothing
 * usable to fall back to.
 *
 * Only this one condition is retried. A stale api does not become un-stale by
 * waiting, and every other failure (rate limit, network) means what it says —
 * swallowing those into a silent retry would hide them for the whole budget.
 *
 * @throws RuntimeNotReadyError once the budget runs out, or immediately for any
 * condition that waiting cannot fix.
 */
export async function sendViaCurrentPiWhenReady(
	prompt: string,
	opts: ReadyRetryOptions = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
	const now = opts.now ?? (() => Date.now());
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + timeoutMs;
	let delay = READY_MIN_DELAY_MS;
	for (;;) {
		try {
			sendViaCurrentPi(prompt);
			return;
		} catch (e) {
			if (!isRuntimeNotReadyError(e)) throw e;
			if (now() >= deadline) throw new RuntimeNotReadyError(e);
			await sleep(delay);
			delay = Math.min(delay * 2, READY_MAX_DELAY_MS);
		}
	}
}
