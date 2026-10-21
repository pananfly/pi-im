# pi-im

Two-channel IM plugin for Pi — Feishu + Telegram. Both share one main session, and a
pi-web "holder" session keeps it resident.

[中文文档](./README.md)

Repository: <https://github.com/pananfly/pi-im>

### Prerequisites: Installing Pi

If the `pi` CLI is not yet installed:

```bash
npm install -g @earendil-works/pi-coding-agent
```

### Plugin Installation

- **From npm**:
  ```bash
  pi install npm:@pananfly/pi-im
  ```
- **From local source**:
  ```bash
  # Inside the pi-im project directory
  pi install .
  # Or with path
  pi install /path/to/pi-im
  ```

- Configure: `~/.pi/agent/pi-im/{feishu.json,telegram.json}`
- Warm up: `node scripts/pi-web-warmup.mjs --cwd <holder dir> --port 30141`
  (a recorded holder is resumed first; `--cwd` is only the fallback)
- On Windows no Git Bash is needed; let Task Scheduler start pi-web + the warmup at boot.

## Channel configuration

`feishu.json`:

| Field | Meaning |
| --- | --- |
| `appId` / `appSecret` | Credentials of your Feishu custom app. `FEISHU_APP_ID` / `FEISHU_APP_SECRET` override the file. |
| `domain` | `feishu` (default) or `lark` (overseas) |
| `autoStart` | Defaults to `true`: connect the WebSocket as soon as the extension loads |
| `allowlist` | User ids allowed to use the bot. Empty means **nobody is allowed**, not everybody. `["*"]` is the explicit opt-out. |
| `progressMode` | `card` (**default**) or `text`. A fresh `/feishu setup` writes `card`; switch at any time over IM with `/feishu card` / `/feishu text`, no restart needed — see below for what each actually looks like |

`telegram.json`: `botToken`, `autoStart`, `allowlist`, plus `progressMode` and
`parseMode` — same meanings as above, except that Telegram stays on `text` by
default: that gateway has no card capability at all, so `card` there would be a
no-op you cannot see.

The allowlist can only be edited from the TUI (`/feishu allow <id>` / `/tg allow <id>`).
The IM path is exactly the one the allowlist locks down: if the chat could edit its
own allowlist, the allowlist would not exist.

## How a message reaches Pi (read these three first)

Anything you send — a command or plain text — passes three gates first, always in
this order:

1. **The allowlist fails closed.** An empty `allowlist` means *nobody gets in*, not
   *everybody gets in*. If you are rejected, the bot replies with **your own user
   id** and the exact command to unlock yourself — copy it into the terminal, no
   digging through the client UI required.
2. **Group chats must mention the bot.** Direct messages always work; in a group,
   only messages that @ the bot count. @-ing someone else does nothing.
3. **Deduplication and a 30-minute freshness window.** The same message is handled
   once; anything older than 30 minutes is dropped, so a delayed historical message
   cannot suddenly kick off a run.

## IM commands (sent straight from the chat)

> `/help` prints a bare list with no explanation at all. This section is the
> reference.

### Queries

| Command | What it does | Notes |
| --- | --- | --- |
| `/help` | Print the command list | No descriptions — see this section |
| `/status` | Version/channel, connection, queue length, progress mode, workspace, session file, current model, thinking level, context usage, run state, whether session control is ready | "Session control: NOT ready" means `/new`, `/workspace` and `/session` will fail |
| `/version` | Version number | Read from `package.json`, never hardcoded |

### Session and tasks

| Command | What it does | Notes |
| --- | --- | --- |
| `/new` | Start a clean Pi session | Needs session control to be ready; refused while a task is running — `/stop` first |
| `/stop` | Abort the task that is currently running | — |
| `/steer <text>` | Add an instruction | While a task is running → merged into the current turn; otherwise → queued for the next turn |
| `/compact` | Compact the session context | — |
| `/history [N]` | Show the last N messages (default 3, max 5) | Each entry truncated to 500 characters |
| `/clear` | — | **Not wired up yet.** Replies with a notice; the session is unchanged |

