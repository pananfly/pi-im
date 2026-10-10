// src/liveness.ts
export function livenessKey(): string { return "@agegr/pi-web/session-liveness/v1"; }
export function registerPiWebLiveness(sessionId: string, isActive: () => boolean): () => void {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(livenessKey());
  const reg = store[key] as { version?: number; register?: (p: { name: string; sessionId: string; isActive: () => boolean }) => () => void } | undefined;
  if (!reg || reg.version !== 1 || typeof reg.register !== "function") return () => {};
  try { return reg.register({ name: "pi-im", sessionId, isActive }); } catch { return () => {}; }
}
