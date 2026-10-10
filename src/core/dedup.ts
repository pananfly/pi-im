export class MessageDeduplicator {
  private ids = new Map<string, number>();
  constructor(private ttlMs = 12 * 3600 * 1000, private max = 5000) {}
  seen(id: string): boolean { const t = this.ids.get(id); if (t === undefined) return false; if (Date.now() - t > this.ttlMs) { this.ids.delete(id); return false; } return true; }
  mark(id: string, now = Date.now()): void { this.ids.set(id, now); if (this.ids.size > this.max) { const first = this.ids.keys().next().value as string; this.ids.delete(first); } }
}
