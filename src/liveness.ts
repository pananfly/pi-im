// src/liveness.ts
export function livenessKey(): string {
	return "@agegr/pi-web/session-liveness/v1";
}

export interface PiWebLivenessProvider {
	/**
	 * pi-web matches a provider against a session by sessionId *or* sessionFile
	 * (see its SessionIdentity). Both are supplied here because pi-im can only
	 * read the id off the session manager, and pi-web's own id for a session it
	 * created is the one that shows up in `identities`.
	 *
	 * `sessionId` is required non-empty by pi-web's validateProvider(); when the
	 * manager has no id we fall back to `sessionFile`, which still matches.
	 */
	sessionId: string;
	sessionFile?: string;
	/**
	 * True only while a gateway is genuinely usable. Object existence is not
	 * enough: a channel left in place after its socket died would pin the
	 * session alive forever.
	 */
	isActive: () => boolean;
}

export function registerPiWebLiveness(
	provider: PiWebLivenessProvider,
): () => void {
	const store = globalThis as Record<PropertyKey, unknown>;
	const key = Symbol.for(livenessKey());
	const reg = store[key] as
		| {
				version?: number;
				register?: (p: {
					name: string;
					sessionId: string;
					sessionFile?: string;
					isActive: () => boolean;
				}) => () => void;
		  }
		| undefined;
	if (!reg || reg.version !== 1 || typeof reg.register !== "function")
		return () => {};
	const sessionId =
		typeof provider.sessionId === "string" && provider.sessionId.trim()
			? provider.sessionId
			: (provider.sessionFile ?? "");
	// pi-web throws on an empty sessionId and register() would propagate it out
	// of our session_start handler; without any identity there is nothing to
	// keep alive, so decline instead of registering a provider that can never
	// match.
	if (!sessionId) return () => {};
	try {
		return reg.register({
			name: "pi-im",
			sessionId,
			...(provider.sessionFile ? { sessionFile: provider.sessionFile } : {}),
			isActive: provider.isActive,
		});
	} catch {
		return () => {};
	}
}
