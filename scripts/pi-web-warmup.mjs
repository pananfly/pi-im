export function buildWarmupBody(cwd) {
	return { cwd, type: "ensure_session" };
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
	const ok = await ready();
	if (!ok) {
		console.error("pi-web not ready");
		process.exit(1);
	}
	const res = await fetch(`http://${hostname}:${port}/api/agent/new`, {
		method: "POST",
		headers,
		body: JSON.stringify(buildWarmupBody(cwd)),
	});
	if (!res.ok) {
		console.error(`warmup failed: ${res.status} ${await res.text()}`);
		process.exit(1);
	}
	console.log(`warmed: ${await res.text()}`);
}
