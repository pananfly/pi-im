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
	it("parses Telegram group command with @bot", () => {
		expect(parseRemoteCommand("/status@my_pi_bot")).toEqual({
			name: "/status",
			args: "",
		});
		expect(parseRemoteCommand("/model@my_pi_bot 2")).toEqual({
			name: "/model",
			args: "2",
		});
	});
	it("parses Windows absolute workspace path", async () => {
		const { parseWorkspaceArg } = await import("../src/remote-commands.js");
		expect(parseWorkspaceArg("C:\\Projects\\my-repo", [])).toBe(
			"C:\\Projects\\my-repo",
		);
	});
	it("non-command", () => {
		expect(parseRemoteCommand("hello")).toBeUndefined();
	});
});
