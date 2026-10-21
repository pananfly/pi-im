// tests/setup.ts
//
// pi-im now seeds the holder from `config.json` on startup. Without an isolated
// PI_IM_DIR the tests would read (and write) the developer's real
// ~/.pi/agent/pi-im/config.json, so a stale holder there could silently decide
// which fake session gets adopted. Every test starts with its own empty profile;
// tests that need a specific directory still override it themselves.
//
// The base directory is claimed here, at module scope, and not only in
// beforeEach: `src/ui-bridge.ts` writes a `bridge:boot` line the moment it is
// evaluated, which happens while the test file's imports are collected — before
// any hook runs. Left unset until then, those lines landed in the real
// ~/.pi/agent/pi-im/debug.log, where a stray `bridge:boot` reads exactly like
// the host having reloaded the extension. setupFiles run before the test module
// is imported, so the assignment below is already in place by then.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

if (!process.env.PI_IM_DIR) {
	process.env.PI_IM_DIR = mkdtempSync(join(tmpdir(), "pi-im-test-boot-"));
}
const BASE = process.env.PI_IM_DIR;

let previous: string | undefined;

beforeEach(() => {
	previous = process.env.PI_IM_DIR;
	// A fresh directory per test still matters (dedup tables, config writes),
	// so only an explicit override made by the test file is left in place.
	if (!previous || previous === BASE) {
		process.env.PI_IM_DIR = mkdtempSync(join(tmpdir(), "pi-im-test-"));
	}
});

afterEach(() => {
	if (previous === undefined) delete process.env.PI_IM_DIR;
	else process.env.PI_IM_DIR = previous;
});
