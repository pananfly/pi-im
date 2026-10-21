// src/feishu/card.ts — the "streaming_card" progress presentation.
//
// Ported from dsh-im (src/channels/feishu/feishu-cards.mjs): `stepStreamCard()`,
// `stepPanel()`, `processDetailsPanel()` and `splitStepStreamCardBlocks()`,
// including its GFM-table splitter. The card shell is the same:
//
//   { schema: '2.0', header: { title: plainText(t), template: 'blue' },
//     body: { elements } }
//
// Two collapsible panels (thinking, tool summary) above the answer, plus the
// two hard Feishu limits dsh-im discovered against a live bot — a ~30KB card
// and at most 5 rendered tables — which turn into a list of cards rather than a
// single one: overflow spills into extra messages instead of being rejected
// whole, which would freeze the card on its previous content.
//
// Unlike dsh-im's LIVE_COT this does not use cardkit streaming
// (createCardInstance / updateCardElementContent / finishStreamingCard with
// sequence numbers). dsh-im's own `stepStreamCard` path patches whole cards
// too (`im.v1.message.patch`), so this is the same mechanism — just fewer
// moving parts.
//
// The panel expansion is config, not user state: dsh-im re-patches every card
// on each tick with `stepCardPanels`, so a manual expansion would snap shut
// anyway. Defaults copied from dsh-im (`DEFAULT_STEP_CARD_PANELS`): tool summary
// open while running, thinking folded. Once the turn ends nothing overwrites the
// card, so whatever the user left open stays open.

import { getStrings, type Locale, type Strings } from "../i18n.js";
import type { ToolRun } from "../pi-bridge.js";

/** One step in the turn's execution timeline. */
export type ProgressStep =
	| { kind: "thinking"; text: string; messageIndex?: number }
	| { kind: "tool"; tool: ToolRun };

/** Everything the card knows about the turn in flight. */
export interface ProgressState {
	/** Name of the tool currently running, e.g. "bash". */
	activity: string;
	/** Tool calls in the order they started. */
	tools: ToolRun[];
	/** Full text of each thinking block, oldest first. */
	thinking: string[];
	/** Chronological sequence of thinking and tool steps. */
	steps?: ProgressStep[];
	/** Latest assistant text. */
	text: string;
	/** The turn finished; the card is the final answer. */
	done: boolean;
	/** 1-based queue position while waiting for a free slot. */
	queued?: number;
}

/** Maximum character length of a thinking block preview inside a card. */
export const MAX_THINKING_CHARS_PER_BLOCK = 2000;

export function truncateThinking(text: string, notice: string): string {
	if (text.length <= MAX_THINKING_CHARS_PER_BLOCK) return text;
	return `${text.slice(0, MAX_THINKING_CHARS_PER_BLOCK)}\n\n${notice}`;
}

export interface FeishuCard {
	schema: "2.0";
	header?: { title: { tag: "plain_text"; content: string }; template: string };
	body: { elements: unknown[] };
}

/**
 * The unit the renderer accumulates, budgeted and spilled as a unit.
 *
 * `tools` / `notes` are the collapsible panels; `message` is everything else
 * (the streaming answer, the placeholder). Same three kinds as dsh-im.
 */
export type ProgressBlock =
	| { kind: "message"; text: string }
	| { kind: "tools"; lines: string[]; omitted?: number }
	| { kind: "notes"; lines: string[]; omitted?: number };

/** Most recent tool calls kept in the details panel; see `visibleTools`. */
const MAX_TOOL_ROWS = 12;
/** Tool durations below this are noise next to the network round trip. */
const MIN_SHOWN_DURATION_MS = 100;

/**
 * One card carries at most this many JSON bytes once serialized. Feishu caps
 * card content near 30KB, so stay lower to leave room for escaping.
 */
export const STEP_CARD_MAX_BYTES = 24_000;

/**
 * How many GFM tables one card may carry.
 *
 * pi-im never emits the `{tag:'table'}` component, so dsh-im's `5` — measured
 * against that component, whole card — is the wrong bound. What applies here is
 * the rich-text component's own limit: "a maximum of four tables can be placed
 * in a single rich text component". Every table pi-im renders comes from GFM
 * source inside a `markdown` element, so the cap is on that element, and
 * budgeting the card at the same number stays safely under it no matter how the
 * blocks land.
 *
 * The failure mode is silent-ish: the whole write is rejected, so the card stays
 * frozen on its previous content and the answer never appears.
 */
