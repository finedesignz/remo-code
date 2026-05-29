# Telegram Bridge (Phase 12)

Bidirectional chat bridge between a user's Telegram account and their Claude Code
orchestrator session on remo-code. Talk to your hub-resident Claude session from
any phone running Telegram — DM the bot, get a final reply back. Inbound
messages route through the **shared session-dispatch pipeline** (`hub/src/dispatch/`)
— the same gate ordering (threshold → daily-cost-cap), per-session queue, and
offline-grace buffer scheduled tasks and the other subsystems use — with
`store: null` (Telegram writes no run row). Outbound forwards only the *final*
`assistant_message` (no streaming, no `thinking`/`tool_use`/`text_delta` chatter)
via the event bus, NOT a pipeline finalize hook.

A single hub-wide bot serves every user, keyed by `users.telegram_chat_id`.
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

All three are required for the bridge to do any work. If any is unset, the bridge
silently no-ops, `/api/telegram/status` returns `bot_configured: false`, and the
Settings UI renders a disabled card.

Redeploy after setting the vars.

### 3. Register the webhook with Telegram

One-shot curl against Telegram's API — Telegram needs to know where to deliver
updates:

```
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://app.remo-code.com/api/telegram/webhook/<TELEGRAM_WEBHOOK_SECRET>"
```

Replace `<TELEGRAM_BOT_TOKEN>` and `<TELEGRAM_WEBHOOK_SECRET>` with the actual
values. Telegram will start POSTing JSON `Update` objects to that URL. The
URL-path secret IS the only credential — there are no HMAC headers, mirroring
the Coolify webhook discipline (Phase 06).

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
  default, via `/session <id>` **or** by tapping a button in the `/list` inline
  picker. An explicit choice is **always honored** and is **never** surprise-
  switched to the orchestrator. (A user who picked their `remo-code` repo a few
  versions ago stays on `remo-code` — honoring the choice they made.)
- **`telegram_default_explicit = false`** — the default is either unset or was
  **auto-pinned** (the lazy-pin below, or the prewarm-on-link path). For these
  no-choice users the orchestrator wins, so a fresh link / repo-less user lands
  in the root orchestrator instead of dead-ending on "No default session."

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

**Authorization on every callback** — `s:<session_id>` is gated on `getSession(sessionId, userId)`. A user can't spoof another user's session by guessing the UUID; the denial path replies `Not allowed` with `show_alert: true`. Unlinked callbacks are silently dropped (matches the unlinked-text-message path). The `s:__orchestrator__` sentinel bypasses `getSession` (no real row) and is gated by `launchOrchestrator`'s own `orchestrator_enabled` check.

**Audit + dedupe** — every callback gets a `telegram_inbound_log` row keyed by `(chat_id, update_id)` exactly like inbound messages. Duplicate Telegram retries short-circuit to `{ deduped: true }`. Outcomes: `callback_session_set`, `callback_orchestrator_launched`, `callback_session_denied`, `callback_paginate`, `callback_unknown`, `callback_silent_drop_unlinked`.

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

### Pagination edits

`safeEditMessageText` swallows Telegram's `400 message is not modified` error (no-op success when the new payload is byte-identical to the previous). All other errors are surfaced via `console.error` instead of `console.warn`, so paginate-not-firing-silently bugs surface in logs.

## Architecture

