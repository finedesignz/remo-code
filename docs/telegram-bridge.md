# Telegram Bridge (Phase 12 → re-sourced on transcript-tail in Phase 20)

Bidirectional chat bridge between a user's Telegram account and their Claude Code
(or Codex) session on remo-code. Talk to your hub-resident session from any phone
running Telegram — DM the bot, get a final reply back, tap to approve a permission
prompt.

## Source-of-truth: the transcript-tail (Phase 20, supersedes the Phase-12 event bus)

**Phase 17 removed the stream-json human runner** — and with it the
`assistant_message:final` / `permission_request` hub event bus the original
(Phase-12) bridge consumed. **Phase 20 re-grounds the bridge on a TRANSCRIPT-TAIL:**
each backend writes its own on-disk transcript while its interactive PTY runs, and
the hub READS those files (read-only). This is backend-agnostic and adds **no
programmatic API call** — the transcript reader never moves Telegram onto the
programmatic pool, never reuses the OAuth token, never needs `ANTHROPIC_API_KEY`.

- **Backend-agnostic `TranscriptSource`** (`hub/src/telegram/transcript/`):
  `selectAdapter(cliKind)` picks the adapter by the session's `cli_kind`.
  - **Claude adapter** — Claude Code projects JSONL
    `~/.claude/projects/<slug>/<session-uuid>.jsonl`, resolved DETERMINISTICALLY
    from the persisted session id (UUID === filename stem) / the persisted
    `transcript_path` captured at PTY spawn. **Never newest-file.**
  - **Codex adapter** — Codex rollout JSONL
    `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, resolved by matching
    the persisted `session_meta` id. **Both path/format are undocumented +
    version-unstable** — re-verify against the installed CLI version.
  - **Scrape fallback** — when the deterministic file is absent / the id is
    missing / the schema is unrecognized, the adapter degrades to a terminal-byte
    scrape that emits **only** assistant text + turn-complete, and **never a
    permission** (you cannot fail-closed-parse a discrete approve/deny out of raw
    bytes). The human handles those on the xterm surface.
  - Every adapter normalizes to a shared `TranscriptEntry` union
    (`assistant_text` / `tool_use` / `permission_request` / `user_question` /
    `turn_complete`). The bridge consumes ONLY this union — never a backend shape.
- **One tail, many consumers** (`transcript/manager.ts`): the outbound bridge
  (final assistant text + collapsed `tool_use` one-liners), the permission
  surfacer, and the PTY turn lock all attach to a single per-session source.

Outbound forwards the final assistant turn plus a **summarized live stream** — an
editable "working…" message that collapses each `tool_use` to a one-liner, then
finalizes to the full assistant text. `thinking` / raw streaming deltas do not
exist in the transcript stream and are never forwarded. All user-facing messages
use Telegram **MarkdownV2** with a 400→plain-text fallback, per-chat serialized.

## Fail-closed permission/question keystroke-injection (Phase 20)

A permission/`user_question` exists post-rip only as a transcript entry. The
detector (`transcript/permission-detector.ts`) is **fail-closed**: it surfaces a
Telegram tap-to-approve ONLY for a clean, fully-enumerated, keystroke-mappable
choice; anything ambiguous/partial/unparseable surfaces **nothing** (no prompt, no
keystroke, **no default "yes", no approve-on-timeout**). Pendings are keyed by
**`(sessionId, requestId)`** (reusing the multi-user-clobber fix in
`approvals.ts`) with per-user authorization.

An authorized tap is injected as the backend-specific **PTY keystroke(s)**
(`transcript/keystroke-map.ts`) via the Phase-16 raw-terminal `term.input` path
(`transcript/pty-inject.ts`) into **only that session's PTY** — NOT the deleted
`permission_response` agent message. A `takePendingPrompt` removes the entry so a
superseded / already-resolved / replayed tap injects nothing.

> ⚠️ The literal accept/deny/option BYTE sequences in `keystroke-map.ts` are
> PROVISIONAL (y/n + numbered-list conventions) and pending a live per-backend
> byte capture (the Phase-20 manual gate). The wiring, fail-closed gating, and
> disambiguation are complete + tested; only the final byte values await capture
> from a real Claude / Codex TUI prompt.

## PTY write-arbitration (Phase 20)

Two writers feed one PTY stdin: the web xterm panel and the Telegram injector. A
per-session **single-writer turn lock** (`turn-lock.ts`) arbitrates them: a new
human turn ACQUIRES the lock before its bytes reach stdin; the other writer is
QUEUED (bounded FIFO); the lock releases only on the observed `turn_complete`
(the same transcript signal the bridge tails) or a safety TTL. A permission
RESPONSE is exempt — it completes the in-flight turn rather than starting a new
one, so it never deadlocks.

**One client writer per session (fix/dup-pty-writer, 2026-07-12).** The lock
arbitrates writer CLASSES; it had no rule on how many `/ws/client` connections
could be writers for one session. A leaked browser socket (superseded in
`useWebSocket` but never closed) made TWO client writers drive one PTY: the lock
ping-ponged between a holder and a queuer, the queuer enqueued a waiter for EVERY
keystroke until the bound overflowed (evicting the FIFO head — including
Telegram's waiter), and every Telegram message came back "Session busy". Three
invariants now hold:
- **client** — one `term.onData` → exactly one `term.input`; a disposed/unmounted
  `TerminalSurface` sends nothing; `useWebSocket` supersedes its previous socket
  on every `connect()` and a superseded socket may not null `wsRef`, deliver
  frames, or schedule a reconnect (`web/test/pty-single-writer.test.tsx`).
- **turn lock** — a writer that is already queued COALESCES onto its existing
  waiter instead of enqueuing another (no queue spam, no overflow eviction).
- **hub** — `ws/term-writers.ts` enforces last-writer-wins: the newest client
  connection to write a session becomes THE client writer and the previous
  `client:*` writer is released from the lock. Telegram is never superseded
  (`hub/test/pty-single-client-writer.test.ts`).

**Lock lifecycle / self-heal (fixes wedged typing).** In prod the transcript
`turn_complete` signal is OFF (`REMO_TELEGRAM_TRANSCRIPT_TAIL=0`, #247) and PTY
sessions emit raw bytes (no stream-json `turn_complete`), so the TTL is the only
turn-end signal. To keep interactive typing from wedging:
- **Disconnect release** — when a `/ws/client` connection closes, the hub calls
  `releaseByWriter(writerId)` (`hub/src/ws/client.ts` close handler). Each
  connection has a unique `writerId`, so a closed/dead connection that held the
  lock (or was queued) can never wedge a different connection's `term.input`:
  its hold is released (promoting the next queued writer) and its queued waiters
  resolve `false` (their `acquire` awaits unblock).
- **Interactive TTL** — the safety backstop is **60s** (was 10min). An idempotent
  re-acquire by the current holder (each streamed keystroke) RE-ARMS the TTL, so
  active typing never trips it; an abandoned/stale holder frees within 60s.

## Human-only guard (Phase 20, ToS)

Telegram inbound dispatch carries a `source` tag and passes the Phase-16
**human-only PTY guard** (`humanOnlyPtyGate`): a genuine human Telegram message
may drive a `pty-interactive` session; an automation-tagged Telegram-origin
dispatch (auto-nudge / scheduled / orchestrator-background / error-capture) is
**rejected** before any PTY injection — "a robot pressing enter via the
interactive entrypoint" is the ban-risk move. The guard composes WITH (never
replaces) the non-bypassable daily-cost-cap gate.

---

Inbound messages route through the **shared session-dispatch pipeline**
(`hub/src/dispatch/`) — the same gate ordering (threshold → daily-cost-cap →
human-only-PTY), per-session queue, and offline-grace buffer the other subsystems
use — with `store: null` (Telegram writes no run row). A single hub-wide bot
serves every user, keyed by `users.telegram_chat_id`.
One BotFather bot, one Telegram webhook secret, one redeploy.

## Setup

### 1. Create the bot with BotFather

In Telegram, DM `@BotFather`:

```
/newbot
<name>            e.g. "Remo Code (Prod)"
<username>        e.g. "remo_code_prod_bot"   (must end in _bot)
```

BotFather replies with an HTTP API token of the shape `123456789:ABC...`. Save it —
this is `TELEGRAM_BOT_TOKEN`.

### 2. Set the hub env vars

In Coolify, on the `remo-code` app:

| Env | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token BotFather returned |
| `TELEGRAM_WEBHOOK_SECRET` | a random URL-safe token (32+ chars) you generate |
| `TELEGRAM_BOT_USERNAME` | the bot's username **without** the `@` (e.g. `remo_code_prod_bot`) |
| `TELEGRAM_COLLAPSE_ACTIVITY` | *(optional)* `false` disables the expandable-blockquote collapsing of the working-message activity feed. Default **on**. |

The first three are required for the bridge to do any work. If any is unset, the bridge
silently no-ops, `/api/telegram/status` returns `bot_configured: false`, and the
Settings UI renders a disabled card.

Redeploy after setting the vars.

### 3. Register the webhook with Telegram

The hub self-registers the webhook on bridge startup (`startTelegramBridge` →
`setWebhook`, mirroring the `setMyCommands` self-registration), pinning
`allowed_updates: ["message", "callback_query"]`. **`callback_query` is
mandatory** — without it Telegram silently never delivers inline-button taps, so
the `/list` session picker (selecting a session, the "Next »" page button) and
the Approve/Deny/🛑 Stop buttons all appear dead. The hub builds the URL from
`REMO_PUBLIC_URL` (default `https://app.remo-code.com`) + the webhook secret, so
no manual step is normally needed.

