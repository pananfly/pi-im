// src/ui-bridge.ts
//
// 把「宿主 UI 提问」搬到 IM 上回答。
//
// Ask the human a question through the chat channel instead of a dialog nobody
// is looking at.
//
// 背景:pi-web 里 `ask_user` 优先用 `ctx.ui.custom()` 渲染一个分栏面板,面板只是
// 一片渲染好的终端行,IM 侧既读不出选项也回不了答案;而没人看网页时,这一轮会
// 一直停在面板上。`ui.custom()` 返回 `undefined` 是 SDK 的 headless 语义,扩展
// (pi-ask-user 明确支持)会降级成 `select()` / `input()` 对话框——那两个是有结构
// 的,可以被转发成 IM 的文字,再原样回填。
//
// So: on a session IM drives, `custom()` declines and the dialogs come here.
// 只有 pi-im 自己那一次 IM 回合里的提问才会被接管(`runAsImTurn` 提供的上下文),
// 浏览器发起的回合不受影响,仍走 pi-web 的对话框/面板。进程里同时开着好几个会话
// 时,补丁记着自己是哪个会话的,兜底认领也只认那一轮(`ImSessionScope`)。

import { AsyncLocalStorage } from "node:async_hooks";
import { imDebug } from "./debug.js";
import { getStrings, type Locale } from "./i18n.js";
import { KNOWN, parseRemoteCommand } from "./remote-commands.js";

/**
 * 一个会话的身份,用来判断「这个提问属于隔壁会话吗」。
 *
 * 宿主给的两种身份都算:`file`(会话文件路径)和 `id`(会话 id)。新建的会话一开始
 * 只有 id、落盘后才有文件,所以两个都对上任意一个即可,都给不出时按不认识处理。
 */
export interface ImSessionScope {
	file?: string | null;
	id?: string | null;
}

/** 一次由 IM 发起的回合。UI 桥只在这样的回合里接管提问。 */
export interface ImTurn {
	channel: string;
	chatId: string;
	/** 群聊里只有 @ 机器人的消息才会被处理,提问要顺带说清楚。 */
	group?: boolean;
	/** 往这个 chat 发一条独立消息(不经过进度渲染器)。 */
	send: (chatId: string, text: string) => Promise<void>;
	locale: () => Locale;
	/**
	 * 这一轮驱动的是哪个会话。
	 *
	 * pi 的一个会话一个 UI 对象,而这里的兜底分支(拿不到 AsyncLocalStorage 时,
	 * 「此刻只有一个 IM 回合在跑,那就是它」)是进程级的:同一个 pi 进程里另一个
	 * 会话(Pi Web 的另一个标签页)的提问,在同一时刻也会满足「只有一个回合」。
	 * 带上会话身份后,兜底只认自己那一轮的提问,隔壁会话仍旧回它自己的面板。
	 */
	session?: ImSessionScope | null;
}

type PromptKind = "select" | "input" | "editor" | "confirm";

