// src/remote-commands.ts
export interface ParsedRemoteCommand { name: string; args: string; }
const KNOWN = ["/help","/status","/version","/new","/stop","/steer","/compact","/history","/models","/model","/thinking","/reasoning","/workspace","/ws","/wsl","/sessionlist","/sessions","/session","/batch","/send","/cancel","/repair","/clear"];
export function parseRemoteCommand(input: string): ParsedRemoteCommand | undefined {
  const t = input.trim(); if (!t.startsWith("/")) return undefined;
  const i = t.search(/\s/); const name = (i === -1 ? t : t.slice(0, i)).toLowerCase();
  if (!KNOWN.includes(name)) return { name, args: i === -1 ? "" : t.slice(i + 1).trim() };
  return { name, args: i === -1 ? "" : t.slice(i + 1).trim() };
}
export function renderHelp(): string {
  return ["/help /status /version /new /stop /steer <文本> /compact /history [N] /models /model [序号|ID] /thinking [ID] (/reasoning) /workspace <路径|序号> (/ws) /wsl /sessionlist (/sessions) /session <ID|序号> /batch /send /cancel /repair /clear"].join("\n");
}
