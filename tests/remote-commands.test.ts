// tests/remote-commands.test.ts
import { describe, expect, it } from "vitest";
import { parseRemoteCommand } from "../src/remote-commands.js";

describe("parse", () => {
	it("parses /model 2", () => {
		expect(parseRemoteCommand("/model 2")).toEqual({
			name: "/model",
			args: "2",
		});
	});
	it("non-command", () => {
		expect(parseRemoteCommand("hello")).toBeUndefined();
	});
});