### Model and thinking

| Command | What it does | Notes |
| --- | --- | --- |
| `/models` | List available models (up to 30 shown), current one marked `*` | Take the index from here |
| `/model [index\|ID]` | No argument = show current; with an argument = switch | Refused while a task is running. Fuzzy matching works, but an ambiguous prefix asks for the full ID |
| `/thinking [level]` (`/reasoning`) | No argument = show current plus available levels; with an argument = switch | The level list comes from the model's own `thinkingLevelMap`. A level outside it is **rejected**, not silently downgraded |

> A `/model` or `/thinking` choice is remembered and replayed after every `/new`.
> A pick made over IM outranks one made in the terminal, permanently — switching
> remotely is a deliberate act and a later terminal cycle should not undo it.

### Workspace and sessions

| Command | What it does | Notes |
| --- | --- | --- |
| `/wsl` | List workspaces (current directory first, marked `(current)`) | Not just pi-im's own history any more: discovered live from pi-web's session index / the `sessions/` directory under `~/.pi`, so any directory that ever had a session shows up |
| `/workspace <abs path\|index>` (`/ws`) | Switch workspace | Switches the **Pi session's cwd**, not `process.chdir`. The target directory must already contain a Pi session; otherwise it is only recorded and you are told how to create one |
| `/sessionlist` (`/sessions`) | List sessions in the current workspace, current one marked `*` | Up to 20 shown |
| `/session <ID\|index>` | Bind to an existing session | Accepts a full ID, an ID prefix, or an absolute `.jsonl` path |

> A Pi session's cwd is fixed once established, so "changing workspace" actually
> means **switching to a session in that directory**, not changing the process's
> directory. Workspace and session are therefore bound together: `/workspace`
> also binds the newest session in the target directory.
>
> **pi-im pins its own session.** Switching workspace in pi-web only opens that
> session in the browser; it does not move the task IM is running. Only IM's
> `/workspace`, `/session` and `/new`, or an explicit `/feishu` `/tg` typed in
> the TUI, migrate the holder. The pinned session/cwd is written to
> `config.json` (`holderSessionId` / `holderSessionFile` / `holderCwd`), and the
> warmup resumes it after a pi-web restart — so a browser opening another
> directory first cannot drag it away. Nor can a sibling session in the same
> workspace: identity is matched on the session file/id, never on "same
> directory". If another session did end up holding the pin, the recorded one
> takes it back as soon as it shows up again — but only once the current turn
> has finished, so an answer in progress is never pulled out from under itself.
> A holder you chose deliberately (`/workspace` `/session` `/new`, a TUI
> command) is never overridden by that fallback.
>
> The switch itself is pi-web's: `/new`, `/workspace` and `/session` need a build
> that implements `newSession` / `switchSession` (0.11.0 and earlier answer
> `{ cancelled: true }`), i.e. the dev server or a rebuilt checkout. If the
> target session is already open in the browser, the switch lands on **that**
> conversation instead of opening a copy, and by the time the call returns the
> new session's extensions have begun rebinding.

### Batch input

| Command | What it does | Notes |
| --- | --- | --- |
| `/batch` | Start buffering messages | **Direct messages only**; up to 10 messages buffered |
| `/send` | Join the buffer into one message and submit it | — |
| `/cancel` | Discard the buffer | — |

### Feishu only

| Command | What it does | Notes |
| --- | --- | --- |
| `/feishu` | No argument = show the current progress mode | — |
| `/feishu card` \| `/feishu text` | Switch the progress mode | See below |
| `/repair` | Repair the prompt context | Not supported on Telegram; on Feishu it points you at the missing scope |

## What `card` and `text` actually change

Both modes are **identical in how they trigger, what they answer, and how the model
behaves**. `progressMode` controls exactly one thing: what a running task looks like
on your screen while it works.

`text` (default):

```
Received, working…          ← one placeholder message goes out
⏳ bash                ← this same message is edited, not spammed
⏳ editing README.md

done:
done:                ← the same message is replaced by the final answer
Here is the analysis… (8000 char cap; anything past it is truncated)
```