To register manually (or to verify), curl against Telegram's API — **always pass
`allowed_updates` including `callback_query`**, because Telegram treats an
omitted `allowed_updates` as "keep the previous filter", which can leave a stale
message-only registration that drops every button tap:

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://app.remo-code.com/api/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

Replace `<TELEGRAM_BOT_TOKEN>` and `<TELEGRAM_WEBHOOK_SECRET>` with the actual
values. Telegram will start POSTing JSON `Update` objects to that URL. The
URL-path secret IS the only credential — there are no HMAC headers, mirroring
the Coolify webhook discipline (Phase 06).

Verify with `getWebhookInfo` — `allowed_updates` must list `callback_query`:

```
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

To rotate the webhook secret: regenerate `TELEGRAM_WEBHOOK_SECRET`, redeploy,
then re-call `setWebhook` with the new URL.

### 4. Link a user account

In the remo-code web UI: **Settings → Telegram → Link Telegram**.

The UI generates a one-time 8-character link code (10-min TTL) and opens
`https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>` in a new tab — that deep
link drops the user into a DM with the bot, pre-filled with `/start <code>`.
Hit send and the chat is bound to the user's remo-code account.

The user then picks a **default session** from the dropdown. Inbound messages
route to that session; outbound replies from that session route back to the
chat.

### Orchestrator as the default target — explicit vs. auto (orchestrator-as-default, 2026-05-29)

The root **orchestrator** is the *preferred* Telegram target unless the user has
**explicitly** chosen a different session. This is gated on a new boolean
`users.telegram_default_explicit`:

- **`telegram_default_explicit = true`** — the user deliberately picked the
  default, via `/session <id>`, by tapping a button in the `/list` inline
  picker, **or** via the web Settings → Telegram default-session dropdown
  (`PUT /api/telegram/default-session` with a non-null `session_id`). An explicit
  choice is **always honored** and is **never** surprise-switched to the
  orchestrator. (A user who picked their `remo-code` repo a few versions ago
  stays on `remo-code` — honoring the choice they made.)
- **`telegram_default_explicit = false`** — the default is either unset or was
  **auto-pinned** (the lazy-pin below, or the prewarm-on-link path). For these
  no-choice users the orchestrator wins, so a fresh link / repo-less user lands
  in the root orchestrator instead of dead-ending on "No default session."

**Migration backfill (critical, ONE-SHOT — NOT in schema.sql):** the
`telegram_default_explicit` column is added with `DEFAULT false`. The backfill of
PRE-EXISTING prod pins (`UPDATE users SET telegram_default_explicit = true WHERE
telegram_default_session_id IS NOT NULL`) lives in
`hub/scripts/migrate-telegram-default-explicit.ts` and is run **manually exactly
once** after the deploy that ships the column. It deliberately does NOT live in
`schema.sql`, because `schema.sql` is re-applied on every hub boot
(`hub/src/db/migrate.ts::runMigrations`) — a re-running `SET explicit=true WHERE
default IS NOT NULL` would clobber legitimate POST-launch auto-pins (lazy-pin /
prewarm write explicit=false on purpose) on every redeploy, permanently killing
orchestrator-as-default for those users. Any default that existed BEFORE the
column is treated as explicit — we cannot distinguish an old prewarm-auto-pin
from an old `/session` pick post-hoc, and the user's hard constraint ("my prior
pick must never be auto-overridden") forces erring toward honoring it. A fresh DB
needs no backfill (no pre-existing pins).

`setTelegramDefaultSession(userId, sessionId, explicit)` takes `explicit` as a
**required** parameter so every call site must consciously decide (a silent
default is what previously let the web-dropdown path regress).

Mechanics (`hub/src/api/telegram-webhook.ts` `dispatchInbound`):

- **Resolution:** an explicit, live default is used as-is. Otherwise (no default,
  or non-explicit) `resolveOrchestratorTarget(userId)` is preferred; it returns
  null when the orchestrator is off/explicitly-disabled or no session row exists
  yet, in which case the existing default (if any) is kept.
- **Lazy-pin:** on a fallback to the orchestrator its id is written into
  `telegram_default_session_id` with **`explicit = false`**, so the OUTBOUND
  bridge (which matches on the column) forwards the reply WITHOUT promoting the
  pin to an explicit choice. A later explicit `/session` repo pick still wins.
- **Stale-pin self-heal:** if the default points at a now-deleted session
  (verified via `getSession`), it's dropped (flag cleared) and re-resolved to the
  orchestrator — no permanent `agent_offline` dead-end.
- **Not-running:** if the orchestrator session exists but its runner isn't live,
  dispatch returns `agent_offline` → the existing `/doctor` autoheal launches it
  (`launchSessionForUser` is orchestrator-aware: `is_orchestrator` rows delegate
  to `launchOrchestrator`, which mints the key + system prompt) and replays the
  buffered message. Tapping the **synthetic** orchestrator row in `/list` (when
  no orchestrator session exists yet) calls `launchOrchestrator` directly.
- **Prewarm:** `prewarmAfterLink` leaves the default unset when the orchestrator
  is enabled (so the orchestrator preference wins). When it does pin a project
  session (orchestrator disabled), it pins **non-explicit**.
- **Disabled:** orchestrator off + no explicit default → "No default session."

See the "Orchestrator Session" section in `CLAUDE.md` for the auto-launch + key-mint security model.

## Command reference

All commands work after the user has linked. Unlinked chats can ONLY send
`/start <code>`; everything else is silently dropped + audited.

| Command | Behavior |
|---|---|
| `/start <code>` | Bind the current Telegram chat to the remo-code user that minted `<code>`. One active code per user, 10-min TTL, single-use. **Pre-warm:** on first link, the hub picks the user's most-recently-used session (online-first, then `last_activity DESC`), sets it as the Telegram default, and fires `session.start` so the runner is live by the first chat message. Reply: `✅ Linked to <email>. Pre-launching '<repo-name>' so your next message lands instantly…` When the user has zero sessions: `✅ Linked to <email>. Send /list to pick a session.` On miss/expired: `Link code invalid or expired. Generate a fresh one from Settings → Telegram.` Failures of the pre-warm are best-effort — the link itself is committed atomically and `/doctor` repairs anything broken on the first real message. |
| `/session <id-or-name>` | Override the default session for subsequent messages — sets it as an EXPLICIT choice (`telegram_default_explicit=true`) that sticks until switched and is never auto-overridden by the orchestrator. Matches against session id-prefix or `project_dir` basename. Ambiguous match → reply lists candidates. No arg → reply shows the current default plus a numbered list. |
| `/list` | Inline-keyboard session picker. **The 🧭 Orchestrator (root folder) is pinned as the FIRST button** so the user can always tap-to-coordinate across repos — even when offline / repo-less, and even with zero other sessions (a synthetic row is offered). Each other button = one session (label = repo name from `project_dir`'s last path segment, truncated to 28 chars). Tap a button to set it as your EXPLICIT default — Telegram fires a `callback_query` that the hub validates, persists, and confirms with a toast + a leading ✓ on the chosen button. Paginated 20-per-page (2 buttons per row, 10 rows + a `« Prev` / `Next »` nav row); `Next`/`Prev` edit the message in-place and fall back to a fresh send if the edit fails. Currently-default session shown with a leading ✓ before any taps. See "Inline-keyboard session picker" below. |
| `/doctor` | Diagnose and auto-fix "supervisor offline" / "session offline" failures. Walks 6 progressive checks (account link → default session → session row → supervisor connected → live runner channel → auto-launch), replying after each step. When the session row is bound but no Claude runner is alive, the doctor calls `launchSessionForUser` to emit `session.start` to the supervisor — going through `reserveSessionSlot` so the cost cap / concurrency gate is NEVER bypassed. A 20s deferred check polls the channel registry. **Autoheal opener:** when a plain user message returns `agent_offline`, the webhook suppresses the legacy "Your supervisor is offline" reply and lets `/doctor` open with `🩺 Hold on — diagnosing & launching automatically…`. **Auto-replay buffer:** the original message (text + images) is stashed in-memory per chat (60s TTL, most-recent-wins). When the deferred check sees the channel come online, the buffered message is replayed through `dispatchToSession` with a negated `update_id` (audit `(chat_id, update_id)` UNIQUE can't collide). Cost cap is still enforced on the replay. Reply: `✅ Launch complete — sent your message ('<first 40 chars>'). Reply coming up.` On timeout the buffer is dropped: `⚠ Launch is taking longer than expected. Try again in a moment.` A second user message while the buffer is pending overwrites it and replies `Queued — I'll send this one after the launch completes.` See `hub/src/telegram/doctor.ts` + `hub/src/telegram/launch.ts`. |
| `/status` | Compact one-message report: linked email, default session label + short id, supervisor liveness, session channel state, and today's cost vs the user's daily cap. Reuses `sumTodayCostForUser` and `isSupervisorOnline` — no new DB columns, no duplicated cost math. User-scoped throughout. See `hub/src/telegram/status.ts`. |
| `/stop` | Halt the in-flight turn for the user's effective default session (a live explicit/auto default, else the open orchestrator). Resolves the target server-side, then forwards the SAME `{ type:'cancel', session_id }` frame the web client sends, onto the session's agent socket via `getChannel`. Ownership is re-verified (`getSession(sessionId, userId)`) so a user can never cancel a session they don't own. Reply: `⏹ Stopped <short-id>` on success, `No active session.` when there's no live target (or ownership is lost), `Couldn't deliver the stop. Try again.` on a send failure. Shares one cancel path with the 🛑 button — see `hub/src/telegram/stop.ts`. Does NOT touch the cost-cap gate (cancel only halts; it never dispatches). |
| `/help` | Static command reference. |
| *plain text* | Forwarded as `user_message` content (raw text — no `[telegram] ` prefix) to the user's default session. The Telegram origin is tracked separately in the `telegram_inbound_audit` row keyed by `(chat_id, update_id)`. |
| *photo* | Largest size is downloaded via `getFile` + `getFileContent`, attached as a base64 data-URI in `images[]` on the `user_message`. The Telegram `caption` becomes the text. 10MB hard cap (matches hub WS limit). |
| *document* | Text mime (`text/*`) → embedded as `attachments[]` text block. Any other binary → polite reject. |
| *voice / video / sticker / animation / video_note* | Polite reject — not supported in v1. |