export const STEP_CARD_MAX_TABLES = 4;

/** dsh-im's defaults: the tool summary is the interesting part, open it. */
export const DEFAULT_STEP_CARD_PANELS: Readonly<StepCardPanels> = Object.freeze(
	{ thinkingExpanded: false, toolsExpanded: true },
);

export interface StepCardPanels {
	thinkingExpanded: boolean;
	toolsExpanded: boolean;
}

/**
 * Markdown body of an element.
 *
 * The tag must stay `markdown`: under `schema: '2.0'` Feishu rejects the whole
 * card with `ErrCode 200621 — type of element is not supported tag: lark_md`.
 * dsh-im's `markdown()` helper emits the 1.0 tag, which its cards survive only
 * because they do not declare `schema: '2.0'`; copying that tag here is what
 * took the first live card write down.
 */
function markdown(content: string): unknown {
	return { tag: "markdown", content };
}

/** `1.2s` / `3m 5s`, or "" when the call is too fast to be worth a column. */
export function formatDuration(ms: number | undefined): string {
	if (
		typeof ms !== "number" ||
		!Number.isFinite(ms) ||
		ms < MIN_SHOWN_DURATION_MS
	) {
		return "";
	}
	const secs = ms / 1000;
	if (secs < 60) return `${secs.toFixed(1)}s`;
	const mins = Math.floor(secs / 60);
	const rest = Math.round(secs % 60);
	if (mins < 60) return rest ? `${mins}m ${rest}s` : `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}

/**
 * One tool row: `✅ **bash** \`npm test\` · 1.2s`.
 *
 * A failure adds its first output line indented below. Successful results stay
 * out — full output belongs in pi-web, and a dozen `ls` listings would bury the
 * answer this card exists to deliver.
 */
export function toolRow(run: ToolRun): string {
	const mark = run.isError ? "❌" : "✅";
	const args = run.argsPreview ? ` \`${run.argsPreview}\`` : "";
	const duration = formatDuration(run.durationMs);
	const tail = duration ? ` · ${duration}` : "";
	const head = `${mark} **${run.name}**${args}${tail}`;
	return run.errorText
		? `${head}\n　${run.errorText.replace(/^/gm, "　")}`
		: head;
}

/**
 * Rows for the details panel: the most recent calls, plus any failure that
 * would otherwise be cut off.
 *
 * A failed call that scrolls out of view is the one thing the panel exists to
 * surface, so it is pulled back in — bounded, because a turn that failed twenty
 * times has bigger problems than card density.
 */
const MAX_RECOVERED_FAILURES = 3;

export function visibleTools(tools: ToolRun[]): {
	shown: ToolRun[];
	omitted: number;
} {
	if (tools.length <= MAX_TOOL_ROWS) return { shown: tools, omitted: 0 };
	const cut = tools.length - MAX_TOOL_ROWS;
	const elided = tools.slice(0, cut);
	const recovered = elided
		.filter((t) => t.isError)
		.slice(-MAX_RECOVERED_FAILURES);
	return {
		shown: [...recovered, ...tools.slice(cut)],
		omitted: elided.length - recovered.length,
	};
}

/** Turn state into the three block kinds the renderer budgets and spills. */
export function buildProgressBlocks(
	state: ProgressState,
	locale: Locale = "zh",
): ProgressBlock[] {
	const s = getStrings(locale);
	const blocks: ProgressBlock[] = [];

	if (state.steps && state.steps.length > 0) {
		type StepGroup =
			| { kind: "thinking"; items: string[] }
			| { kind: "tool"; items: ToolRun[] };

		const groups: StepGroup[] = [];
		for (const step of state.steps) {
			const lastGroup = groups.at(-1);
			if (step.kind === "thinking") {
				const text = step.text.trim();
				if (!text) continue;
				if (lastGroup && lastGroup.kind === "thinking") {
					lastGroup.items.push(text);
				} else {
					groups.push({ kind: "thinking", items: [text] });
				}
			} else if (step.kind === "tool") {
				if (lastGroup && lastGroup.kind === "tool") {
					lastGroup.items.push(step.tool);
				} else {
					groups.push({ kind: "tool", items: [step.tool] });
				}
			}
		}

		for (const group of groups) {
			if (group.kind === "thinking") {
				const lines = group.items.map((t, i) => {
					const truncated = truncateThinking(t, s.cardTruncated);
					return group.items.length > 1
						? `**${s.cardThinkingPart(i + 1)}**\n${truncated}`
						: truncated;
				});
				blocks.push({ kind: "notes", lines });
			} else {
				const { shown, omitted } = visibleTools(group.items);
				const rows = shown.map(toolRow);
				if (omitted > 0) rows.unshift(s.cardToolsOmitted(omitted));
				blocks.push({ kind: "tools", lines: rows, omitted });
			}
		}
	} else {
		const thinking = state.thinking.filter((t) => t.trim());
		if (thinking.length > 0) {
			blocks.push({
				kind: "notes",
				lines: thinking.map((t, i) => {
					const truncated = truncateThinking(t, s.cardTruncated);
					return thinking.length > 1
						? `**${s.cardThinkingPart(i + 1)}**\n${truncated}`
						: truncated;
				}),
			});
		}

		if (state.tools.length > 0) {
			const { shown, omitted } = visibleTools(state.tools);
			const rows = shown.map(toolRow);
			if (omitted > 0) rows.unshift(s.cardToolsOmitted(omitted));
			blocks.push({ kind: "tools", lines: rows, omitted });
		}
	}

	const answer = state.text.trim();
	blocks.push({
		kind: "message",
		text: answer || (state.done ? s.cardNoReply : s.cardWorkingBusy),
	});
	return blocks;
}

// ── Rendering (port of stepStreamCard / stepPanel / processDetailsPanel) ─────

export type CardStatus = "running" | "done" | "sealed";

export interface StepCardOptions {
	status: CardStatus;
	locale?: Locale;
	panels?: StepCardPanels;
	/** Defaults to the neutral "task process" header; the turn supplies its own. */
	header?: { title: string; template: string };
}

/** The collapsible grey panel used for tool summaries and thinking notes. */
function stepPanel(
	lines: string[],
	{ title, expanded }: { title: string; expanded: boolean },
): unknown {
	return {
		tag: "collapsible_panel",
		expanded,
		background_color: "grey-50",
		border: { color: "grey", corner_radius: "8px" },
		padding: "8px 8px 8px 8px",
		header: {
			title: { tag: "plain_text", content: title },
			vertical_align: "center",
			padding: "8px 8px 8px 8px",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px",
			},
			icon_position: "right",
			icon_expanded_angle: -180,
		},
		elements: [markdown(lines.join("\n"))],
	};
}

