// tests/warmup.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWarmupBody,
	buildWarmupPlan,
	readHolderRecord,
	// @ts-expect-error - untyped .mjs helpers, runtime-tested
} from "../scripts/pi-web-warmup.mjs";

describe("warmup", () => {
	it("builds ensure_session", () => {
		expect(buildWarmupBody("/tmp/x")).toEqual({
			cwd: "/tmp/x",
			type: "ensure_session",
		});
	});

	it("resumes the recorded holder instead of minting a new session", () => {
		const plan = buildWarmupPlan({
			cwd: "/tmp/fallback",
			holder: { sessionId: "abc", cwd: "/tmp/chosen" },
		});
		expect(plan).toEqual({
			kind: "resume",
			sessionId: "abc",
			path: "/api/agent/abc",
			body: { type: "get_state" },
			fallbackCwd: "/tmp/chosen",
		});
	});

	it("opens the recorded cwd when there is no session to resume", () => {
		expect(
			buildWarmupPlan({ cwd: "/tmp/fallback", holder: { cwd: "/tmp/chosen" } }),
		).toEqual({
			kind: "ensure",
			path: "/api/agent/new",
			body: buildWarmupBody("/tmp/chosen"),
		});
		expect(buildWarmupPlan({ cwd: "/tmp/fallback" })).toEqual({
			kind: "ensure",
			path: "/api/agent/new",
			body: buildWarmupBody("/tmp/fallback"),
		});
	});

	it("reads the holder identity pi-im persisted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-warmup-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "{}\n");
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				holderSessionId: "abc",
				holderSessionFile: file,
				holderCwd: "/tmp/chosen",
			}),
		);
		expect(readHolderRecord({ PI_IM_DIR: dir })).toEqual({
			sessionId: "abc",
			sessionFile: file,
			cwd: "/tmp/chosen",
		});
	});

	it("drops a recorded session file that no longer exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-warmup-gone-"));
		writeFileSync(
			join(dir, "config.json"),
			JSON.stringify({
				holderSessionId: "abc",
				holderSessionFile: join(dir, "missing.jsonl"),
				holderCwd: "/tmp/chosen",
			}),
		);
		expect(readHolderRecord({ PI_IM_DIR: dir })).toEqual({
			sessionId: "abc",
			cwd: "/tmp/chosen",
		});
	});
});