Unknown command from a linked chat → `Unknown command. /help for list.`

### Inline-keyboard session picker

`/list` now sends a [Telegram InlineKeyboardMarkup](https://core.telegram.org/bots/api#inlinekeyboardmarkup) instead of a plain bullet list. Tapping a button does NOT post a chat message — Telegram delivers a `callback_query` update to the same webhook, and the hub edits the existing message in-place (no chat clutter).

**`callback_data` encoding** (≤64 bytes per Telegram limit, defined in `hub/src/telegram/session-picker.ts`):

| Prefix | Payload | Action |
|---|---|---|
| `s:<session_id>` | UUID of the session | Set default session for this Telegram user **as an EXPLICIT choice** (`telegram_default_explicit=true`). Sticks until the user switches; never auto-overridden by the orchestrator preference. |
| `s:__orchestrator__` | Sentinel (not a real id) | The synthetic root-orchestrator row (shown when no orchestrator session exists yet). Calls `launchOrchestrator` directly, then pins the launched session id **explicitly**. On no online supervisor → friendly reply, no pin. |
| `p:<offset>` | Non-negative integer | Paginate the session list to a new offset. Snapped to the nearest 20-multiple via `snapOffsetToPage` so stale keyboards from a prior page-size are still safe. |
| `pa:<request_id>` | Runner permission request id | **Approve** a pending permission/approval prompt (see "Inline approval prompts" below). Defined in `hub/src/telegram/approvals.ts`. |
| `pd:<request_id>` | Runner permission request id | **Deny** a pending permission/approval prompt. |

**Authorization on every callback** — `s:<session_id>` is gated on `getSession(sessionId, userId)`. A user can't spoof another user's session by guessing the UUID; the denial path replies `Not allowed` with `show_alert: true`. Unlinked callbacks are silently dropped (matches the unlinked-text-message path). The `s:__orchestrator__` sentinel bypasses `getSession` (no real row) and is gated by `launchOrchestrator`'s own `orchestrator_enabled` check.

**Tap-to-select persists identically to `/session`** — a `s:<id>` tap writes `setTelegramDefaultSession(userId, id, /*explicit*/ true)`, the SAME DAL write (and the SAME explicit flag) the `/session <prefix>` command uses. There is ONE code path for both; the only difference is how the id is resolved (typed prefix vs button). Because the pin is **explicit**, `dispatchInbound` honors it and never surprise-overrides it with the orchestrator. The picked session may be **OFFLINE** (no live supervisor/channel) — that's fine: selecting it is just a `users`-row write, and the session lazily starts on the next message (matching the web client). Selection never requires a running CLI.

**Always-visible confirmation** — after the write the handler sends a plain `✓ Default session set to <label> (<short-id>)` message (offline picks append `— it'll start on your next message`). This is in ADDITION to the best-effort in-place keyboard re-render (the `✓` mark). The re-render can legitimately no-op — the picked row may have been collapsed off the visible page by the worktree/`repo_key` dedupe, or the original message may be too old to edit — so the plain confirmation guarantees the user always sees the switch took. (Previously a no-op re-render left users thinking the tap did nothing; the typed `/session` path always replied, which is why it "worked" and `/list` appeared not to.)

**Selecting the root/orchestrator when it's offline** — tapping the **synthetic** `s:__orchestrator__` placeholder fires `launchOrchestrator`. On success (or `already_running`) the real orchestrator session id is pinned explicitly. When launch can't happen *right now* because the supervisor is offline (`no_online_supervisor` / `send_failed`), this is NOT treated as a hard "can't select": the default is **cleared to `null`/non-explicit** so the next inbound message falls through to `dispatchInbound`'s orchestrator-preference path (which fires autoheal and lazily launches it), and the reply reads `🧭 Orchestrator (root) selected. Your supervisor looks offline — send a message and I'll start it automatically.` Genuine blockers (`disabled`, `at_capacity`) still get their reason-specific reply and no pin change.

**Audit + dedupe** — every callback gets a `telegram_inbound_log` row keyed by `(chat_id, update_id)` exactly like inbound messages. Duplicate Telegram retries short-circuit to `{ deduped: true }`. Outcomes: `callback_session_set`, `callback_orchestrator_launched`, `callback_session_denied`, `callback_paginate`, `callback_unknown`, `callback_silent_drop_unlinked`, `callback_permission_approved`, `callback_permission_denied`, `callback_permission_stale`, `callback_permission_denied_auth`, `callback_permission_offline`.

**Pagination resilience** — `safeEditMessageText` first tries `editMessageText` (edits the message in-place). Telegram's `"message is not modified"` 400 is a benign no-op. **Any OTHER failure** (parse/encoding edge case, transient 400, message-too-old-to-edit) is logged AND **falls back to a fresh `sendMessage`/`sendMessageWithKeyboard`** so the page still renders — the picker never silently "freezes" on a tapped `Next`/`Prev`. `answerCallbackQuery` always fires so the button never spins.

**Cost cap is NOT involved** for set-default/paginate callbacks — they're state changes on the `users` row. The `s:__orchestrator__` launch flows through `launchOrchestrator` → `reserveSessionSlot` (the cost-cap / concurrency gate is NOT bypassed).

`/session <id>` still works for power users who want to type an id-prefix; it ALSO sets the default explicitly. The no-arg form now nudges users toward `/list`.

### Picker parity with web Sidebar

`listUserSessionsForPicker` mirrors the filtering in `web/src/components/Sidebar.tsx` (lines 157–178, 437–446) so the Telegram inline keyboard shows the same rows the user sees in the browser:

1. **Drop offline + null `repo_key`** — legacy local sessions with no actionable surface are hidden. **EXCEPTION: the orchestrator** (`is_orchestrator=true`) is exempt — it is a repo-less, frequently-offline root session and MUST always be visible + selectable (mirrors the web Sidebar's position-0 pin, which never hides it).
2. **Collapse worktrees by `(github_owner, github_repo)`** — multiple worktree directories of the same GitHub repo (`<repo>`, `<repo>-feat-X`, `<repo>-fix-Y`) collapse to the canonical clone (project_dir basename matches `github_repo` case-/separator-insensitively). Ties or "no canonical present" → most-recently-active wins.
3. **Dedupe by `repo_key`** — duplicate `repo_key` rows keep the most-recently-active row. Rows with null `repo_key` pass through keyed by id.
4. **Pin orchestrator** — the row with `is_orchestrator=true` floats to position 0 of the page list. Its button is labeled `🧭 Orchestrator (root)`, and the legend reads `🧭 = orchestrator (root folder)`.
5. **Synthetic orchestrator row** — when no orchestrator `sessions` row exists yet but the feature is enabled (`orchestrator_enabled && !disabled_explicitly`), `listUserSessionsForPicker` PREPENDS a synthetic row with id `__orchestrator__` so even a zero-session / repo-less user can tap-to-start their root folder. Tapping it triggers `launchOrchestrator` (see the `s:__orchestrator__` callback above).
6. **Orchestrator hint** — when the user has zero `is_orchestrator` rows AND the feature is disabled, the picker text appends `💡 Pin a root orchestrator from Settings → Connections for cross-repo coordination.`

The filter is implemented in `applySidebarParityFilter` (pure, unit-testable); the orchestrator-visibility injection lives in `listUserSessionsForPicker`.

### Slash-command menu (setMyCommands)

On bridge startup (`startTelegramBridge()` in `hub/src/telegram/bridge.ts`), the hub calls Telegram's [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands) **once** so typing `/` in the chat shows the command popup. The list is the single source of truth `BOT_COMMANDS` in `hub/src/telegram/commands.ts` — the SAME commands the webhook's linked-command switch handles (`/list`, `/session`, `/status`, `/doctor`, `/help`); no invented entries. The call is fire-and-forget and gated on `config.telegram.botToken` (no token → bridge is a no-op, no `setMyCommands`). A transient failure is logged and never blocks startup; Telegram treats a re-registration of the same list as idempotent.

### Inline approval prompts

When a Telegram-driven Claude session hits a tool **permission/approval** prompt (`can_use_tool` → the supervisor's `permission_request`), the bridge surfaces it inline instead of letting the session block silently:

1. `hub/src/ws/agent.ts` already broadcasts `permission_request` to web subscribers. It now ALSO emits a `permission_request:pending` event on the dedicated bus `hub/src/events/permission-events.ts` (same isolation discipline as the `assistant_message:final` bus — a listener throw can't tear down the WS handler).
2. The bridge subscribes (`onPermissionPendingEvent` in `bridge.ts`). For every user whose `telegram_default_session_id` matches the emitting session (reusing `getUsersWithTelegramDefaultSession`), it sends an inline keyboard `[✅ Approve] [🚫 Deny]` with `callback_data` `pa:<request_id>` / `pd:<request_id>`, plus a one-line preview of the tool input (e.g. the Bash `command`).
3. It records the pending prompt in `hub/src/telegram/approvals.ts` keyed by
   **`(sessionId, requestId)`**, holding a **map of every authorized
   `userId → { chatId, messageId }`** plus `{ sessionId, toolName, createdAtMs }`.
   **Why a server-side map and not callback_data:** Telegram caps `callback_data`
   at 64 bytes — too small for session UUID + request UUID + a user binding. The
   map keeps `callback_data` tiny AND the per-user set enforces authorization.
   **Shared-session re-keying (MED fast-follow from the #189 review):** the
   original design keyed by `requestId` alone, so when two users shared one
   default session the second `rememberPendingPrompt` *clobbered* the first —
   leaving the prompt bound to whichever user the bridge processed last and
   locking out every other (valid) approver with "Not allowed" (fail-closed, but
   wrong). Re-keying by `(sessionId, requestId)` and merging each authorized user
   into the entry fixes this: any authorized user can resolve, exactly once.
4. On a tap, the webhook's `handlePermissionCallback` calls
   `takePendingPrompt(requestId, tappingUserId)` — authorization is now folded
   into the take: it returns (and removes) the entry only if the tapping user is
   an authorized approver, resolving the whole `(sessionId, requestId)` exactly
   once. It then forwards `{ type: "permission_response", session_id, request_id,
   approved }` onto the session's **agent socket** via
   `getChannel(sessionId).ws.send(...)` — the exact frame the web client sends. It
   edits the prompt message to `✅ Approved — <tool>` / `🚫 Denied — <tool>` and
   drops the buttons. `answerCallbackQuery` fires on every branch.

**Authorization + edge cases (all answer the callback):** an unauthorized /
unknown / expired / already-resolved tap → `This prompt already expired or was
answered.` (`callback_permission_stale`, nothing sent to the agent — authorization
is enforced inside `takePendingPrompt`); session socket gone → `Session is
offline — couldn't deliver.` (`callback_permission_offline`). Prompts expire after
`PROMPT_TTL_MS` (10 min) and are pruned lazily on each remember.

**No new dispatch path.** Inline approval forwards a control frame on an existing agent socket; it does NOT route a user→session message and therefore does NOT (and must not) touch the cost-cap dispatch pipeline — it's a response to a runner-initiated prompt, not new traffic.

**Grant audit.** When a `permission_response` is forwarded to the supervisor — from EITHER channel — the hub emits a structured audit line `permission.grant_applied` `{ session_id, request_id, tool?, approved, source }` where `source` is `'web'` (`hub/src/ws/client.ts`) or `'telegram'` (`handlePermissionCallback` in `hub/src/api/telegram-webhook.ts`). This is the single traceable record that a tool grant was applied and delivered. The web and Telegram paths share the **same** hub→supervisor hop: hub `getChannel(sessionId).ws.send({type:'permission_response',…})` → supervisor `SessionBridge.handleHubMessage` (`supervisor/src/runners/session-bridge.ts`, no runtime schema gate — `HubToAgent` is a TS type) → `ClaudeRunner.respondToPermission` → CLI stdin `{type:'control_response', request_id, behavior:'allow'|'deny'}`. `question_response` follows the identical chain to `respondToQuestion`. Return-path coverage: `hub/test/ws-client-permission-returnpath.test.ts` (web→hub→channel + audit) and `supervisor/test/bridge-permission-returnpath.test.ts` (hub frame→runner→CLI control_response).

### Inline multiple-choice questions (AskUserQuestion)

When a Telegram-driven session raises a **question** rather than a permission gate — the built-in `AskUserQuestion` tool, or an MCP elicitation / `side_question` — the bridge surfaces it inline with **one button per option** so the user picks an answer from chat. It mirrors the approval flow, with the differences that questions have N choices (not a fixed Approve/Deny pair) and the answer is the chosen **option label**, not a boolean.

1. **Supervisor parse (`supervisor/src/runners/claude-runner.ts`).** `AskUserQuestion` arrives as a `control_request` / `can_use_tool`. `parseAskUserQuestionInput` extracts the first question's text, its option labels (+ descriptions), and `multiSelect` from the `tool_input` shape `{ questions: [{ question, header?, options: [{label, description?}], multiSelect? }] }`. The runner surfaces a `user_question` event `{ request_id, question, options, is_multi_select? }` (NOT a `permission_request`) and records the `request_id` in `askUserQuestionRequests` so the answer is returned on the right wire. Parsing is **defensive** — any missing/odd field degrades to a best-effort question with empty options (rendered as a plain prompt), never throws.
2. **Hub fan-out (`hub/src/ws/agent.ts`).** On `user_question` the hub broadcasts to web subscribers, `markPromptPending(sessionId, requestId)` (idle-teardown exemption — see below), and emits `user_question:pending` on the dedicated bus `hub/src/events/question-events.ts` (same listener-isolation discipline as the permission bus).
3. **Bridge render (`onQuestionPendingEvent` in `bridge.ts`).** For every user whose `telegram_default_session_id` matches the emitting session, it sends an inline keyboard with **one row per option**. Each button's `callback_data` is `qa:<token>`, where `<token>` is minted per **(prompt, user, option)** by `rememberQuestionOption` (`hub/src/telegram/question-approvals.ts`). **Why a short token, not `qa:<sessionId>:<requestId>:<optionIndex>`:** Telegram caps `callback_data` at 64 bytes — a session UUID + request UUID + index blows past it. The token resolves server-side to `{ sessionId, requestId, userId, chatId, messageId, label, question }`; the per-option `label` rides the entry so the tap carries the chosen answer with a tiny wire payload. (`approvals.ts` keys by `requestId` because permission has two fixed buttons; questions mint a token per option to carry the label.) Free-form questions (no options) surface as a plain message with no buttons.
4. **Resolve on tap (`handleQuestionCallback` in `hub/src/api/telegram-webhook.ts`).** `takeQuestionOption(token, tappingUserId)` enforces ownership (returns nothing if the token isn't this user's) and, on success, **invalidates every option token for the same `(sessionId, requestId)`** so the prompt is answered exactly once regardless of which option or which authorized user taps. It then forwards `{ type: "question_response", session_id, request_id, answer: <chosen label> }` onto the session's **agent socket** via `getChannel(sessionId).ws.send(...)` — the exact frame the web client sends — clears the pending mark (`clearPromptPending`), edits the prompt message to show the choice, and emits `question.answer_applied` `{ session_id, request_id, source: 'telegram', user_id }`.
5. **Supervisor answer (`respondToQuestion` in `claude-runner.ts`).** `SessionBridge.handleHubMessage` routes `question_response` → `respondToQuestion(requestId, answer)`. If the `requestId` was an `AskUserQuestion` (`can_use_tool`), the CLI gets a tool-**allow** control_response `{ type:'control_response', request_id, behavior:'allow', updatedInput:{ answer } }`; an elicitation / direct question gets `{ type:'control_response', request_id, response:{ answer } }`.

**Authorization + edge cases (all answer the callback):** an unauthorized / unknown / expired / already-answered tap → `This question already expired or was answered.` (`callback_question_stale`, nothing sent to the agent); session socket gone → `Session is offline — couldn't deliver.` (`callback_question_offline`). Tokens expire after `QUESTION_PROMPT_TTL_MS` (10 min, matching the permission TTL) and are pruned lazily on each remember.

**Multi-select (v1):** rendered identically — each tap answers with that single option's label and resolves the prompt. A richer "tap several then Done" UX is deferred; the web client retains true multi-select.

**No new dispatch path.** Like inline approvals, a question answer forwards a control frame on an existing agent socket; it does NOT route a user→session message and therefore does NOT touch the cost-cap dispatch pipeline — it's a response to a runner-initiated prompt, not new traffic.

**Idle-teardown exemption (`hub/src/ws/pending-prompts.ts`).** A Telegram-driven session is not a persistent WS subscriber, so once the runner blocks on a question the subscriber count is 0 and the idle-teardown timer would kill the session before the user can answer. `markPromptPending` records the open `requestId`; `hub/src/ws/idle-teardown.ts` checks `hasPendingPrompt(sessionId)` and skips teardown (a second exemption alongside the orchestrator). The mark is cleared on answer (`question_response` from either Telegram or web), and `clearAllPromptsPending` clears on turn finalize. A session counts every open `requestId`, so it stays exempt until ALL pending prompts resolve.

> **Runtime-verification assumptions (flagged in `claude-runner.ts`).** Two contracts are inferred from Claude Code's `AskUserQuestion` schema and cannot be exercised without a live CLI: (a) the inbound `tool_input` shape parsed by `parseAskUserQuestionInput`; (b) the outbound answer contract `behavior:'allow' + updatedInput:{ answer }`. Both are isolated to `claude-runner.ts` and parse/emit defensively; if the live CLI differs, adjust there — the hub bridge and TG/web button plumbing are unaffected.

### Summarized streaming (MarkdownV2 + editable working message)

A Telegram-driven session no longer goes silent until one final blob lands. While
a turn runs, the bridge maintains **one editable "working…" message per
`(chat, session)`** and keeps a `typing` chat-action alive.

- **Activity bus.** `hub/src/ws/agent.ts` emits a `session_activity` event (kind
  `tool_use` only) on the dedicated bus `hub/src/events/session-activity-events.ts`
  — same listener-isolation discipline as `assistant_message:final`. This is an
  outbound read-only fanout, **not** a dispatch path (dispatch = inbound
  user→session in `hub/src/dispatch/`); the cost-cap gate is untouched.
- **Working message.** On the first `tool_use` of a turn the bridge sends
  `⏳ *Working…*` (MarkdownV2) and records `{ messageId, lines, toolCount, startedAtMs }`.
  Each subsequent `tool_use` appends a collapsed one-liner — `🔧 Edit hub/src/foo.ts`,
  `🔧 Bash <cmd>` — and edits the message in place (throttled ~900ms, list capped
  at the last 12 lines). `thinking` is omitted entirely.
- **Collapsed activity (expandable blockquote, HTML parse_mode).** The one-liners
  render INSIDE a **native Telegram expandable blockquote** — `<blockquote expandable>`
  (Bot API 7.4+) — so activity is collapsed by default with a tap-to-expand "read more"
  control instead of flooding the chat. A summary line stays OUTSIDE the block and is
  readable while collapsed: `⏳ <b>Working…</b> — 🔧 4 tool calls · 12s` (`toolCount` is
  the turn TOTAL, not the 12-line window). `expandableQuote()` in
  `hub/src/telegram/bridge.ts` owns the markup and `escapeHtml()`s every line.
  **These messages (and ONLY these) are sent as HTML** via `sendMessageHtml` /
  `editMessageTextHtml`; `parse_mode` is per-message, so the permission/question
  prompts stay MarkdownV2. **Why HTML, not MarkdownV2:** the MarkdownV2 expandable
  blockquote is a fragile line-prefix construct (`**>` opener, `>` per line, `||`
  terminator) on top of an 18-char reserved set — and getting the terminator wrong
  **does not 400, it silently renders a plain non-expandable blockquote** (verified
  live: `**>a\n>b**` → entity `blockquote`; `**>a\n>b||` → `expandable_blockquote`).
  HTML is one unambiguous tag with a 3-char escape surface (`& < >`), so a `>` or `.`
  in a tool detail cannot break the block.
- **Live-verified markup.** `tools/telegram-render-probe.ts` pushes the real
  `renderWorking` / `renderFinal` output through the real `sendMessage` endpoint and
  asserts Telegram parses an **`expandable_blockquote` entity** — proof from the API,
  not from our own unit test. Run it after ANY change to the collapsing renderers:
  `TELEGRAM_BOT_TOKEN=<t> TELEGRAM_PROBE_CHAT_ID=<chat> bun run tools/telegram-render-probe.ts`
- **Typing indicator.** `sendChatAction(chat, "typing")` fires immediately and
  then every ~4s (Telegram's typing state expires ~5s) until the turn finalizes.
- **Finalize.** On `assistant_message:final` the bridge stops typing and **edits
  the same working message** to the full assistant text (escaped MarkdownV2). The
  answer stays **OUTSIDE** the blockquote, fully visible; the turn's activity is
  appended below it, still collapsed. If the combined text would exceed Telegram's
  4096-char cap the collapsed tail is **dropped** (never split a blockquote across
  messages) and the answer is sent alone. The cap is measured on the **escaped**
  string — that's what Telegram counts. An over-cap answer is then chunked by
  `splitHtmlForTelegram`, which is entity-safe (it will never cut an `&amp;` in half,
  which would 400). When no `tool_use` ran (or streaming is off) there is no working
  message and the final text is sent as a fresh message.
- **NEVER collapsed: permission prompts + `user_question` prompts.** Those are their
  own messages with inline keyboards (`sendMessageWithKeyboard`) and never touch the
  working message or the blockquote — a buried approval prompt is a broken product.
  Enforced by `hub/test/telegram-collapse-activity.test.ts`.
- **Reversible flags.** Gated on `config.telegram.summarizedStreaming` (env
  `TELEGRAM_SUMMARIZED_STREAMING`, default **on**; set to `false` to revert to a
  single final-blob send). The flag only affects the working-message behavior —
  finalization (and MarkdownV2) work regardless. Collapsing itself is independently
  gated on `config.telegram.collapseActivity` (env `TELEGRAM_COLLAPSE_ACTIVITY`,
  default **on**; `false` restores the flat inline one-liner list).

**MarkdownV2 safety.** `sendMessageMd` / `editMessageTextMd` send with
`parse_mode: MarkdownV2`; an unescaped reserved char makes Telegram reject the
WHOLE message with 400, so on a 400 they **retry once as plain text** — a session
reply is never silently dropped. `escapeMarkdownV2` escapes the full reserved set
`_ * [ ] ( ) ~ \` > # + - = | { } . !` (and `\\`); callers escape dynamic content
and keep only their own intentional markup (`*bold*`, ```code```). The inline
Approve/Deny prompt is also MarkdownV2 with the same fallback; the keyboard is
unaffected.

### Stop a running turn (🛑 button + `/stop`)

While a turn streams, the **🛑 Stop** inline button rides the editable "working…"
message; `/stop` does the same from the keyboard. Both halt the in-flight turn via
**one shared path** — `requestStop` in `hub/src/telegram/stop.ts` — which forwards
the SAME `{ type:'cancel', session_id }` frame the web client sends, onto the
session's agent socket via `getChannel`. No new dispatch path; the cost-cap gate is
untouched (cancel only halts, it never dispatches).

- **Button wiring.** When the bridge creates the working message it attaches a
  single-button keyboard `[[🛑 Stop]]` with `callback_data: sx:<sessionId>` (≤64
  bytes: `sx:` + a 36-char UUID = 39). It also records the working message in the
  **stop registry** (`rememberStoppable(sessionId, userId, {chatId, messageId})`),
  mirroring the approvals registry: one entry per `sessionId` holding every
  authorized user the working message was fanned to. The keyboard persists across
  the throttled edits; the final `assistant_message` edits the message WITHOUT the
  keyboard (button disappears) and `forgetStoppable` drops the entry.
- **Callback handling.** A 🛑 tap is a `callback_query`, handled INSIDE the existing
  post-auth `handleCallbackQuery` (alongside the Approve/Deny branch), keeping the
  raw-body / constant-time-secret / mount-order discipline intact. `parseStopCallback`
  decodes `sx:<sessionId>`; the tapping user is resolved server-side via
  `getUserByTelegramChatId` (**never** trusted from the wire).
- **Fail-closed authz (ownership, not registry).** The 🛑 tap is authorized purely by
  `requestStop` re-verifying the user OWNS the session (`getSession(sessionId, userId)`)
  before sending cancel — a foreign/forged `sessionId` on the wire resolves to no row →
  `not_authorized`. The tapping user is resolved server-side (`getUserByTelegramChatId`),
  never from the wire. The button does **NOT** gate on the in-memory stop registry:
  that `Map` is wiped on every hub redeploy and cleared at turn-end, which silently
  killed the button ("Already stopped or expired" for a live, owned session) while
  `/stop` kept working. The registry now only tracks `{chatId, messageId}` for the
  working-message edit lifecycle; `forgetStoppable` is best-effort cleanup. A double-tap
  simply re-issues cancel (idempotent at the CLI).
- **`/stop` target.** Resolves the user's effective default (a live explicit/auto
  default, else the open orchestrator), then calls the same `requestStop`. Reply:
  `⏹ Stopped <short-id>`, or `No active session.` when there's no live/owned target.
- **MarkdownV2.** On a successful stop the working message is edited to `⏹ Stopped.`
  via `editMessageTextMd` (MarkdownV2 → plaintext 400 fallback). `answerCallbackQuery`
  fires on every branch.

### Pagination edits

`safeEditMessageText` swallows Telegram's `400 message is not modified` error (no-op success when the new payload is byte-identical to the previous). All other errors are surfaced via `console.error` instead of `console.warn`, so paginate-not-firing-silently bugs surface in logs.

## Architecture

```
Telegram update
   ↓  HTTPS POST
hub/src/api/telegram-webhook.ts            ← URL-secret check (constant-time),
                                              raw body before parse, zod validate
   ↓
hub/src/telegram/commands.ts               ← /start /session /list /status /stop /doctor /help parser
hub/src/telegram/stop.ts                   ← shared cancel path + 🛑 button registry
                                              (sx:<sessionId> codec; used by the
                                              button callback AND /stop)
   ↓ (non-command, or after a successful link)
hub/src/telegram/dispatch.ts               ← adapter over hub/src/dispatch/
                                              dispatch({ store:null,
                                                gates:[threshold, dailyCostCap],
                                                token:'tg:<chat>:<update>' })
                                            → gates → session-queue → grace/online
                                            → send: insertMessage + broadcast +
                                              agent socket user_message (+images)
   ↓
supervisor → Claude CLI (existing pipe)
   ↓
supervisor → hub WS /ws/agent              ← emits assistant_message
   ↓
hub/src/events/assistant-events.ts         ← emits assistant_message:final
   ↓
hub/src/telegram/bridge.ts                 ← gates on default-session match
                                            → finalize working msg OR fresh send
                                            → sendMessageMd (MarkdownV2 + 400→plain)
                                            → splitForTelegram (4096 chunks)
                                            → per-chat serial queue
   ↑ (during the turn)
hub/src/events/session-activity-events.ts  ← tool_use one-liners → edit working msg
                                              + typing chat-action (~4s refresh)
   ↓
Telegram chat
```

Key boundaries:

- **Inbound + outbound share nothing on the hot path.** Inbound is webhook-driven;
  outbound is event-bus-driven. The bridge swallows `sendMessage` errors so a
  broken Telegram link cannot break a live Claude session.
- **Per-chat outbound serial queue** in `bridge.ts` — one in-flight `sendMessage`
  per `chat_id`, others wait. Prevents Telegram's per-chat rate-limit from
  shedding chunks of a split message.
- **Cost cap is non-bypassable.** Every inbound user→session dispatch flows
  through the shared `dailyCostCapGate` (`hub/src/dispatch/gates.ts`) — the
  single source of truth for the daily-USD SQL. The locally-replicated
  `isOverCostCap` copy that used to live in `dispatch.ts` is gone. Over-cap →
  the pipeline returns `{kind:'skipped'}` and `send` is NEVER called.
- **Offline → grace buffer.** When the target agent is offline, the pipeline
  parks the inbound message in the shared grace buffer keyed by `sessionId`. On
  agent reconnect the `/ws/agent` drain re-runs the `replay` thunk, delivering
  the buffered message once (#163 auto-replay-after-autoheal). Telegram passes
  no `onParkExpire` (no run row to mark on TTL lapse).
- **No finalize hook for Telegram.** The pipeline's `onSessionReply` no-ops for
  Telegram (null store) — it has no run row to finalize — while still promoting
  any queued same-session waiter. The reply is delivered by the outbound bridge
  on the `assistant_message:final` event, not the finalize hook.

## Security model

| Threat | Mitigation |
|---|---|
| **Webhook URL-secret leak** | URL-path secret is the only credential. Constant-time compare on every request (`hub/src/api/telegram-webhook.ts`). Mismatch → 401, no DB write (no audit row on auth-fail → can't fill the table via a 401 flood). Rotate by regenerating the env var + re-calling Telegram's `setWebhook`. |
| **Unlinked-chat spam / audit-log fill** | Unlinked messages audit but `telegram_inbound_log` is trimmed to 100/user via DAL housekeeping on every insert. Unknown chat_ids drop silently — no auto-create, no enumeration vector. |
| **Cost-cap bypass** | Every inbound dispatch passes through the shared `dailyCostCapGate` (`hub/src/dispatch/gates.ts`) before any session-queue claim — the gate runs first, the send never fires when capped (IR-1). Capped → throttled reply once per UTC day per user (uses `notifications_sent`-style dedupe key `telegram_cap_throttle:<user>:<utc_date>`); subsequent capped messages reply nothing. |
| **Link-code brute force** | 8-char Crockford-style base32 = ~40 bits; 10-min TTL; single-use; one active code per user. Server-side constant-time compare. Brute force across the TTL is infeasible. |
| **Telegram retry duplication** | Telegram retries non-2xx for up to 24h. Two defenses: (a) every accepted-but-skipped path returns 200, (b) `(chat_id, update_id)` audit-row check short-circuits re-dispatch. |
| **Photo download → memory blow-up** | 10MB hard cap matches hub-wide WS limit. `AbortSignal.timeout(10_000)` on every `getFileContent`. Largest-by-area photo only. |
| **MarkdownV2 injection from session output** | Claude is trusted within the user's own session — we still escape all MarkdownV2 control chars on outbound so Telegram never returns 400 on unbalanced markup. |
| **Bot-token leak via logs** | `client.sendMessage` formats the bearer URL at call site and never logs it. Failures log status + response body only. |
| **Cross-user impersonation** | `users.telegram_chat_id` carries a UNIQUE constraint. One chat_id can only ever be linked to one user. |
| **Default-session leak** | Outbound bridge gates on `default_session_id === emitting_session_id`. Switching default cleanly stops the old stream — replies from the previous session no longer forward to Telegram. |

## Limits

- 4096-char split per Telegram message (Telegram's hard limit). `splitForTelegram`
  prefers `\n\n` / `\n` / ` ` boundaries within the last 200 chars of a chunk;
  hard-splits otherwise.
- 10MB photo cap. Larger photos → polite reject.
- One default session per user. Multi-session fan-out is out of scope (v1).
- No group chats (1 chat_id → 1 user, enforced by UNIQUE).
- No voice / video / stickers / animations. Deferred.
- Summarized streaming edits one working message per turn; it does NOT stream raw
  token deltas (by design — `thinking`/`text_delta` are dropped). Disable via
  `TELEGRAM_SUMMARIZED_STREAMING=false`.
- Expandable blockquotes need **Bot API 7.4+** (server-side; no client opt-in) and are
  sent as **HTML** parse_mode. A blockquote is never split across messages — on 4096
  overflow the collapsed tail is dropped and the answer is sent alone; the remaining
  answer chunks via the entity-safe `splitHtmlForTelegram`. Disable via
  `TELEGRAM_COLLAPSE_ACTIVITY=false`.

## Migration from the legacy per-user post-run telegram path

`hub/src/scheduler/post-run/telegram.ts` predates this phase and uses **per-user
bot tokens** stored in `user_integrations`. It still works — that path is
preserved for one release as the rollback envelope.

- **Disable the hub-wide bridge:** unset `TELEGRAM_BOT_TOKEN` in Coolify env +
  redeploy. The bridge silently no-ops on missing config; the webhook route
  short-circuits via the `bot_configured: false` path; the Settings card greys
  out. Per-user post-run integrations keep working untouched.
- **Disable Telegram entirely:** additionally call `deleteWebhook` against
  BotFather so Telegram stops delivering updates.
- **Schema is additive + nullable** — no DB rollback is required.

The legacy path will be deleted in a follow-up phase once the hub-wide bridge
has soaked. Until then, both code paths coexist.

## File map

### New (hub)

- `hub/src/api/telegram-webhook.ts` — public ingress, URL-path secret, raw-body-before-parse, zod-validated `Update` envelope, audit-row append, command vs dispatch routing.
- `hub/src/api/telegram.ts` — authed REST: `GET /status`, `POST /link-code`, `DELETE /link`, `PUT /default-session`. Cookie auth + CSRF double-submit (Phase 07 pattern).
- `hub/src/telegram/client.ts` — `sendMessage` / `sendMessageMd` (MarkdownV2 + 400→plain fallback, returns `message_id`) / `sendMessageWithKeyboard` (now accepts `parse_mode`) / `editMessageText` / `editMessageTextMd` (MarkdownV2 + 400→plain, swallows "not modified") / `sendChatAction` / `answerCallbackQuery` / `setMyCommands` / `getFile`, `escapeMarkdownV2`, `splitForTelegram`. 10s `AbortSignal.timeout`. Per-chat outbound serial queue lives in `bridge.ts`.
- `hub/src/events/session-activity-events.ts` — internal `EventEmitter` for `session_activity` (`tool_use` one-liners). Outbound read-only fanout for the summarized-streaming working message; **not** a dispatch path. **(new — streaming)**
- `hub/src/telegram/commands.ts` — `parse(text)` + handlers for `/start` `/session` `/list` `/status` `/doctor` `/help`; `BOT_COMMANDS` (single source of truth for the slash menu + `/help`).
- `hub/src/telegram/approvals.ts` — inline-approval registry (`rememberPendingPrompt`/`takePendingPrompt`, TTL-pruned) + `pa:`/`pd:` callback_data codec. **(new — Fix C)**
- `hub/src/events/permission-events.ts` — internal `EventEmitter` for `permission_request:pending`. Additive — does not change the WS broadcast path. **(new — Fix C)**
- `hub/src/telegram/question-approvals.ts` — inline multiple-choice registry (`rememberQuestionOption`/`takeQuestionOption`, per-(prompt,user,option) short token, whole-prompt invalidation on first resolve, TTL-pruned) + `qa:<token>` callback_data codec (`questionCallbackData`/`parseQuestionCallback`). **(new — MCQ)**
- `hub/src/events/question-events.ts` — internal `EventEmitter` for `user_question:pending`. Mirrors the permission bus; additive. **(new — MCQ)**
- `hub/src/ws/pending-prompts.ts` — tracks sessions BLOCKED on an open interactive prompt (permission or question) keyed by `sessionId → Set<requestId>`; `markPromptPending`/`clearPromptPending`/`clearAllPromptsPending`/`hasPendingPrompt`. Second idle-teardown exemption. **(new — MCQ)**
- `hub/src/telegram/dispatch.ts` — inbound → session dispatch; thin adapter over the shared `hub/src/dispatch/` pipeline (`store:null`, gates `[thresholdGate, dailyCostCapGate]`, token `tg:<chat>:<update>`, grace-backed offline replay). Maps `DispatchOutcome` → Telegram replies: `skipped`→cost-capped, `dropped_busy`→session busy, `parked_offline`→buffered/agent_offline.
- `hub/src/telegram/bridge.ts` — outbound subscriber on `assistant_message:final`. Default-session match gate. Errors swallowed.
- `hub/src/telegram/link-codes.ts` — 8-char Crockford base32 generator, single-active-per-user, single-use consume, constant-time compare.
- `hub/src/events/assistant-events.ts` — internal `EventEmitter` for `assistant_message:final`. Additive — does not change the WS broadcast path.

### Modified (hub)

- `hub/src/config.ts` — `config.telegram.{botToken,webhookSecret,botUsername,summarizedStreaming,collapseActivity}` (all optional; `summarizedStreaming` defaults true, env `TELEGRAM_SUMMARIZED_STREAMING=false` disables; `collapseActivity` defaults true, env `TELEGRAM_COLLAPSE_ACTIVITY=false` disables the expandable-blockquote collapsing).
- `hub/src/db/schema.sql` — additive: `users.telegram_chat_id` (BIGINT UNIQUE), `telegram_default_session_id`, `telegram_default_explicit` (BOOLEAN NOT NULL DEFAULT false — distinguishes an explicit `/session`/tap choice from an auto-pin), `telegram_link_code`, `telegram_link_code_expires_at`; new `telegram_inbound_log` table with `(user_id, received_at DESC)` index.
- `hub/src/db/dal.ts` — Telegram DAL helpers (folded into the existing dal module, not a separate `telegram-dal.ts` as the plan envisioned — deviation noted in SUMMARY): `getUserByTelegramChatId`, `getUserByLinkCode`, `setLinkCode`, `linkChatId`, `unlinkChatId`, `setDefaultSession`, `getTelegramStatus`, `appendInboundLog`, `trimInboundLog`, `getUsersWithTelegramDefaultSession`.
- `hub/src/csrf.ts` — Telegram REST routes covered by the existing double-submit middleware (no new exclusions).
- `hub/src/index.ts` — mount `telegram-webhook.ts` AHEAD of JWT + license + CSRF catch-alls; mount `telegram.ts` inside; start the outbound bridge at boot.
- `hub/src/ws/agent.ts` — emit `assistant_message:final` on the internal event bus when a session run finalizes; **also emit `permission_request:pending` when a runner raises a permission prompt (Fix C)**; **also emit `session_activity` (tool_use) for the summarized-streaming working message**; **also, on `user_question`, `markPromptPending` + emit `user_question:pending` to the bridge (MCQ)**. Additive only.
- `hub/src/api/telegram-webhook.ts` — **(Fix C)** `handlePermissionCallback` resolves `pa:`/`pd:` taps → forwards `permission_response` on the agent socket; **(Fix B)** picker re-render uses `PAGE_SIZE` (was a hardcoded `20`); **(MCQ)** `handleQuestionCallback` resolves `qa:<token>` taps → forwards `question_response{answer:label}` on the agent socket + `clearPromptPending`.
- `hub/src/telegram/bridge.ts` — **(Fix A)** `setMyCommands(BOT_COMMANDS)` + `setWebhook` (pins `allowed_updates`) on startup; **(Fix C)** subscribes to `permission_request:pending` → sends the Approve/Deny keyboard + records the pending prompt; **(MCQ)** subscribes to `user_question:pending` → sends one inline button per option + records each option token.
- `hub/src/ws/client.ts` — **(MCQ)** handles the web `question_response` frame (forward to agent socket + `clearPromptPending`), keeping web + Telegram answer paths identical.
- `hub/src/ws/idle-teardown.ts` — **(MCQ)** second exemption: skip teardown when `hasPendingPrompt(sessionId)` (a session blocked on an open prompt is not idle).
- `supervisor/src/runners/claude-runner.ts` — **(MCQ)** `parseAskUserQuestionInput` + surface `AskUserQuestion`/elicitation as `user_question` (with options + `is_multi_select`); `respondToQuestion` returns the chosen label as a tool-allow (`updatedInput`) or inline (`response`) control_response. `session-bridge.ts` routes `question_response` → `respondToQuestion`.

### New (web)

- `web/src/components/SettingsPage.tsx` — Telegram subsection inline (per PLAN.md decision; NOT a new page). Loads `GET /api/telegram/status`, handles `bot_configured=false` / unlinked / linked states, mints link codes, opens the deep link, lets the user pick a default session, supports unlink with confirm.

### New (tests)

- `hub/test/telegram-client.test.ts` — escape + split edge cases (multi-byte, exact-4096, exact-4097, code fences).
- `hub/test/telegram-link-codes.test.ts` — generation rotation, consume, single-use, expiry, constant-time compare.
- `hub/test/telegram-webhook.test.ts` — secret mismatch (401), `/start` link success + expired, unlinked silent-drop, command dispatch, `update_id` dedupe, photo, oversized photo, voice/video/sticker rejection.
- `hub/test/telegram-output-from-transcript.test.ts` / `hub/test/telegram-outbound-source-gate.test.ts` — outbound bridge (Phase 20 re-sourced from the transcript; the flag-gated event-bus vs transcript-tail source). These replaced the deleted event-bus `telegram-bridge.test.ts`.
- `hub/test/telegram-api.test.ts` — REST: link-code rotation, unlink, default-session, CSRF reject, cookie-auth reject.
- `hub/test/telegram-approvals.test.ts` — **(Fix C)** approvals registry (remember/take once, expiry) + `pa:`/`pd:` codec round-trip + malformed rejection.
- `hub/test/telegram-webhook.test.ts` (extended) — **(Fix B)** `set_session` / paginate / unknown callbacks; **(Fix C)** approve/deny forward the `permission_response` frame, stale/foreign/offline edge cases; **(MCQ)** `qa:` option tap forwards `question_response{answer:label}`, stale/foreign-user edge cases.
- `hub/test/telegram-question-approvals.test.ts` — **(MCQ)** question registry: remember/take once, ownership auth, whole-prompt invalidation on first tap, TTL expiry, `qa:<token>` codec round-trip + malformed rejection.
- `hub/test/telegram-question-bridge.test.ts` — **(MCQ)** `emitQuestionPending` → one inline button per option with `qa:` callback data resolving to the chosen label (flag-OFF stream-json event-bus path); non-default session → no-op. Re-homed from the deleted event-bus `telegram-bridge.test.ts`.
- `hub/test/idle-teardown-pending-prompt.test.ts` — **(MCQ)** a session with an open prompt (`markPromptPending`) is exempt from idle teardown until cleared.
- `supervisor/test/claude-runner-askuserquestion.test.ts` — **(MCQ)** `can_use_tool` `AskUserQuestion` → `user_question` with options + `is_multi_select` (NOT a `permission_request`); `respondToQuestion` emits the tool-allow `updatedInput` answer; elicitation path emits the inline `response` answer.

### New (docs)

- `docs/telegram-bridge.md` (this file).

## Testing

Per-file (recommended — cross-file Bun mock pollution can spuriously fail
`telegram-client` in the full-suite run; tests pass cleanly in isolation):

```
bun test hub/test/telegram-client.test.ts
bun test hub/test/telegram-link-codes.test.ts
bun test hub/test/telegram-webhook.test.ts
bun test hub/test/telegram-output-from-transcript.test.ts
bun test hub/test/telegram-question-bridge.test.ts
bun test hub/test/telegram-api.test.ts
```

Total: **53 tests** covering client, link-code lifecycle, webhook, bridge, REST.

## OpenAPI

Telegram routes stay plain Hono in v1 (matching scheduler + error-capture +
revanote v1 conventions). The public webhook is intentionally undocumented in
`docs/openapi.json` — surfacing the URL-secret pattern in a public spec is
exactly the wrong shape. Authed `/api/telegram/*` routes will migrate to
`@hono/zod-openapi` in a follow-up refactor alongside the rest of the hub.