- A single message, edited in place for the whole run
- While running: only `⏳`, the tool name, and the last 500 characters of text. No panels
- Final answers over 8000 characters are **truncated** — with no paging transport to fall back on

`card`:

```
┌────────────────────────────────────┐
│ ✅ Done                     1.2s   │
├────────────────────────────────────┤
│ ⚙️ Task process                      │  ← collapsible, expanded while running
│  · bash npm test                    │
│  · edit README.md                   │
├────────────────────────────────────┤
│ 💭 Thinking                          │  ← collapsible, collapsed while running
│  let me look at the existing…       │
├────────────────────────────────────┤
│ Here is the analysis…               │  ← the answer
└────────────────────────────────────┘
```

- One Feishu card (its own message), wholly replaced every 1.5s — never a flood of messages
- Tools and thinking each get their own collapsible panel, which **folds into a single
  "📋 Process details" wrapper** when the run ends; the finished card is one line tall
- 24KB per-card budget. Past that it spills into extra cards (earlier ones become
  sealed history cards), so the answer never loses its tail
- No 8000-character truncation: the answer is split by card, roughly 30KB each

Which to pick:

| | `text` | `card` |
| --- | --- | --- |
| Information while running | Little (tool name + last 500 chars) | Full (complete tool summary + thinking) |
| Long answers | Truncated past 8000 chars | Not truncated, split across cards |
| Reviewing the run | Lost (overwritten by the final answer) | Preserved under "📋 Process details" |
| Requires | Nothing | A channel that can post *and* patch cards (Feishu can, Telegram cannot) |

Switching rewrites `progressMode`, **saves it to disk**, and **hot-updates the running
controller**. It takes effect on the **next turn** — no pi / pi-web restart. Argument
case does not matter (`/feishu CARD` is the same). Only `card` and `text` are accepted;
anything else gets the usage line rather than being silently ignored.

**`/feishu` is refused on Telegram** — the TG gateway has no card capability at all, so
pretending to support it would turn the switch into an operation the user cannot see
take effect.

## Tools asking *you* (ask_user and friends)

During an IM-started turn, a tool dialog is **forwarded to the chat**, and your reply
resumes the run — no trip back to the browser panel.

```
❓ Pick a direction

1) Chat-bot plugin (QQ/WeChat/TG)
2) Desktop GUI (Codex-like)
3) Keep polishing the IM path

Reply 1-3, or /cancel to dismiss.
```

- **Answering**: send `2` (full-width `２` and `(2)` work too), or repeat the option
  text / a prefix. Yes/no dialogs take 是/否 (or yes/no); free-text questions take the
  whole message.
- **The "type custom response" row is folded away**: ask_user's trailing
  `✏️ Type custom response...` is not numbered — to write your own answer, just send
  text. It is taken as the custom answer in one step instead of asking again.
- **Only IM-started turns are taken over.** Prompts raised by a task started in the
  browser still appear in the browser; TUI mode is never patched. The patched session
  is the holder pi-im drives.
- **ask_user's rich panel degrades**: a custom panel cannot be read or answered over a
  chat, so pi-im makes it fall back to `select` / `input` dialogs, which are forwarded
  one at a time. Single-choice is just a number; multi-select or long text becomes a
  sequence of prompts.
- **Commands keep working** while a question is pending: `/status`, `/model`, etc. run
  normally and the question stays open. `/cancel` dismisses it, `/stop` dismisses it and
  aborts the run.
- **Timeout and reminder**: the tool's own timeout wins when it has one (ask_user
  usually does); otherwise the question expires after 10 minutes and says so. Halfway
  through, the bot nudges you once rather than going silent.
- A successful answer is acknowledged with `✅ Sent: …`, then the task continues.

> Implementation note: this is a patch on the holder session's shared `ctx.ui`, and it
> only applies **inside an IM turn** — no pi-web changes, and other sessions are
> untouched.

### Answered but nothing happened? Turn on the log

"Replied with the number and the bot went silent" is the hardest class of bug: the
message can be dropped in the Feishu gateway, the allowlist, dedup, or the pending-question
match. Enable the switch, restart the process running pi, and reproduce once:

