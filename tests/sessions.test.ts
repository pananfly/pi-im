// tests/sessions.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	encodeCwdSubdir,
	listWorkspaceSessionsSync,
	samePath,
} from "../src/config.js";

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-im-sess-"));
	const cwd = "/Users/pan/Documents/Project/pi-opencode-acp";
	const index = {
		version: 1,
		entries: {
			"/x/a.jsonl": {
				fp: { size: 10, mtimeMs: 2 },
				info: {
					path: "/x/a.jsonl",
					id: "aaaaaaaa-1111-2222-3333-444444444444",
					cwd,
					firstMessage: "hello world",
					created: "2026-08-27T14:04:13.253Z",
					modified: "2026-08-27T14:05:00.000Z",
				},
			},
			"/x/b.jsonl": {
				fp: { size: 10, mtimeMs: 1 },
				info: {
					path: "/x/b.jsonl",
					id: "bbbbbbbb-1111-2222-3333-444444444444",
					cwd,
					firstMessage: "second session",
					created: "2026-08-27T14:04:29.644Z",
					modified: "2026-08-27T14:04:30.000Z",
				},
			},
			"/x/other.jsonl": {
				fp: { size: 10, mtimeMs: 3 },
				info: {
					path: "/x/other.jsonl",
					id: "cccccccc-1111-2222-3333-444444444444",
					cwd: "/Users/pan/Documents/Project/pi-im",
					firstMessage: "other ws",
					created: "2026-08-27T14:04:29.644Z",
					modified: "2026-08-27T14:06:00.000Z",
				},
			},
		},
	};
	writeFileSync(join(dir, "pi-web-session-index.json"), JSON.stringify(index));
	return dir;
}

describe("listWorkspaceSessionsSync", () => {
	it("filters by cwd and sorts newest first", () => {
		const dir = makeAgentDir();
		const rows = listWorkspaceSessionsSync(
			"/Users/pan/Documents/Project/pi-opencode-acp",
			dir,
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.id).toContain("aaaaaaaa");
		expect(rows[0]?.title).toBe("hello world");
		expect(rows[0]?.file).toBe("/x/a.jsonl");
	});

	it("falls back to subdir scan when index is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-im-sess-fb-"));
		const cwd = "/tmp/demo-proj";
		const sub = join(dir, "sessions", encodeCwdSubdir(cwd));
		mkdirSync(sub, { recursive: true });
		writeFileSync(
			join(
				sub,
				"2026-08-27T14-04-13-253Z_01a04389-1845-7c6a-86b0-4dfeb58ade8a.jsonl",
			),
			'{"type":"session"}\n',
		);
		const rows = listWorkspaceSessionsSync(cwd, dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("01a04389-1845-7c6a-86b0-4dfeb58ade8a");
	});

	it("encodes cwd like pi sessions layout", () => {
		expect(encodeCwdSubdir("/Users/pan/Documents/Project/pi-im")).toBe(
			"--Users-pan-Documents-Project-pi-im--",
		);
		expect(encodeCwdSubdir("C:\\Users\\pan\\Project\\pi-im")).toBe(
			"--C--Users-pan-Project-pi-im--",
		);
	});

	it("normalizes like pi does before encoding", () => {
		// pi runs the cwd through path.resolve first, so a trailing separator or a
		// "." segment never reaches the sessions/<name>/ directory it writes.
		expect(encodeCwdSubdir("/tmp/proj/")).toBe("--tmp-proj--");
		expect(encodeCwdSubdir("/tmp/./proj")).toBe("--tmp-proj--");
		expect(encodeCwdSubdir("C:\\Users\\pan\\Project\\pi-im\\")).toBe(
			"--C--Users-pan-Project-pi-im--",
		);
		expect(encodeCwdSubdir("/")).toBe("----");
	});
});

describe("samePath", () => {
	it("matches equivalent spellings of one directory", () => {
		expect(samePath("/tmp/proj/", "/tmp/proj")).toBe(true);
		expect(samePath("/tmp/proj/../proj", "/tmp/proj")).toBe(true);
		expect(samePath("proj", "proj")).toBe(true);
	});

	it("does not match different or missing paths", () => {
		expect(samePath("/tmp/proj", "/tmp/other")).toBe(false);
		expect(samePath("/tmp/proj", undefined)).toBe(false);
		expect(samePath(undefined, "/tmp/proj")).toBe(false);
		// a relative and an absolute path are never assumed equal
		expect(samePath("proj", "/tmp/proj")).toBe(false);
	});
});

describe("listWorkspaceSessionsSync cwd matching", () => {
	it("finds sessions recorded under an equivalent cwd spelling", () => {
		const dir = makeAgentDir();
		const rows = listWorkspaceSessionsSync(
			"/Users/pan/Documents/Project/pi-opencode-acp/",
			dir,
		);
		expect(rows).toHaveLength(2);
	});
});
