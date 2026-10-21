// src/telegram/markdown-chunks.ts — split one answer into deliverable messages.
//
// Ported in spirit from dsh-im's `chunkMarkdownParts` (markdown-chunks.mjs),
// which splits at newline boundaries and keeps a code block or a GFM table
// whole whenever it fits. That guarantee is the whole point: cutting a ``` run
// in half leaves Telegram rendering the remainder as prose, and cutting a table
// mid-row leaves it unaligned. A plain newline/space split (dsh-im's
// `splitMessageText`) does both.
//
// Telegram's cap is 4096 *UTF-16 units*, not characters and not bytes: an emoji
// outside the BMP costs 2. JS string `.length` already counts UTF-16 units, so
// every limit below is compared against `.length` and every hard cut walks code
// points so a surrogate pair is never halved.

/** Telegram's hard per-message cap, in UTF-16 units. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Separator inserted where a chunk had to be cut mid-line. */
const CUT_MARKER = "\n…\n";

type Block =
	| { kind: "plain"; lines: string[] }
	| { kind: "fence"; open: string; body: string[]; close: string }
	| { kind: "table"; header: string[]; rows: string[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function utf16(text: string): number {
	return text.length;
}

function render(block: Block): string {
	if (block.kind === "plain") return block.lines.join("\n");
	if (block.kind === "fence")
		return block.open + block.body.join("\n") + block.close;
	return [...block.header, ...block.rows].join("\n");
}

/**
 * Cut to at most `limit` UTF-16 units without halving a surrogate pair.
 *
 * Code points are the unit of iteration and `.length` is the measure, so an
 * astral character at the boundary pushes the cut back one position rather than
 * producing a lone surrogate.
 */
export function hardCut(text: string, limit: number): string[] {
	const out: string[] = [];
	const points = Array.from(text);
	let offset = 0;
	while (offset < points.length) {
		let end = offset;
		let size = 0;
		while (end < points.length && size + points[end].length <= limit) {
			size += points[end].length;
			end += 1;
		}
		if (end === offset) {
			// A single code point wider than the limit: nothing can satisfy the
			// constraint, so emit it and let the caller notice the overshoot
			// rather than looping forever.
			out.push(points[end]);
			offset = end + 1;
			continue;
		}
		out.push(points.slice(offset, end).join(""));
		offset = end;
	}
	return out;
}

function isTableStart(lines: string[], i: number): boolean {
	const head = lines[i];
	const delim = lines[i + 1];
	if (!head?.includes("|") || !delim) return false;
	if (!TABLE_DELIMITER.test(delim)) return false;
	// A delimiter row must have at least as many cells as the header, otherwise
	// it is a horizontal rule sitting next to some prose.
	const cells = (line: string): number =>
		line
			.replace(/^\s*\|/, "")
			.replace(/\|\s*$/, "")
			.split("|").length;
	return cells(delim) >= cells(head);
}

function parseBlocks(text: string): Block[] {
	const lines = text.split("\n");
	const blocks: Block[] = [];
	let plain: string[] = [];
	const flushPlain = () => {
		if (plain.length > 0) {
			blocks.push({ kind: "plain", lines: plain });
			plain = [];
		}
	};
	let i = 0;
	while (i < lines.length) {
		const fence = FENCE_OPEN.exec(lines[i]);
		if (fence) {
			flushPlain();
			const marker = fence[1];
			const open = `${fence[0]}\n`;
			const closer = new RegExp(
				`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`,
			);
			const body: string[] = [];
			let closed = false;
			i += 1;
			while (i < lines.length) {
				if (closer.test(lines[i])) {
					closed = true;
					i += 1;
					break;
				}
				body.push(lines[i]);
				i += 1;
			}
			blocks.push({
				kind: "fence",
				open,
				body,
				// An unterminated fence still has to render as code; synthesizing
				// the closing marker beats letting the tail spill out as prose.
				close: closed
					? `\n${"".padStart(marker.length, marker[0])}`
					: `\n${"".padStart(marker.length, marker[0])}`,
			});
			continue;
		}
		if (isTableStart(lines, i)) {
			flushPlain();
			const header = [lines[i], lines[i + 1]];
			const rows: string[] = [];
			i += 2;
			while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
				rows.push(lines[i]);
				i += 1;
			}
			blocks.push({ kind: "table", header, rows });
			continue;
		}
		plain.push(lines[i]);
		i += 1;
	}
	flushPlain();
	return blocks;
}

/**
 * Break one over-sized block into pieces that each fit.
 *
 * Every piece stays the same *kind* of thing, which is what makes the split
 * invisible: a fenced block's tail is re-fenced, and a table's tail is re-headed.
 */
function splitBlock(block: Block, limit: number): string[] {
	if (block.kind === "plain") {
		const out: string[] = [];
		let current: string[] = [];
		let size = 0;
		for (const line of block.lines) {
			if (utf16(line) + 1 > limit) {
				// One line cannot fit at all; cut it on code points and keep the
				// surrounding lines as their own chunk.
				if (current.length > 0) {
					out.push(current.join("\n"));
					current = [];
					size = 0;
				}
				out.push(...hardCut(line, limit - CUT_MARKER.length));
				continue;
			}
			const next = size === 0 ? utf16(line) : size + 1 + utf16(line);
			if (next > limit) {
				out.push(current.join("\n"));
				current = [line];
				size = utf16(line);
			} else {
				current.push(line);
				size = next;
			}
		}
		if (current.length > 0) out.push(current.join("\n"));
		return out;
	}
	if (block.kind === "fence") {
		const chrome = utf16(block.open) + utf16(block.close);
		const room = limit - chrome;
		if (room < 1) return hardCut(render(block), limit);
		const out: string[] = [];
		let current: string[] = [];
		let size = 0;
		for (const line of block.body) {
			if (utf16(line) + 1 > room) {
				if (current.length > 0) {
					out.push(block.open + current.join("\n") + block.close);
					current = [];
					size = 0;
				}
				for (const piece of hardCut(line, room)) {
					out.push(block.open + piece + block.close);
				}
				continue;
			}
			const next = size === 0 ? utf16(line) : size + 1 + utf16(line);
			if (next > room) {
				out.push(block.open + current.join("\n") + block.close);
				current = [line];
				size = utf16(line);
			} else {
				current.push(line);
				size = next;
			}
		}
		if (current.length > 0)
			out.push(block.open + current.join("\n") + block.close);
		return out;
	}
	// A table: repeat the header on every piece so each one still lines up.
	const headerSize = block.header.join("\n").length;
	const out: string[] = [];
	let rows: string[] = [];
	let size = 0;
	const flush = () => {
		if (rows.length === 0) return;
		out.push([...block.header, ...rows].join("\n"));
		rows = [];
		size = 0;
	};
	for (const row of block.rows) {
		const next = size === 0 ? utf16(row) : size + 1 + utf16(row);
		if (headerSize + 1 + next > limit) {
			flush();
			if (headerSize + 1 + utf16(row) > limit) {
				// Even a header plus this one row is over: cut the row itself with header.
				const rowPieces = hardCut(row, limit - headerSize - 1);
				for (const piece of rowPieces) {
					out.push([...block.header, piece].join("\n"));
				}
				continue;
			}
			rows = [row];
			size = utf16(row);
		} else {
			rows.push(row);
			size = next;
		}
	}
	flush();
	return out.length > 0 ? out : [block.header.join("\n")];
}

/**
 * Split `text` into chunks, each at most `limit` UTF-16 units.
 *
 * Greedy at block boundaries: a fence or table that fits is never touched, and
 * only the block that overflows gets divided. Nothing is dropped, so a long
 * answer arrives whole — as several messages instead of one truncated one.
 */
export function chunkMarkdown(
	text: string,
	limit: number = TELEGRAM_TEXT_LIMIT,
): string[] {
	const source = text.trim();
	if (!source) return [];
	if (utf16(source) <= limit) return [source];
	const out: string[] = [];
	let current: Block[] = [];
	let size = 0;
	const flush = () => {
		if (current.length === 0) return;
		out.push(render({ kind: "plain", lines: current.map(render) }));
		current = [];
		size = 0;
	};
	for (const block of parseBlocks(source)) {
		const piece = render(block);
		const next = size === 0 ? utf16(piece) : size + 1 + utf16(piece);
		if (next > limit && current.length > 0) flush();
		if (utf16(piece) <= limit) {
			size = current.length === 0 ? utf16(piece) : size + 1 + utf16(piece);
			current.push(block);
			continue;
		}
		flush();
		out.push(...splitBlock(block, limit));
	}
	flush();
	return out.filter((chunk) => chunk.length > 0);
}

// ── MarkdownV2 (opt-in) ─────────────────────────────────────────────────────

/**
 * Escape text for Telegram's MarkdownV2 parse mode.
 *
 * Off by default (`TelegramFileConfig.parseMode`): the escape set is large, and
 * switching an existing chat on turns every literal `_ * . -` in an answer into a
 * backslash. Callers opt in deliberately.
 *
 * The rules differ inside code. Outside, all of `_ * [ ] ( ) ~ ` > # + - = | {
 * } . !` and `\` must be escaped; inside an inline span or a fence only `\` and
 * the backtick may be, because Telegram rejects any other backslash there.
 */
export function escapeMarkdownV2(text: string): string {
	const lines = text.split("\n");
	let inFence: string | null = null;
	return lines
		.map((line) => {
			const fence = FENCE_OPEN.exec(line);
			if (inFence) {
				if (
					fence &&
					fence[1][0] === inFence[0] &&
					fence[1].length >= inFence.length
				) {
					inFence = null;
				}
				return line.replace(/([`\\])/g, "\\$1");
			}
			if (fence) {
				inFence = fence[1];
				return line.replace(/([`\\])/g, "\\$1");
			}
			// Outside code: full escape set, but backtick-delimited spans inside
			// the line only take the two code-safe characters.
			let out = "";
			let inCode = false;
			for (let i = 0; i < line.length; i += 1) {
				const ch = line[i];
				if (ch === "`") {
					inCode = !inCode;
					out += "`";
					continue;
				}
				out += inCode
					? ch.replace(/([`\\])/g, "\\$1")
					: ch.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
			}
			return out;
		})
		.join("\n");
}

/** Format `text` for the configured parse mode, then split it for delivery. */
export function chunkForTelegram(
	text: string,
	mode: "plain" | "markdownV2" | undefined,
	limit: number = TELEGRAM_TEXT_LIMIT,
): string[] {
	const source = mode === "markdownV2" ? escapeMarkdownV2(text) : text;
	// Escaping inflates the text, so measure the escaped form — the limit is a
	// post-parse-mode property of the bytes on the wire.
	return chunkMarkdown(source, limit);
}
