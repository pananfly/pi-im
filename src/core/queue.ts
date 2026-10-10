export class SerialMessageQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, number>();
  position(chatId: string): number { return this.pending.get(chatId) ?? 0; }
  enqueue(chatId: string, job: () => Promise<void> | void): Promise<void> {
    this.pending.set(chatId, (this.pending.get(chatId) ?? 0) + 1);
    const run = this.tail.then(async () => { await job(); }).finally(() => {
      const n = (this.pending.get(chatId) ?? 1) - 1;
      if (n <= 0) this.pending.delete(chatId); else this.pending.set(chatId, n);
    });
    this.tail = run;
    return run;
  }
  cancelChat(chatId: string): number { const n = this.pending.get(chatId) ?? 0; this.pending.delete(chatId); return n; }
  get size(): number { let s = 0; for (const v of this.pending.values()) s += v; return s; }
}