interface PendingPrompt {
	key: string;
	kind: PromptKind;
	options?: string[];
	/** Option that means "I want to type my own answer" (ask_user's freeform row). */
	freeform?: string;
	settle: (value: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
	reminderTimer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * 桥的状态挂在 globalThis 上,理由和 extension.ts 里的 `__piImShared__` 一样。
 *
 * 宿主会用新的 loader 实例重新求值扩展模块(切工作区、开新会话都会,pi-web 尤其
 * 频繁),那一刻本文件的模块级 Map 就有了两份:提问写进新的那份,回答却到旧的
 * 那份里查,永远匹配不上——表现就是「回了序号,机器人毫无反应,连提示都没有」。
 * 共享同一份状态后,不管哪一份实例挂起了提问,任何实例都能把它消化掉。
 */
interface BridgeState {
	/** 一个 chat 同时只挂一个问题。 */
	pending: Map<string, PendingPrompt>;
	/** 用户直接打的字,留给紧接着的 input 对话框。 */
	customAnswers: Map<string, { text: string; at: number }>;
	/**
	 * 兜底:工具执行链里若有某个回调脱离了 await 链(拿不到 AsyncLocalStorage),
	 * 只要此刻只有一个 IM 回合在跑,答案就是它。
	 */
	activeTurns: ImTurn[];
}

const BRIDGE_STATE_KEY = "__piImUiBridgeState__";

/**
 * 本份模块实例的短标识,只出现在调试日志里。
 *
 * 宿主重新求值扩展模块是这份状态必须共享的原因;日志里同一轮问答出现两个
 * 不同的 id,就说明这件事真的发生过。
 */
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);

const bridge: BridgeState = (() => {
	const store = globalThis as unknown as Record<
		string,
		BridgeState | undefined
	>;
	const existing = store[BRIDGE_STATE_KEY];
	if (existing) return existing;
	const created: BridgeState = {
		pending: new Map(),
		customAnswers: new Map(),
		activeTurns: [],
	};
	store[BRIDGE_STATE_KEY] = created;
	return created;
})();

const turnStore = new AsyncLocalStorage<ImTurn>();
const activeTurns = bridge.activeTurns;

// 每次模块被求值都记一笔:日志里出现两条 bridge:boot 就是宿主重新加载了扩展,
// 这正是「答案进不去同一个 pending」的那类故障的第一现场。
imDebug("bridge:boot", INSTANCE_ID, `pending=${bridge.pending.size}`);

export function runAsImTurn<T>(turn: ImTurn, fn: () => Promise<T>): Promise<T> {
	activeTurns.push(turn);
	return turnStore.run(turn, async () => {
		try {
			return await fn();
		} finally {
			const index = activeTurns.lastIndexOf(turn);
			if (index >= 0) activeTurns.splice(index, 1);
		}
	});
}

/** 当前正在跑的 IM 回合,没有则 undefined(浏览器/TUI 发起的回合)。 */
/**
 * True while any IM-driven turn is running.
 *
 * `session_start` uses it as a cheap "don't move the horse mid-race" test: taking
 * the holder away from a session that is answering would leave that turn's settle
 * and tool events unable to find their session back.
 */
export function hasActiveImTurn(): boolean {
	return activeTurns.length > 0;
}

export function currentImTurn(
	scope?: ImSessionScope | null,
): ImTurn | undefined {
	const direct = turnStore.getStore();
	if (direct) return direct;
	// 兜底是进程级的,只在不认识会话身份时才敢宽松地认领。
	if (activeTurns.length !== 1) return undefined;
	const only = activeTurns[0];
	return sameSessionScope(scope, only.session) ? only : undefined;
}

/**
 * 两个会话身份是否指向同一个会话。
 *
 * 任意一边说不清(宿主没给)就放行:宁可像以前那样把提问搬到聊天里,也不要让
 * 一轮 IM 提问因为身份对不上而卡在没人看的对话框上,一直等到超时。
 */
function sameSessionScope(
	a: ImSessionScope | null | undefined,
	b: ImSessionScope | null | undefined,
): boolean {
	if (!a || !b) return true;
	if (!a.file && !a.id) return true;
	if (!b.file && !b.id) return true;
	if (a.file && b.file && a.file === b.file) return true;
	if (a.id && b.id && a.id === b.id) return true;
	return false;
}

/** 新的提问会顶掉旧的(旧问题按取消处理)。 */
const pending = bridge.pending;

/** 没人回答时的兜底,避免这一轮永远停在提问上。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 一条消息里最多列出的选项数,超出的让用户直接回文字。 */
const MAX_LISTED_OPTIONS = 20;
/**
 * 用户直接打字当自定义答案时,先把文字存这里;紧接着的 input 对话框会被它
 * 直接回答,不再弹第二个几乎一样的问题。
 */
const CUSTOM_ANSWER_TTL_MS = 60_000;
const customAnswers = bridge.customAnswers;
/** 提醒只发一次,且别在刚发出问题几秒内就催。 */
const REMINDER_MIN_TIMEOUT_MS = 2 * 60 * 1000;

function isNumericAnswer(text: string): boolean {
	return /^[（(]?\d+[)）.、]?$/.test(
		text.replace(/[０-９]/g, (c) =>
			String.fromCharCode(c.charCodeAt(0) - 0xfee0),
		),
	);
}

/**
 * 识别 ask_user 之类扩展追加的「自己输入」占位项。
 *
 * 不同扩展的措辞不一样,所以只认带明确 "type ... custom/your" 或中文
 * 「自定义回答」的写法;普通选项(哪怕叫「其他」)不会被误判。
 */
export function isFreeformOption(option: string): boolean {
	const t = option.trim().toLowerCase();
	return (
		/^(?:[^\p{L}\p{N}]+)?type\s+(?:a\s+)?(?:custom|your\s+(?:own\s+)?(?:response|answer))/u.test(
			t,
		) || /^(?:[^\p{L}\p{N}]+)?(自定义回答|自己输入答案|输入自定义)/u.test(t)
	);
}

/** ask_user appends its freeform row last; only that position is trusted. */
function freeformOf(options: string[] | undefined): string | undefined {
	const last = options?.at(-1);
	return last !== undefined && isFreeformOption(last) ? last : undefined;
}

function keyOf(turn: ImTurn): string {
	return `${turn.channel}:${turn.chatId}`;
}

function settlePending(prompt: PendingPrompt, value: unknown): void {
	if (prompt.timer !== undefined) clearTimeout(prompt.timer);
	if (prompt.reminderTimer !== undefined) clearTimeout(prompt.reminderTimer);
	if (prompt.signal && prompt.onAbort) {
		prompt.signal.removeEventListener("abort", prompt.onAbort);
	}
	if (pending.get(prompt.key) === prompt) pending.delete(prompt.key);
	imDebug(
		"settle",
		INSTANCE_ID,
		prompt.key,
		prompt.kind,
		value === undefined ? "<cancel>" : value,
	);
	prompt.settle(value);
}

function yesNo(text: string): boolean | undefined {
	const t = text.trim().toLowerCase();
	if (["是", "对", "好", "确认", "yes", "y", "ok", "1", "true"].includes(t)) {
		return true;
	}
	if (["否", "不", "不是", "取消", "no", "n", "0", "false"].includes(t)) {
		return false;
	}
	return undefined;
}

/**
 * 用一条入站消息回答挂着的提问。
 *
 * 返回 true 表示这条消息被当作答案消化掉了,调用方不应再把它当成 prompt 发给
 * 模型。`/stop` 是例外:它先取消提问,再照常中断这一轮。
 */
export function consumeUiAnswer(
	channel: string,
	chatId: string,
	raw: string,
	locale: Locale,
	send: (chatId: string, text: string) => Promise<void>,
): boolean {
	const key = `${channel}:${chatId}`;
	const prompt = pending.get(key);
	if (!prompt) {
		// 落在这里通常意味着这条消息压根不该被当成答案(没有挂着的提问),
		// 但也可能是提问挂在了另一份模块实例的状态里——所以把键值记下来对账。
		imDebug("answer:no-pending", INSTANCE_ID, key, raw, pending.size);
		return false;
	}
	imDebug("answer", INSTANCE_ID, key, prompt.kind, raw);
	const s = getStrings(locale);
	const text = raw.trim();

	if (text === "/stop") {
		// 先让这一轮别再等答案,再交给 /stop 去中断运行。
		settlePending(prompt, undefined);
		return false;
	}
	if (text === "/cancel" || text.toLowerCase() === "esc") {
		settlePending(prompt, undefined);
		void send(chatId, s.uiCancelled).catch(() => undefined);
		return true;
	}
	// Any other known command is not an answer. Leave the question pending so
	// the user can check `/status` (or switch model) and then come back to it.
	const cmd = parseRemoteCommand(text);
	if (cmd && KNOWN.includes(cmd.name)) return false;

	if (prompt.kind === "confirm") {
		const answer = yesNo(text);
		if (answer === undefined) {
			void send(chatId, s.uiNeedYesNo).catch(() => undefined);
			return true;
		}
		settlePending(prompt, answer);
		void send(chatId, s.uiAnswered(answer ? s.uiYes : s.uiNo)).catch(
			() => undefined,
		);
		return true;
	}

	if (prompt.kind === "select") {
		const options = prompt.options ?? [];
		const visible = prompt.freeform
			? options.filter((o) => o !== prompt.freeform)
			: options;
		const picked = pickOption(visible, text);
		if (picked !== undefined) {
			settlePending(prompt, picked);
			void send(chatId, s.uiAnswered(picked)).catch(() => undefined);
			return true;
		}
		// 序号不在范围内:先指回序号,别把 "5" 当成自定义答案。
		if (isNumericAnswer(text) || !prompt.freeform) {
			void send(
				chatId,
				prompt.freeform
					? s.uiNeedNumberOrText(visible.length)
					: s.uiNeedNumber(visible.length),
			).catch(() => undefined);
			return true;
		}
		// 非数字、又没对上任何选项:这多半就是用户想自己写的答案。
		// 选掉「自己输入」占位项,并把文字留给紧接着的 input 对话框,
		// 这样不会再弹一个几乎一样的问题。
		customAnswers.set(key, { text, at: Date.now() });
		settlePending(prompt, prompt.freeform);
		void send(chatId, s.uiAnswered(text)).catch(() => undefined);
		return true;
	}

	// input / editor:整条消息就是答案。
	settlePending(prompt, text);
	void send(chatId, s.uiAnswered(text)).catch(() => undefined);
	return true;
}

/**
 * 把一条回复解析成选项。
 *
 * 先按 1-based 序号,再按选项文字(完整或前缀,忽略大小写)——手机上打一个数字
 * 最省事,但有人会直接把选项名复述回来。
 */
export function pickOption(
	options: string[],
	text: string,
): string | undefined {
	// 全角数字在中文输入法下很常见,别让 "2" 和 "2" 变成两种答案。
	const normalized = text.replace(/[０-９]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);
	const numeric = /^[（(]?(\d+)[)）.、]?$/.exec(normalized);
	if (numeric) {
		const index = Number(numeric[1]) - 1;
		return options[index];
	}
	text = normalized;
	const lower = text.toLowerCase();
	const exact = options.find((o) => o.trim().toLowerCase() === lower);
	if (exact !== undefined) return exact;
	const prefix = options.find((o) => o.trim().toLowerCase().startsWith(lower));
	if (prefix !== undefined && text.length >= 2) return prefix;
	return undefined;
}

function describePrompt(
	turn: ImTurn,
	prompt: {
		kind: PromptKind;
		title: string;
		options?: string[];
		message?: string;
		placeholder?: string;
	},
): string {
	const s = getStrings(turn.locale());
	const groupHint = turn.group ? `\n\n${s.uiGroupHint}` : "";
	if (prompt.kind === "select") {
		const options = prompt.options ?? [];
		const freeform = freeformOf(options);
		// 占位项在 IM 里没有意义:把它藏起来,改成"直接回文字就是自定义答案"。
		const visible = freeform ? options.slice(0, -1) : options;
		const listed = visible.slice(0, MAX_LISTED_OPTIONS);
		const list = listed.map((o, i) => `${i + 1}) ${o}`).join("\n");
		const more =
			visible.length > listed.length
				? `\n${s.uiMoreOptions(visible.length - listed.length)}`
				: "";
		const hint = freeform
			? s.uiPickOrText(visible.length)
			: s.uiPickHint(visible.length);
		return `${s.uiAskSelect(prompt.title, `${list}${more}`, hint)}${groupHint}`;
	}
	if (prompt.kind === "confirm") {
		return `${s.uiAskConfirm(prompt.title, prompt.message ?? "")}${groupHint}`;
	}
	return `${s.uiAskText(prompt.title, prompt.placeholder ?? "")}${groupHint}`;
}

interface AskRequest {
	kind: PromptKind;
	title: string;
	message?: string;
	placeholder?: string;
	options?: string[];
	timeout?: number;
	signal?: AbortSignal;
}

function askViaIm(turn: ImTurn, request: AskRequest): Promise<unknown> {
	const s = getStrings(turn.locale());
	const key = keyOf(turn);
	// 上一个问题还没答就来了新的:按取消处理,别让两个问题抢同一条回复。
	const previous = pending.get(key);
	if (previous) settlePending(previous, undefined);

	// 用户刚才直接把自定义答案写在select的回复里:这次input不用再问。
	if (request.kind === "input" || request.kind === "editor") {
		const stashed = customAnswers.get(key);
		if (stashed) {
			customAnswers.delete(key);
			if (Date.now() - stashed.at <= CUSTOM_ANSWER_TTL_MS) {
				return Promise.resolve(stashed.text);
			}
		}
	} else {
		// 新的选择题/确认意味着上一轮的自定义答案已经用不上了。
		customAnswers.delete(key);
	}

	return new Promise<unknown>((resolve) => {
		const prompt: PendingPrompt = {
			key,
			kind: request.kind,
			...(request.options ? { options: request.options } : {}),
			...(request.kind === "select" && freeformOf(request.options)
				? { freeform: freeformOf(request.options) }
				: {}),
			settle: resolve,
		};
		if (request.signal) {
			if (request.signal.aborted) {
				resolve(undefined);
				return;
			}
			prompt.signal = request.signal;
			prompt.onAbort = () => settlePending(prompt, undefined);
			request.signal.addEventListener("abort", prompt.onAbort, { once: true });
		}
		const timeoutMs =
			typeof request.timeout === "number" && request.timeout > 0
				? request.timeout
				: DEFAULT_TIMEOUT_MS;
		prompt.timer = setTimeout(() => {
			settlePending(prompt, undefined);
			void turn.send(turn.chatId, s.uiExpired).catch(() => undefined);
		}, timeoutMs);
		// 计时器不该拖住宿主的退出。
		(prompt.timer as unknown as { unref?: () => void }).unref?.();
		if (timeoutMs >= REMINDER_MIN_TIMEOUT_MS) {
			const minutes = Math.max(1, Math.ceil(timeoutMs / 120_000));
			prompt.reminderTimer = setTimeout(() => {
				void turn
					.send(turn.chatId, s.uiReminder(minutes))
					.catch(() => undefined);
			}, timeoutMs / 2);
			(prompt.reminderTimer as unknown as { unref?: () => void }).unref?.();
		}
		pending.set(key, prompt);
		imDebug(
			"ask",
			INSTANCE_ID,
			key,
			request.kind,
			request.title,
			request.options?.length ?? 0,
			pending.size,
		);

		void turn.send(turn.chatId, describePrompt(turn, request)).catch(() => {
			// 消息发不出去,问题就没有渠道可答:立刻取消,别让这一轮干等。
			settlePending(prompt, undefined);
		});
	});
}

/** pi 宿主提供给扩展的 UI 上下文(只列出本模块接管的五个方法)。 */
export interface BridgedUi {
	mode?: unknown;
	custom?: (...args: unknown[]) => unknown;
	select?: (...args: unknown[]) => unknown;
	confirm?: (...args: unknown[]) => unknown;
	input?: (...args: unknown[]) => unknown;
	editor?: (...args: unknown[]) => unknown;
}

interface DialogOpts {
	timeout?: number;
	signal?: AbortSignal;
}

interface BridgedUiState extends BridgedUi {
	__piImUiBridge?: boolean;
	/** 这个 UI 对象属于哪个会话(装补丁时记下),兜底认领提问时用它比对。 */
	__piImSession?: ImSessionScope | null;
}

/**
 * 把 IM 桥装到一个会话的共享 UI 上下文上。
 *
 * `ctx.ui` 在 pi 的 runner 里是**同一个对象**(所有扩展共用),所以在这里打补丁
 * 等于接管了本会话所有扩展的提问——`ask_user` 也在其中。
 *
 * `tui` 模式同样接管:pi TUI 只是一个宿主,回合可能来自手机上的 Telegram。接管是
 * 按回合判定的——`tui` 里人自己敲的那一轮没有 IM 回合,包装函数原样转给原实现,
 * 终端面板照旧;只有 IM 发起的回合才会被转发到聊天里。
 *
 * `session` 是这**一个**会话的身份:同一个 pi 进程里可能还开着别的会话(Pi Web
 * 的另一个标签页),它们各有自己的 UI 对象,而「只有一个 IM 回合在跑」是进程级的
 * 事实。记下会话身份,兜底分支才不会把别人的提问搬进聊天。
 */
export function installImUiBridge(
	ui: unknown,
	mode?: unknown,
	hasUI?: boolean,
	session?: ImSessionScope | null,
): void {
	// Without a UI there is nothing to forward, and mutating the runner's shared
	// no-op object would leak the patch into every other session.
	if (hasUI === false) return;
	if (!ui || typeof ui !== "object") return;
	const target = ui as BridgedUiState;
	if (target.__piImUiBridge) {
		// 同一个对象可能被装过两次(重新接管);此时只补上更确切的会话身份。
		if (session && (session.file || session.id)) target.__piImSession = session;
		return;
	}
	imDebug("ui:install", INSTANCE_ID, String(mode), `hasUI=${String(hasUI)}`);
	if (session) target.__piImSession = session;
	const scope = () => target.__piImSession ?? null;

	const original = {
		custom: target.custom,
		select: target.select,
		confirm: target.confirm,
		input: target.input,
		editor: target.editor,
	};

	// `custom` 的面板内容只是渲染行,IM 无法回填:在 IM 回合里如实声明"没有
	// 自定义 UI",让扩展走它自己的对话框降级(pi-ask-user 就是这么设计的)。
	target.custom = (...args: unknown[]) => {
		const imTurn = currentImTurn(scope());
		imDebug("ui:custom", INSTANCE_ID, Boolean(imTurn));
		if (imTurn) return undefined;
		return original.custom?.(...args);
	};

	target.select = (...args: unknown[]) => {
		const [title, options, opts] = args as [
			string,
			string[] | undefined,
			DialogOpts | undefined,
		];
		const turn = currentImTurn(scope());
		if (!turn || !Array.isArray(options) || options.length === 0) {
			imDebug(
				"ui:select:native",
				INSTANCE_ID,
				Boolean(turn),
				Array.isArray(options) ? options.length : -1,
				title,
			);
			return original.select?.(...args);
		}
		return askViaIm(turn, { kind: "select", title, options, ...(opts ?? {}) });
	};

	target.confirm = (...args: unknown[]) => {
		const [title, message, opts] = args as [
			string,
			string | undefined,
			DialogOpts | undefined,
		];
		const turn = currentImTurn(scope());
		if (!turn) return original.confirm?.(...args);
		return askViaIm(turn, {
			kind: "confirm",
			title,
			...(message ? { message } : {}),
			...(opts ?? {}),
		});
	};

	target.input = (...args: unknown[]) => {
		const [title, placeholder, opts] = args as [
			string,
			string | undefined,
			DialogOpts | undefined,
		];
		const turn = currentImTurn(scope());
		if (!turn) return original.input?.(...args);
		return askViaIm(turn, {
			kind: "input",
			title,
			...(placeholder ? { placeholder } : {}),
			...(opts ?? {}),
		});
	};

	target.editor = (...args: unknown[]) => {
		const [title, prefill] = args as [string, string | undefined];
		const turn = currentImTurn(scope());
		if (!turn) return original.editor?.(...args);
		return askViaIm(turn, {
			kind: "editor",
			title,
			...(prefill ? { placeholder: prefill } : {}),
		});
	};

	target.__piImUiBridge = true;
}

/** 是否还有悬着的提问(测试与 /status 用)。 */
export function hasPendingUiPrompt(channel: string, chatId: string): boolean {
	return pending.has(`${channel}:${chatId}`);
}

/** 只给测试用:清空所有等待中的提问。 */
export function resetUiBridgeForTests(): void {
	for (const prompt of [...pending.values()]) settlePending(prompt, undefined);
	pending.clear();
	customAnswers.clear();
	activeTurns.length = 0;
}
