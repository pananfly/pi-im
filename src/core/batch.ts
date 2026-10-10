import { getStrings, type Locale } from "../i18n.js";

export class BatchCollector {
	private active = new Set<string>();
	private items = new Map<string, string[]>();
	constructor(private locale: Locale = "zh") {}
	setLocale(locale: Locale): void {
		this.locale = locale;
	}
	private get s() {
		return getStrings(this.locale);
	}
	start(chatId: string): string {
		this.active.add(chatId);
		this.items.set(chatId, []);
		return this.s.batchStart;
	}
	isActive(chatId: string): boolean {
		return this.active.has(chatId);
	}
	collect(chatId: string, text: string): string {
		if (!this.active.has(chatId)) return this.s.batchIdle;
		const arr = this.items.get(chatId) ?? [];
		if (arr.length >= 10) return this.s.batchFull;
		arr.push(text);
		this.items.set(chatId, arr);
		return this.s.batchCollected(arr.length);
	}
	submit(chatId: string): string {
		const arr = this.items.get(chatId) ?? [];
		this.active.delete(chatId);
		this.items.delete(chatId);
		return arr.join("\n");
	}
	cancel(chatId: string): boolean {
		const had = this.active.has(chatId);
		this.active.delete(chatId);
		this.items.delete(chatId);
		return had;
	}
}
