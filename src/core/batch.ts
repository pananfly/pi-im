export class BatchCollector {
  private active = new Set<string>();
  private items = new Map<string, string[]>();
  start(chatId: string): string { this.active.add(chatId); this.items.set(chatId, []); return "批量输入已开启,后续纯文字将暂存最多10条,/send 提交,/cancel 取消。"; }
  isActive(chatId: string): boolean { return this.active.has(chatId); }
  collect(chatId: string, text: string): string {
    if (!this.active.has(chatId)) return "未进入批量输入模式。";
    const arr = this.items.get(chatId) ?? [];
    if (arr.length >= 10) return "已收录10条,请 /send 提交。";
    arr.push(text); this.items.set(chatId, arr);
    return arr.length >= 10 ? "已收录第10条,请 /send 提交。" : `已收录第${arr.length}条。`;
  }
  submit(chatId: string): string { const arr = this.items.get(chatId) ?? []; this.active.delete(chatId); this.items.delete(chatId); return arr.join("\n"); }
  cancel(chatId: string): boolean { const had = this.active.has(chatId); this.active.delete(chatId); this.items.delete(chatId); return had; }
}
