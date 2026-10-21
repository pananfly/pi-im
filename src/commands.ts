// src/commands.ts
export type TuiCmd =
	| "setup"
	| "start"
	| "stop"
	| "status"
	| "config"
	| "logout"
	| "allow"
	| "deny"
	| "allowlist"
	/** Feishu only: the progress presentation for the next turn. */
	| "card"
	| "text"
	| "help";
export function parseTuiArgs(input: string): { cmd: TuiCmd; rest: string } {
	const t = input.trim().split(/\s+/);
	const c = (t[0] ?? "help").toLowerCase() as TuiCmd;
	return { cmd: c, rest: t.slice(1).join(" ") };
}
