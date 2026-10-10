// src/pi-bridge.ts
export interface ProgressObserver {
	onText(t: string): void;
	onActivity(t: string): void;
}
export class PiAgentBridge {
	private texts: string[] = [];
	private activities: string[] = [];
	private settled = false;
	private waiter: (() => void) | null = null;
	private cancelled = false;
	private running = false;
	private observer: ProgressObserver | null = null;
	private steerPending: string[] = [];
	constructor(
		private send: (prompt: string) => Promise<void>,
		private steerSend?: (text: string) => Promise<boolean>,
	) {}
	async run(text: string, observer: ProgressObserver): Promise<string> {
		this.texts = [];
		this.activities = [];
		this.settled = false;
		this.cancelled = false;
		this.running = true;
		this.observer = observer;
		this.steerPending = [];
		await this.send(text);
		while (!this.settled && !this.cancelled) {
			await new Promise<void>((r) => {
				this.waiter = r;
				setTimeout(r, 50);
			});
		}
		this.running = false;
		this.observer = null;
		const out = [...this.activities.map((a) => `- ${a}`), ...this.texts].join(
			"\n",
		);
		observer.onText(out || "(空回复)");
		return out || "(空回复)";
	}
	isActive(): boolean {
		return this.running && !this.settled && !this.cancelled;
	}
	cancel(_reason: string): void {
		this.cancelled = true;
		this.running = false;
		this.waiter?.();
	}
	steer(text: string): boolean {
		if (!this.isActive()) return false;
		this.steerPending.push(text);
		if (this.steerSend) {
			void this.steerSend(text).catch(() => undefined);
			return true;
		}
		return true;
	}
	drainSteer(): string[] {
		const out = [...this.steerPending];
		this.steerPending = [];
		return out;
	}
	captureMessage(msg: {
		role?: string;
		content?: Array<{ type: string; text?: string }>;
	}): void {
		if (msg.role !== "assistant") return;
		for (const c of msg.content ?? [])
			if (c.type === "text" && c.text) {
				this.texts.push(c.text);
				try {
					this.observer?.onText(c.text);
				} catch {}
			}
	}
	captureStreamingMessage(msg: unknown): void {
		this.captureMessage(msg as never);
	}
	captureToolStart(name: string): void {
		this.activities.push(`tool ${name}`);
		try {
			this.observer?.onActivity(`tool ${name}`);
		} catch {}
	}
	captureToolEnd(): void {}
	settle(): void {
		this.settled = true;
		this.running = false;
		this.waiter?.();
	}
}
