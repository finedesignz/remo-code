# Telegram Bridge (Phase 12)

Bidirectional chat bridge between a user's Telegram account and their Claude Code
orchestrator session on remo-code. Talk to your hub-resident Claude session from
any phone running Telegram — DM the bot, get a final reply back. Inbound
messages route through the same cost-cap + session-queue plumbing as scheduled
tasks; outbound forwards only the *final* `assistant_message` (no streaming,
no `thinking`/`tool_use`/`text_delta` chatter).

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

## Command reference

All commands work after the user has linked. Unlinked chats can ONLY send
`/start <code>`; everything else is silently dropped + audited.

| Command | Behavior |
|---|---|
| `/start <code>` | Bind the current Telegram chat to the remo-code user that minted `<code>`. One active code per user, 10-min TTL, single-use. Replies `Linked to <email>. Send /help for commands.` On miss/expired: `Link code invalid or expired. Generate a fresh one from Settings → Telegram.` |
| `/session <id-or-name>` | Override the default session for subsequent messages. Matches against session id-prefix or `project_dir` basename. Ambiguous match → reply lists candidates. No arg → reply shows the current default plus a numbered list. |
| `/list` | Inline-keyboard session picker. Each button = one session (label = repo name from `project_dir`'s last path segment, truncated to 28 chars). Tap a button to set it as your default — Telegram fires a `callback_query` that the hub validates, persists, and confirms with a toast + a leading ✓ on the chosen button. Paginated 20-per-page (2 buttons per row, 10 rows + a `« Prev` / `Next »` nav row). Currently-default session shown with a leading ✓ before any taps. See "Inline-keyboard session picker" below for `callback_data` encoding + authorization rules. |
| `/help` | Static command reference. |
| *plain text* | Forwarded as `user_message` content (prefixed `[telegram] ` in the persisted `messages` row) to the user's default session. |
| *photo* | Largest size is downloaded via `getFile` + `getFileContent`, attached as a base64 data-URI in `images[]` on the `user_message`. The Telegram `caption` becomes the text. 10MB hard cap (matches hub WS limit). |
| *document* | Text mime (`text/*`) → embedded as `attachments[]` text block. Any other binary → polite reject. |
| *voice / video / sticker / animation / video_note* | Polite reject — not supported in v1. |

Unknown command from a linked chat → `Unknown command. /help for list.`

### Inline-keyboard session picker

`/list` now sends a [Telegram InlineKeyboardMarkup](https://core.telegram.org/bots/api#inlinekeyboardmarkup) instead of a plain bullet list. Tapping a button does NOT post a chat message — Telegram delivers a `callback_query` update to the same webhook, and the hub edits the existing message in-place (no chat clutter).

**`callback_data` encoding** (≤64 bytes per Telegram limit, defined in `hub/src/telegram/session-picker.ts`):

| Prefix | Payload | Action |
|---|---|---|
| `s:<session_id>` | UUID of the session | Set default session for this Telegram user. |
| `p:<offset>` | Non-negative integer | Paginate the session list to a new offset. Snapped to the nearest 20-multiple via `snapOffsetToPage` so stale keyboards from a prior page-size are still safe. |

**Authorization on every callback** — `s:<session_id>` is gated on `getSession(sessionId, userId)`. A user can't spoof another user's session by guessing the UUID; the denial path replies `Not allowed` with `show_alert: true`. Unlinked callbacks are silently dropped (matches the unlinked-text-message path).

**Audit + dedupe** — every callback gets a `telegram_inbound_log` row keyed by `(chat_id, update_id)` exactly like inbound messages. Duplicate Telegram retries short-circuit to `{ deduped: true }`. Outcomes: `callback_session_set`, `callback_session_denied`, `callback_paginate`, `callback_unknown`, `callback_silent_drop_unlinked`.

**Cost cap is NOT involved.** Picker callbacks are state changes on the `users` row, not session dispatches — the `enforceCostCap` gate only fires when a user actually messages a session.

`/session <id>` still works for power users who want to type an id-prefix. The no-arg form now nudges users toward `/list`.

## Architecture

```
Telegram update
   ↓  HTTPS POST
hub/src/api/telegram-webhook.ts            ← URL-secret check (constant-time),
                                              raw body before parse, zod validate
   ↓
hub/src/telegram/commands.ts               ← /start /session /list /help parser
   ↓ (non-command, or after a successful link)
hub/src/telegram/dispatch.ts               ← cost-cap (enforceCostCap)
                                            → session-queue.enqueue()
                                            → agent socket send
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
  through `enforceCostCap`. No code path under `dispatch.ts` sends to a session
  socket without the cap call.

## Security model

| Threat | Mitigation |
|---|---|
| **Webhook URL-secret leak** | URL-path secret is the only credential. Constant-time compare on every request (`hub/src/api/telegram-webhook.ts`). Mismatch → 401, no DB write (no audit row on auth-fail → can't fill the table via a 401 flood). Rotate by regenerating the env var + re-calling Telegram's `setWebhook`. |
| **Unlinked-chat spam / audit-log fill** | Unlinked messages audit but `telegram_inbound_log` is trimmed to 100/user via DAL housekeeping on every insert. Unknown chat_ids drop silently — no auto-create, no enumeration vector. |
| **Cost-cap bypass** | Every inbound dispatch passes through `enforceCostCap` before any session-queue claim. Capped → throttled reply once per UTC day per user (uses `notifications_sent`-style dedupe key `telegram_cap_throttle:<user>:<utc_date>`); subsequent capped messages reply nothing. |
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
- `hub/src/telegram/dispatch.ts` — inbound → session dispatch (cost-cap → session-queue → agent socket).
- `hub/src/telegram/bridge.ts` — outbound subscriber on `assistant_message:final`. Default-session match gate. Errors swallowed.
- `hub/src/telegram/link-codes.ts` — 8-char Crockford base32 generator, single-active-per-user, single-use consume, constant-time compare.
- `hub/src/events/assistant-events.ts` — internal `EventEmitter` for `assistant_message:final`. Additive — does not change the WS broadcast path.

### Modified (hub)

- `hub/src/config.ts` — `config.telegram.{botToken,webhookSecret,botUsername}` (all optional).
- `hub/src/db/schema.sql` — additive: `users.telegram_chat_id` (BIGINT UNIQUE), `telegram_default_session_id`, `telegram_link_code`, `telegram_link_code_expires_at`; new `telegram_inbound_log` table with `(user_id, received_at DESC)` index.
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