export function stepStreamCard(
	blocks: ProgressBlock[],
	{ status, locale = "zh", panels, header }: StepCardOptions,
): FeishuCard {
	const s = getStrings(locale);
	const running = status === "running";
	const config = panels ?? DEFAULT_STEP_CARD_PANELS;
	const elements: unknown[] = [];
	const panelElements: unknown[] = [];
	for (const block of blocks) {
		if (block.kind === "tools" || block.kind === "notes") {
			const lines = block.lines.filter((l) => l.trim());
			if (lines.length === 0) continue;
			const count = lines.length + (block.omitted ?? 0);
			const panel = stepPanel(lines, {
				title:
					block.kind === "tools"
						? s.cardProcess(count)
						: s.cardThinkingCount(count),
				// Finished cards keep every panel inside the collapsed wrapper.
				expanded:
					running &&
					(block.kind === "tools"
						? config.toolsExpanded
						: config.thinkingExpanded),
			});
			if (running) elements.push(panel);
			else panelElements.push(panel);
			continue;
		}
		const text = block.text.trim();
		if (text) elements.push(markdown(text));
	}
	if (!running && panelElements.length > 0) {
		elements.push(detailsPanel(panelElements, s));
	}
	if (status === "done") {
		elements.push(markdown(`---\n${s.cardCompletedNote}`));
	}
	// An element-less body renders as a blank box in Feishu.
	if (elements.length === 0) elements.push(markdown(" "));

	const h = header ?? { title: s.cardTask, template: "blue" };
	return {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: h.title },
			template: h.template,
		},
		body: { elements },
	};
}

/** The collapsed wrapper that holds the per-kind panels on finished cards. */
function detailsPanel(children: unknown[], s: Strings): unknown {
	return {
		tag: "collapsible_panel",
		expanded: false,
		background_color: "grey-50",
		border: { color: "grey", corner_radius: "8px" },
		padding: "8px 8px 8px 8px",
		header: {
			title: { tag: "plain_text", content: s.cardDetails },
			vertical_align: "center",
			padding: "8px 8px 8px 8px",
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				color: "grey",
				size: "16px 16px",
			},
			icon_position: "right",
			icon_expanded_angle: -180,
		},
		elements: children,
	};
}