```
Telegram update
   ↓  HTTPS POST
hub/src/api/telegram-webhook.ts            ← URL-secret check (constant-time),
                                              raw body before parse, zod validate
   ↓
hub/src/telegram/commands.ts               ← /start /session /list /help parser
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
                                            → splitForTelegram (4096 chunks)
                                            → client.sendMessage (per-chat serial queue)
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
- No voice / video / stickers / animations / inline keyboards / message editing
  / streaming partial replies. All deferred.

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
- `hub/src/telegram/client.ts` — `sendMessage` / `getFile` / `getFileContent`, `escapeMarkdownV2`, `splitForTelegram`. 10s `AbortSignal.timeout`. Per-chat outbound serial queue lives here.
- `hub/src/telegram/commands.ts` — `parse(text)` + handlers for `/start` `/session` `/list` `/help`.
- `hub/src/telegram/dispatch.ts` — inbound → session dispatch; thin adapter over the shared `hub/src/dispatch/` pipeline (`store:null`, gates `[thresholdGate, dailyCostCapGate]`, token `tg:<chat>:<update>`, grace-backed offline replay). Maps `DispatchOutcome` → Telegram replies: `skipped`→cost-capped, `dropped_busy`→session busy, `parked_offline`→buffered/agent_offline.
- `hub/src/telegram/bridge.ts` — outbound subscriber on `assistant_message:final`. Default-session match gate. Errors swallowed.
- `hub/src/telegram/link-codes.ts` — 8-char Crockford base32 generator, single-active-per-user, single-use consume, constant-time compare.
- `hub/src/events/assistant-events.ts` — internal `EventEmitter` for `assistant_message:final`. Additive — does not change the WS broadcast path.

### Modified (hub)

- `hub/src/config.ts` — `config.telegram.{botToken,webhookSecret,botUsername}` (all optional).
- `hub/src/db/schema.sql` — additive: `users.telegram_chat_id` (BIGINT UNIQUE), `telegram_default_session_id`, `telegram_default_explicit` (BOOLEAN NOT NULL DEFAULT false — distinguishes an explicit `/session`/tap choice from an auto-pin), `telegram_link_code`, `telegram_link_code_expires_at`; new `telegram_inbound_log` table with `(user_id, received_at DESC)` index.
- `hub/src/db/dal.ts` — Telegram DAL helpers (folded into the existing dal module, not a separate `telegram-dal.ts` as the plan envisioned — deviation noted in SUMMARY): `getUserByTelegramChatId`, `getUserByLinkCode`, `setLinkCode`, `linkChatId`, `unlinkChatId`, `setDefaultSession`, `getTelegramStatus`, `appendInboundLog`, `trimInboundLog`, `getUsersWithTelegramDefaultSession`.
- `hub/src/csrf.ts` — Telegram REST routes covered by the existing double-submit middleware (no new exclusions).
- `hub/src/index.ts` — mount `telegram-webhook.ts` AHEAD of JWT + license + CSRF catch-alls; mount `telegram.ts` inside; start the outbound bridge at boot.
- `hub/src/ws/agent.ts` — emit `assistant_message:final` on the internal event bus when a session run finalizes. Additive only.

### New (web)

- `web/src/components/SettingsPage.tsx` — Telegram subsection inline (per PLAN.md decision; NOT a new page). Loads `GET /api/telegram/status`, handles `bot_configured=false` / unlinked / linked states, mints link codes, opens the deep link, lets the user pick a default session, supports unlink with confirm.

### New (tests)

- `hub/test/telegram-client.test.ts` — escape + split edge cases (multi-byte, exact-4096, exact-4097, code fences).
- `hub/test/telegram-link-codes.test.ts` — generation rotation, consume, single-use, expiry, constant-time compare.
- `hub/test/telegram-webhook.test.ts` — secret mismatch (401), `/start` link success + expired, unlinked silent-drop, command dispatch, `update_id` dedupe, photo, oversized photo, voice/video/sticker rejection.
- `hub/test/telegram-bridge.test.ts` — `assistant_message:final` triggers send; non-final events ignored; 6000-char → 2 chunks; default-session mismatch → no send; broken `sendMessage` does not throw.
- `hub/test/telegram-api.test.ts` — REST: link-code rotation, unlink, default-session, CSRF reject, cookie-auth reject.

### New (docs)

- `docs/telegram-bridge.md` (this file).

## Testing

Per-file (recommended — cross-file Bun mock pollution can spuriously fail
`telegram-client` in the full-suite run; tests pass cleanly in isolation):

```
bun test hub/test/telegram-client.test.ts
bun test hub/test/telegram-link-codes.test.ts
bun test hub/test/telegram-webhook.test.ts
bun test hub/test/telegram-bridge.test.ts
bun test hub/test/telegram-api.test.ts
```

Total: **53 tests** covering client, link-code lifecycle, webhook, bridge, REST.

## OpenAPI

Telegram routes stay plain Hono in v1 (matching scheduler + error-capture +
revanote v1 conventions). The public webhook is intentionally undocumented in
`docs/openapi.json` — surfacing the URL-secret pattern in a public spec is
exactly the wrong shape. Authed `/api/telegram/*` routes will migrate to
`@hono/zod-openapi` in a follow-up refactor alongside the rest of the hub.
