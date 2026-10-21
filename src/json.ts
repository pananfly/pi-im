import { readFile } from "node:fs/promises";

/** Parse a JSON file. Missing, unreadable, or corrupt input yields `fallback`. */
export async function readJson<T>(p: string, fb: T): Promise<T> {
	try {
		return JSON.parse(await readFile(p, "utf8")) as T;
	} catch {
		return fb;
	}
}