```bash
PI_IM_DEBUG=1 pi          # or in the environment that starts pi-web
```

No restart handy? Drop a marker file instead — it starts logging when created and stops
the moment it is removed:

```bash
touch ~/.pi/agent/pi-im/debug.on
```

The log lands in `~/.pi/agent/pi-im/debug.log` (truncated past 1 MB). The lines that matter:

| Line | Meaning |
| --- | --- |
| `feishu:reject` | The Feishu SDK policy gate dropped it (no mention, not allowlisted, DMs off) — `reason` follows |
| `feishu:unparsed` | No chat/text in the event; the raw event is attached |
| `inbound` | The message reached pi-im: channel, chat, sender, body |
| `drop:*` | Dropped by pi-im: `duplicate` / `stale` / `not-allowed` / `no-mention` |
| `ask` / `settle` | A question was raised, and which value finally resolved it |
| `answer` / `answer:no-pending` | The reply was consumed as an answer, or no question was pending |

The short id on `ask` / `answer` lines identifies the module instance: two different ids
for one question means the host re-evaluated the extension (workspace or session switch),
which is exactly why the bridge state is shared.

Off by default: it writes only when `PI_IM_DEBUG` is `1`/`true`/`yes`, or when the `debug.on` marker exists.

## TUI commands (typed in the terminal running pi)

`/feishu`:

| Subcommand | What it does |
| --- | --- |
| `setup <AppID> <AppSecret>` | Save credentials and start the gateway immediately (prompts interactively if arguments are missing) |
| `start` / `stop` | Start/stop the Feishu WebSocket connection |
| `status` | Whether credentials are set, whether it is running, the allowlist, autostart |
| `config` | Print the config directory and the environment variables that override it |
| `card` \| `text` | Same as the IM-side `/feishu`: saves to disk and hot-updates |
| `allow <id>` / `deny <id>` / `allowlist` | Add / remove / show allowlist entries |
| `logout` | Stop the connection and erase local credentials |

`/tg` is structurally identical: `setup <BotToken>` / `start` / `stop` / `status` /
`config` / `allow` / `deny` / `allowlist` / `logout`.

> **The allowlist is TUI-only.** The IM path is precisely the one it locks down. When
> you are rejected, the command the bot quotes is meant to be run in the terminal:
> `/feishu allow <your id>`.

## Progress cards (`progressMode: "card"`)

Feishu card schema 2.0. The renderer follows
[dsh-im](https://github.com/xmanrui/dsh-im)'s `stepStreamCard` / `stepPanel` /
`processDetailsPanel`, but replaces the whole card via `im.v1.message.patch` rather
than using cardkit streaming.

- **Two grey collapsible panels**: 💭 Thinking and 🛠️ Tool summary, with borders,
  rounded corners and a spinner on the right (`down-small-ccm_outlined`). While
  running, the tool panel is expanded and the thinking panel collapsed. Since the
  whole card is replaced on every refresh, any manual expand/collapse you do
  mid-run cannot be preserved anyway — only the defaults are a choice.
- **Collapses when finished**: both panels fold into a single "📋 Process details"
  wrapper and the finished card is one line tall.
- **Multi-card spill**: the per-card budget is 24KB (Feishu's own limit is ~30KB).
  Past that the answer is cut at block boundaries into extra cards; all but the last
  become sealed history cards (grey header, title suffixed with "cont."), so the
  answer never loses its tail.
- **Table ceiling**: at most 5 tables per card (measured: a 6th makes the whole write
  get rejected, leaving the card frozen on stale content). Past that, tables are cut
  at their boundaries across different cards.
- **Degrades instead of freezing**: a failed patch is logged, refreshes stop, and the
  run finishes with a plain text message — the "working…" card can no longer be
  frozen forever without saying so.

> Under `schema: "2.0"` the markdown component's tag is `markdown`; `lark_md` only
> exists as a child of `div.text` in 1.0 and is rejected as a body element
> (`ErrCode 200621`).