// ── Budgeting (port of splitStepStreamCardBlocks) ───────────────────────────

function cardBytes(card: FeishuCard): number {
	return Buffer.byteLength(JSON.stringify(card), "utf8");
}

/**
 * The budget is measured against one shared estimate of the card chrome, so a
 * chunk measured as fitting really does fit whichever header it is finally
 * rendered with. The sealed title is the longest fixed one; the live title also
 * carries the running tool name, hence the headroom.
 */
const HEADER_HEADROOM_BYTES = 64;

function renderBytes(
	blocks: ProgressBlock[],
	locale: Locale,
	panels?: StepCardPanels,
): number {
	return (
		cardBytes(
			stepStreamCard(blocks, {
				status: "running",
				locale,
				panels,
				header: {
					title: getStrings(locale).cardTaskMore,
					template: "grey",
				},
			}),
		) + HEADER_HEADROOM_BYTES
	);
}

function hasClosingBacktickRun(text: string, start: number, length: number) {
	for (let index = start; index < text.length; ) {
		if (text[index] !== "`") {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (text[end] === "`") end += 1;
		if (end - index === length) return true;
		index = end;
	}
	return false;
}

function gfmTableCells(line: string): string[] | null {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (normalized.startsWith("    ") || normalized.startsWith("\t")) return null;
	const text = normalized.trim();
	if (!text) return null;

	const cells: string[] = [];
	let cell = "";
	let separators = 0;
	let codeRun = 0;
	for (let index = 0; index < text.length; ) {
		const character = text[index];
		if (character === "\\" && index + 1 < text.length) {
			cell += text.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (character === "`") {
			let end = index + 1;
			while (text[end] === "`") end += 1;
			const length = end - index;
			if (codeRun === length) {
				codeRun = 0;
			} else if (codeRun === 0 && hasClosingBacktickRun(text, end, length)) {
				codeRun = length;
			}
			cell += text.slice(index, end);
			index = end;
			continue;
		}
		if (character === "|" && codeRun === 0) {
			cells.push(cell);
			cell = "";
			separators += 1;
			index += 1;
			continue;
		}
		cell += character;
		index += 1;
	}
	if (separators === 0) return null;
	cells.push(cell);
	if (cells[0].trim() === "") cells.shift();
	if (cells.at(-1)?.trim() === "") cells.pop();
	return cells.length > 0 ? cells : null;
}

/** Locate table headers once for both counting and splitting. */
function markdownTableStarts(text: unknown): number[] {
	if (typeof text !== "string" || !text) return [];
	const lines = text.split("\n");
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	const starts: number[] = [];
	let fence: string | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].replace(/\r$/, "");
		if (fence) {
			const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
			if (close && close[1][0] === fence[0] && close[1].length >= fence.length)
				fence = null;
			continue;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (opening && (opening[1][0] !== "`" || !opening[2].includes("`"))) {
			fence = opening[1];
			continue;
		}
		const header = gfmTableCells(line);
		const delimiter = gfmTableCells(lines[index + 1] ?? "");
		if (
			!header ||
			!delimiter ||
			header.length !== delimiter.length ||
			!delimiter.every((cell) => /^\s*:?-+:?\s*$/.test(cell))
		)
			continue;
		starts.push(offsets[index]);
		index += 1;
		// A delimiter-looking data row is part of this table, not another header.
		while (index + 1 < lines.length && gfmTableCells(lines[index + 1]))
			index += 1;
	}
	return starts;
}

export function countMarkdownTables(text: unknown): number {
	return markdownTableStarts(text).length;
}

function splitMarkdownByTableLimit(text: string, maxTables: number): string[] {
	const starts = markdownTableStarts(text);
	const parts: string[] = [];
	let from = 0;
	for (let index = maxTables; index < starts.length; index += maxTables) {
		parts.push(text.slice(from, starts[index]));
		from = starts[index];
	}
	parts.push(text.slice(from));
	return parts;
}

function blockText(block: ProgressBlock): string {
	return block.kind === "message"
		? block.text
		: block.lines.filter((l) => l.trim()).join("\n");
}

/** Count the markdown that `stepStreamCard` actually renders. */
function cardTableCount(blocks: ProgressBlock[]): number {
	return blocks.reduce(
		(sum, block) => sum + countMarkdownTables(blockText(block)),
		0,
	);
}

/** Split display copies; the caller's logical blocks stay intact. */
export function splitBlockByTableLimit(
	block: ProgressBlock,
	maxTables: number = STEP_CARD_MAX_TABLES,
): ProgressBlock[] {
	if (!Number.isInteger(maxTables) || maxTables < 1) return [block];
	if (block.kind === "notes" || block.kind === "tools") {
		const lines = block.lines.filter((l) => l.trim());
		if (countMarkdownTables(lines.join("\n")) <= maxTables) return [block];
		const groups: string[][] = [];
		let current: string[] = [];
		for (const line of lines) {
			for (const part of splitMarkdownByTableLimit(line, maxTables)) {
				if (
					current.length &&
					countMarkdownTables([...current, part].join("\n")) > maxTables
				) {
					groups.push(current);
					current = [];
				}
				current.push(part);
			}
		}
		if (current.length) groups.push(current);
		return groups.map((group, index) => ({
			...block,
			lines: group,
			omitted: index === 0 ? (block.omitted ?? 0) : 0,
		}));
	}
	if (countMarkdownTables(block.text) <= maxTables) return [block];
	return splitMarkdownByTableLimit(block.text, maxTables).map((text) => ({
		...block,
		text,
	}));
}

/**
 * Shorten one indivisible unit — a single line or panel row — until its block
 * fits a card. Only reached when the unit alone blows the budget; everything
 * larger than that is split at line boundaries instead, so a long answer is
 * spilled into more cards rather than cut down to what one card holds.
 */
function fitUnit(
	unit: string,
	probe: (body: string) => ProgressBlock,
	locale: Locale,
	panels?: StepCardPanels,
): string {
	const notice = getStrings(locale).cardTruncated;
	let lo = 0;
	let hi = unit.length;
	let best = "";
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const candidate = `${unit.slice(0, mid)}\n${notice}`;
		if (
			renderBytes([probe(candidate)], locale, panels) <= STEP_CARD_MAX_BYTES
		) {
			best = candidate;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return best;
}

function splitTextBlock(
	block: { kind: "message"; text: string },
	locale: Locale,
	panels?: StepCardPanels,
): ProgressBlock[] {
	const probe = (body: string): ProgressBlock => ({ ...block, text: body });
	const fits = (body: string) =>
		renderBytes([probe(body)], locale, panels) <= STEP_CARD_MAX_BYTES;
	const out: ProgressBlock[] = [];
	let current: string[] = [];
	for (const line of block.text.split("\n")) {
		if (!fits(line)) {
			if (current.length) out.push(probe(current.join("\n")));
			current = [];
			const fitted = fitUnit(line, probe, locale, panels);
			if (fitted) out.push(probe(fitted));
			continue;
		}
		if (current.length && !fits([...current, line].join("\n"))) {
			out.push(probe(current.join("\n")));
			current = [line];
			continue;
		}
		current.push(line);
	}
	if (current.length) out.push(probe(current.join("\n")));
	return out;
}

function splitPanelBlock(
	block: { kind: "tools" | "notes"; lines: string[]; omitted?: number },
	locale: Locale,
	panels?: StepCardPanels,
): ProgressBlock[] {
	const probe = (lines: string[], omitted = 0): ProgressBlock => ({
		...block,
		lines,
		omitted,
	});
	const fits = (lines: string[]) =>
		renderBytes([probe(lines)], locale, panels) <= STEP_CARD_MAX_BYTES;
	const out: ProgressBlock[] = [];
	let current: string[] = [];
	let dropped = block.omitted ?? 0;
	const flush = () => {
		if (current.length) out.push(probe(current, dropped));
		current = [];
		dropped = 0;
	};
	for (const line of block.lines) {
		if (!fits([line])) {
			flush();
			const fitted = fitUnit(line, (t) => probe([t]), locale, panels);
			if (fitted) out.push(probe([fitted]));
			else dropped += 1;
			continue;
		}
		if (current.length && !fits([...current, line])) {
			flush();
			current = [line];
			continue;
		}
		current.push(line);
	}
	flush();
	return out;
}

/**
 * A single block can be larger than a whole card — one long answer, a runaway
 * tool output. Splitting between blocks cannot help, so the block itself is cut
 * at line boundaries, which is what keeps every card under the API limit
 * without losing the tail the way a flat character cap would.
 */
function splitBlockToBudget(
	block: ProgressBlock,
	locale: Locale,
	panels?: StepCardPanels,
): ProgressBlock[] {
	if (renderBytes([block], locale, panels) <= STEP_CARD_MAX_BYTES)
		return [block];
	return block.kind === "message"
		? splitTextBlock(block, locale, panels)
		: splitPanelBlock(block, locale, panels);
}

/**
 * Split accumulated blocks into card-sized chunks at block boundaries,
 * budgeted by the encoded running card (the largest render) **and** by the table
 * count, because a card accepts only a handful of tables no matter how small it
 * is. Every chunk keeps at least one block, so progress is never dropped. The
 * caller renders all but the last chunk as `sealed` and the last one live.
 */
export function splitStepCardBlocks(
	blocks: ProgressBlock[],
	locale: Locale = "zh",
	panels?: StepCardPanels,
	limit: number = STEP_CARD_MAX_BYTES,
	maxTables: number = STEP_CARD_MAX_TABLES,
): ProgressBlock[][] {
	const list = blocks
		.flatMap((block) => splitBlockByTableLimit(block, maxTables))
		.flatMap((block) => splitBlockToBudget(block, locale, panels));
	if (list.length === 0) return [];
	const chunks: ProgressBlock[][] = [];
	let current: ProgressBlock[] = [];
	for (const block of list) {
		const trial = [...current, block];
		const tooLarge = renderBytes(trial, locale, panels) > limit;
		const tooManyTables = cardTableCount(trial) > maxTables;
		if (current.length > 0 && (tooLarge || tooManyTables)) {
			chunks.push(current);
			current = [block];
		} else {
			current = trial;
		}
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** The live card's header: the turn's status, or a sealed marker for spill. */
export function liveHeader(
	state: ProgressState,
	locale: Locale = "zh",
): { title: string; template: string } {
	const s = getStrings(locale);
	const queued =
		typeof state.queued === "number" && state.queued > 1
			? s.cardQueued(state.queued)
			: "";
	if (state.done) return { title: s.cardDone, template: "green" };
	const title =
		queued ||
		(state.activity
			? `${s.cardWorking} ${state.activity}…`
			: s.cardWorkingBusy);
	// The card budget is measured once per tick against a fixed estimate of the
	// chrome, so a title that outgrows that estimate would break the budget it
	// was measured under.
	return { title: title.slice(0, 40), template: "blue" };
}

export const MAX_SPILL_CARDS = 3;

/**
 * Every card this turn needs, in order. The last one is live; the ones before
 * it are sealed spill chunks that no longer change, which is what lets a turn
 * that outgrows one card keep its whole answer instead of losing the tail.
 */
export function buildProgressCards(
	state: ProgressState,
	locale: Locale = "zh",
): FeishuCard[] {
	// While running, always return a single live card to prevent card spill notifications.
	if (!state.done) {
		const blocks = buildProgressBlocks(state, locale);
		const chunks = splitStepCardBlocks(blocks, locale);
		const liveChunk = chunks[0] ?? [];
		return [
			stepStreamCard(liveChunk, {
				status: "running",
				locale,
				header: liveHeader(state, locale),
			}),
		];
	}

	const s = getStrings(locale);
	const blocks = buildProgressBlocks(state, locale);
	let chunks = splitStepCardBlocks(blocks, locale);

	// Enforce maximum spill cards limit upon completion
	if (chunks.length > MAX_SPILL_CARDS) {
		chunks = chunks.slice(0, MAX_SPILL_CARDS);
		const lastChunk = chunks[MAX_SPILL_CARDS - 1];
		const lastBlock = lastChunk?.at(-1);
		if (lastBlock && lastBlock.kind === "message") {
			lastBlock.text += `\n\n${s.cardTruncated}`;
		}
	}

	const last = chunks.length - 1;
	return chunks.map((chunk, index) =>
		stepStreamCard(chunk, {
			status: index === last ? "done" : "sealed",
			locale,
			header:
				index === last
					? liveHeader(state, locale)
					: { title: s.cardTaskMore, template: "grey" },
		}),
	);
}

/** Back-compat single-card view; drops anything that would have spilled. */
export function buildProgressCard(
	state: ProgressState,
	locale: Locale = "zh",
): FeishuCard {
	return (
		buildProgressCards(state, locale)[0] ?? {
			schema: "2.0",
			header: { title: { tag: "plain_text", content: "" }, template: "blue" },
			body: { elements: [] },
		}
	);
}
