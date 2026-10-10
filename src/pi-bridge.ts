// src/pi-bridge.ts
export interface ProgressObserver { onText(t: string): void; onActivity(t: string): void; }
export class PiAgentBridge {
  private texts: string[] = [];
  private activities: string[] = [];
  private settled = false;
  private waiter: (() => void) | null = null;
  private cancelled = false;
  constructor(private send: (prompt: string) => Promise<void>) {}
  async run(text: string, observer: ProgressObserver): Promise<string> {
    this.texts = []; this.activities = []; this.settled = false; this.cancelled = false;
    await this.send(text);
    while (!this.settled && !this.cancelled) { await new Promise<void>((r) => { this.waiter = r; setTimeout(r, 50); }); }
    const out = [...this.activities.map((a) => `- ${a}`), ...this.texts].join("\n");
    observer.onText(out || "(空回复)");
    return out || "(空回复)";
  }
  cancel(_reason: string): void { this.cancelled = true; this.waiter?.(); }
  steer(_text: string): boolean { return false; }
  captureMessage(msg: { role?: string; content?: Array<{ type: string; text?: string }> }): void {
    if (msg.role !== "assistant") return;
    for (const c of msg.content ?? []) if (c.type === "text" && c.text) this.texts.push(c.text);
  }
  captureStreamingMessage(msg: unknown): void { this.captureMessage(msg as never); }
  captureToolStart(name: string): void { this.activities.push(`tool ${name}`); }
  captureToolEnd(): void {}
  settle(): void { this.settled = true; this.waiter?.(); }
}
