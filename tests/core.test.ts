// tests/core.test.ts
import { describe, expect, it } from "vitest";
import { BatchCollector } from "../src/core/batch.js";
import { MessageDeduplicator } from "../src/core/dedup.js";
import { SerialMessageQueue } from "../src/core/queue.js";

describe("core", () => {
	it("queue runs serially", async () => {
		const q = new SerialMessageQueue();
		const order: number[] = [];
		await Promise.all([
			q.enqueue("a", () => {
				order.push(1);
			}),
			q.enqueue("a", () => {
				order.push(2);
			}),
		]);
		expect(order).toEqual([1, 2]);
	});
	it("dedup remembers", () => {
		const d = new MessageDeduplicator();
		expect(d.seen("m1")).toBe(false);
		d.mark("m1", Date.now());
		expect(d.seen("m1")).toBe(true);
	});
	it("batch caps at 10", () => {
		const b = new BatchCollector();
		b.start("chat1");
		for (let i = 0; i < 11; i++) b.collect("chat1", `t${i}`);
		expect(b.submit("chat1").split("\n")).toHaveLength(10);
	});
});
