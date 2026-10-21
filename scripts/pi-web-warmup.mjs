import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piImDir(env = process.env) {
	const override = env.PI_IM_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent", "pi-im");
}

/**
 * The holder identity pi-im records on its own side.
 *
 * Warmup used to always create a brand-new session in `--cwd`, which is why a
 * restart forgot the workspace the user had picked over IM. The record lets the
 * boot open the same session (or at least the same directory) instead.
 */
export function readHolderRecord(env = process.env) {
	try {
		const cfg = JSON.parse(
			readFileSync(join(piImDir(env), "config.json"), "utf8"),
		);
		return {
			...(typeof cfg.holderSessionId === "string" && cfg.holderSessionId
				? { sessionId: cfg.holderSessionId }
				: {}),
			...(typeof cfg.holderSessionFile === "string" &&
			cfg.holderSessionFile &&
			existsSync(cfg.holderSessionFile)
				? { sessionFile: cfg.holderSessionFile }
				: {}),
			...(typeof cfg.holderCwd === "string" && cfg.holderCwd
				? { cwd: cfg.holderCwd }
				: {}),
		};
	} catch {
		return {};
	}
}

export function buildWarmupBody(cwd) {
	return { cwd, type: "ensure_session" };
}

/**
 * Turn the recorded holder (or `--cwd`) into one HTTP request.
 *
 * Resume first: it restores the actual conversation, not just the directory.
 * `kind: "ensure"` is the fallback for a profile with no record, or for a
 * resume the server rejects (deleted/never-indexed session file) — warmup then
 * still opens the workspace directory rather than failing the whole boot.
 */
export function buildWarmupPlan({ cwd, holder = {} }) {
	const holderCwd =
		typeof holder.cwd === "string" && holder.cwd ? holder.cwd : undefined;
	if (typeof holder.sessionId === "string" && holder.sessionId) {
		return {
			kind: "resume",
			sessionId: holder.sessionId,
			path: `/api/agent/${encodeURIComponent(holder.sessionId)}`,
			body: { type: "get_state" },
			fallbackCwd: holderCwd ?? cwd,
		};
	}
	return {
		kind: "ensure",
		path: "/api/agent/new",
		body: buildWarmupBody(holderCwd ?? cwd),
	};
}

export function parseArgs(argv) {
	const out = {
		port: process.env.PORT ?? "30141",
		hostname: "127.0.0.1",
		cwd: process.cwd(),
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") out.port = argv[++i];
		if (argv[i] === "--cwd") out.cwd = argv[++i];
		if (argv[i] === "--hostname") out.hostname = argv[++i];
	}
	return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
	const { port, hostname, cwd } = parseArgs(process.argv.slice(2));
	const password = process.env.PI_WEB_PASSWORD;
	const headers = { "Content-Type": "application/json" };
	if (password)
		headers.Authorization = `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
	const ready = async () => {
		for (let i = 0; i < 30; i++) {
			try {
				const r = await fetch(`http://${hostname}:${port}/api/agent/running`, {
					headers,
				});
				if (r.ok) return true;
			} catch {}
			await new Promise((r) => setTimeout(r, 2000));
		}
		return false;
	};
	const post = (path, body) =>
		fetch(`http://${hostname}:${port}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	const ok = await ready();
	if (!ok) {
		console.error("pi-web not ready");
		process.exit(1);
	}
	const holder = readHolderRecord();
	const plan = buildWarmupPlan({ cwd, holder });
	if (plan.kind === "resume") {
		const res = await post(plan.path, plan.body);
		if (res.ok) {
			console.log(`resumed holder ${plan.sessionId}: ${await res.text()}`);
			process.exit(0);
		}
		console.warn(
			`resume of ${plan.sessionId} failed (${res.status}); opening ${plan.fallbackCwd} instead`,
		);
	}
	// `ensure` plans, and a failed resume, both end here.
	const fallbackCwd = plan.kind === "resume" ? plan.fallbackCwd : plan.body.cwd;
	const res = await post("/api/agent/new", buildWarmupBody(fallbackCwd));
	if (!res.ok) {
		console.error(`warmup failed: ${res.status} ${await res.text()}`);
		process.exit(1);
	}
	console.log(`warmed: ${await res.text()}`);
}
