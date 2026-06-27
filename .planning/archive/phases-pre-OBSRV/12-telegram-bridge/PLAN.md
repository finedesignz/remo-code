# PLAN — Phase 12: Telegram Bridge

Bidirectional chat bridge between a user's Telegram account and their Claude Code orchestrator session on remo-code. Inbound `POST /api/telegram/webhook/:secret` lands Telegram updates, routes commands or forwards text/photos as `user_message` to a linked default session. Outbound subscribes to `assistant_message` events and pushes the final reply back to the linked chat_id.

This is a follow-on to Phase 06 (Coolify webhook discipline, session-queue, cost-cap) and Phase 07 (Titanium cookie sessions + CSRF + license gate exclusion list). The outbound post-run `hub/src/scheduler/post-run/telegram.ts` already exists as a per-user-token integration; this phase migrates outbound to a single hub-wide bot (`TELEGRAM_BOT_TOKEN`) so one BotFather bot serves all users, keyed by `users.telegram_chat_id`.

Match Phase 06 PLAN.md style: waves, `[P]` for parallel, fine-grained tasks, one commit each, explicit verification gates between waves.

---

## Goal

A linked user can:
- DM the remo-code Telegram bot, get a reply from their default session within seconds.
- Send `/start <code>` once to bind their chat_id to their remo-code account.
- Switch sessions via `/session <name|id>`, list with `/list`, see help with `/help`.
- Send photos / documents — forwarded as attachments to the session.
- Receive the session's final `assistant_message` back in the same Telegram chat.

Unlinked chat_ids are silently dropped + audited. Cost cap applies to every inbound dispatch. Webhook secret leak rotatable from Settings.

---

## Success criteria (goal-backward)

- [ ] `POST /api/telegram/webhook/:secret` with wrong secret → 401, no DB write beyond the audit row.
- [ ] `/start <valid-code>` within 10 min of generation links `chat_id` → reply "Linked to <email>".
- [ ] `/start <expired-code>` → reply "Link code expired" + audit row, no link written.
- [ ] Plain text from a linked chat with `telegram_default_session_id` set → arrives as `user_message` on `/ws/agent` for that session, queued through `session-queue.ts`, gated by `enforceCostCap`.
- [ ] Photo from a linked chat → downloaded via `getFile`, attached as `images[]` base64 entry on the same `user_message`.
- [ ] Final `assistant_message` from the linked session → outbound `sendMessage` to `telegram_chat_id` within 1s of supervisor emitting it. Activity events (`thinking`, `tool_use`, `text_delta`) NEVER forwarded.
- [ ] Message > 4096 chars → split into chunks at safe boundaries.
- [ ] Daily cost cap hit → bot replies "Daily cost cap reached, resumes at <UTC reset>"; no `user_message` dispatched.
- [ ] Settings → Telegram subsection shows link state, generates `https://t.me/<bot_username>?start=<code>` deep link, can unlink, can pick default session. CSRF + cookie auth enforced (Phase 07 pattern).
- [ ] `docs/telegram-bridge.md` covers BotFather setup, webhook URL construction, command reference, threat model.

---

## File map

### New (hub)
- `hub/src/api/telegram-webhook.ts` — public ingress, URL-path secret, raw-body-before-parse.
- `hub/src/api/telegram.ts` — authenticated REST: link-code / unlink / default-session / status.
- `hub/src/telegram/client.ts` — thin `sendMessage` / `getFile` / `getFileContent` wrapper, MarkdownV2 escaping, 4096-char split helper.
- `hub/src/telegram/commands.ts` — `/start`, `/session`, `/list`, `/help` parser + handlers.
- `hub/src/telegram/dispatch.ts` — inbound → session dispatch (cost-cap → session-queue → agent socket send). Reuses `hub/src/scheduler/session-queue.ts` verbatim.
- `hub/src/telegram/bridge.ts` — outbound subscriber: listens to hub-internal `assistant_message` fan-out, sends to Telegram.
- `hub/src/telegram/link-codes.ts` — generate / validate / expire link codes.
- `hub/src/db/telegram-dal.ts` — DAL for the new user columns + `telegram_inbound_log`.

### New (web)
- `web/src/components/SettingsTelegramSection.tsx` — Telegram subsection rendered inside existing `SettingsPage.tsx` (NOT a new page).

### New (docs / tests)
- `docs/telegram-bridge.md`
- `hub/test/telegram-webhook.test.ts`
- `hub/test/telegram-bridge.test.ts`
- `hub/test/telegram-link.test.ts`

### Modified
- `hub/src/db/schema.sql` — additive: `users.telegram_chat_id`, `users.telegram_default_session_id`, `users.telegram_link_code`, `users.telegram_link_code_expires_at`, `telegram_inbound_log` table. `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- `hub/src/config.ts` — add `config.telegram.botToken`, `config.telegram.webhookSecret`, `config.telegram.botUsername`. All optional; bridge no-ops if `botToken` unset.
- `hub/src/index.ts` — mount `telegram-webhook.ts` OUTSIDE the JWT catch-all (ahead of `/api/*` auth), mount `telegram.ts` inside.
- `hub/src/license-gate.ts` — add `/api/telegram/webhook/` to exclusion list.
- `hub/src/scheduler/post-run/telegram.ts` — migrate to hub-wide bot token: fall back to `config.telegram.botToken` + `users.telegram_chat_id` when `user_integrations` row absent. Keep legacy path for one release.
- `hub/src/ws/agent.ts` — emit `assistant_message` events to an internal `EventEmitter` (e.g. `hub/src/events/bus.ts`) so the Telegram bridge can subscribe without touching the WS broadcast path. If a lightweight bus already exists, reuse it.
- `web/src/components/SettingsPage.tsx` — mount `<SettingsTelegramSection />`.

---

## Wave 1 — Foundations (sequential)

### T1. Schema + DAL
**Files:** `hub/src/db/schema.sql`, `hub/src/db/telegram-dal.ts` (new)
- `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT UNIQUE`, `telegram_default_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL`, `telegram_link_code TEXT`, `telegram_link_code_expires_at TIMESTAMPTZ`.
- `CREATE TABLE IF NOT EXISTS telegram_inbound_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id) ON DELETE CASCADE, chat_id BIGINT, update_id BIGINT, outcome TEXT, error TEXT, raw JSONB, received_at TIMESTAMPTZ DEFAULT now())`. Index `(user_id, received_at DESC)`. Cap retention: trigger or housekeeping in DAL trims to 100/user (mirror `coolify_webhook_attempts` discipline).
- DAL: `getUserByTelegramChatId`, `getUserByLinkCode`, `setLinkCode(userId, code, expiresAt)`, `linkChatId(userId, chatId)`, `unlinkChatId(userId)`, `setDefaultSession(userId, sessionId | null)`, `getTelegramStatus(userId)`, `appendInboundLog(...)`, `trimInboundLog(userId)`.

**Done when:** `migrate.ts` applies cleanly twice in a row; DAL unit-importable.

### T2. Config + client `[P]`
**Files:** `hub/src/config.ts`, `hub/src/telegram/client.ts` (new)
- Config additions (all optional — feature disabled cleanly if unset). Boot-log a single warning when `botToken` set without `webhookSecret` or vice versa.
- Client: `sendMessage(chatId, text, { parse_mode?: 'MarkdownV2' })`, `getFile(file_id) → file_path`, `getFileContent(file_path) → ArrayBuffer`. 10s `AbortSignal.timeout`. MarkdownV2 escape helper. `splitForTelegram(text)` → string[] at 4096-char boundary, prefer split on `\n\n` / `\n` / ` ` within last 200 chars of a chunk.

**Done when:** Vitest unit covers escape + split edge cases (multi-byte, code fences, exact-4096, exact-4097).

### T3. Link codes `[P]`
**Files:** `hub/src/telegram/link-codes.ts` (new)
- `generateLinkCode(userId)` → 8-char base32 (Crockford), writes to `users.telegram_link_code` with `expires_at = now() + 10 min`. Single active code per user — generating again rotates.
- `consumeLinkCode(code)` → `{ userId } | null`. Constant-time compare. Returns null on expired or missing; the consume call CLEARS the code regardless of expiry (single-use).

---

## Wave 2 — Inbound webhook (sequential after Wave 1)

### T4. Webhook route shell
**Files:** `hub/src/api/telegram-webhook.ts` (new), `hub/src/index.ts`
- `POST /api/telegram/webhook/:secret`. Mount AHEAD of the JWT catch-all (Phase 06 pattern). Add to license-gate exclusion list.
- Read raw body before JSON parse. Constant-time compare on `:secret` vs `config.telegram.webhookSecret`. Mismatch → 401, log only (no audit row — would let attacker fill the table).
- Zod-validate the Telegram `Update` envelope (minimal subset: `update_id`, optional `message: { message_id, from: { id }, chat: { id }, date, text?, photo?, document?, caption? }`).
- Resolve `users` row via `getUserByTelegramChatId(message.chat.id)`. If absent, branch to "unlinked" handler:
  - If `text` starts with `/start `, route to link handler (T5).
  - Otherwise: append `telegram_inbound_log` row with `outcome='silent_drop_unlinked'`, reply 200 (Telegram retries on non-200).
- If linked, route to command parser (T5) or text/attachment dispatch (T6).
- Every accepted request appends an audit row; failure modes (`parse_error`, `command_unknown`, `dispatched`, `cost_capped`, `silent_drop_unlinked`, `link_ok`, `link_expired`) recorded in `outcome`.

**Done when:** `curl` with wrong secret → 401; with right secret + minimal text update from unlinked chat → 200 + one log row.

### T5. Command parser + handlers
**Files:** `hub/src/telegram/commands.ts` (new)
- `parse(text)` → `{ cmd: 'start'|'session'|'list'|'help'|null, arg?: string }`. Anything not starting with `/` returns `null`.
- `/start <code>` → `consumeLinkCode(code)`; on success: `linkChatId(userId, chatId)`, reply `Linked to <email>. Send /help for commands.`; on miss: reply `Link code invalid or expired. Generate a fresh one from Settings → Telegram.`
- `/session <arg>` (linked only) — match arg against user's sessions by id-prefix or `project_dir` basename; ambiguous → reply with disambiguation list; no arg → reply current default + numbered list.
- `/list` (linked only) — render numbered list of sessions with `last_active_at` relative time.
- `/help` — static command reference.
- Unknown command from linked chat → reply `Unknown command. /help for list.`

### T6. Inbound dispatch — text + attachments
**Files:** `hub/src/telegram/dispatch.ts` (new)
- `dispatchToSession({ user, sessionId, text, images?, attachments? })`:
  1. Resolve `sessionId` = `user.telegram_default_session_id` if not overridden. If null → reply `No default session set. /session <name> to pick one.`, log `outcome='no_session'`.
  2. `enforceCostCap(user.id)` from `hub/src/scheduler/dispatcher.ts`. If capped → reply throttled `Daily cost cap reached, resumes at <UTC reset>` (use `notifications_sent`-style throttle so we don't spam every message during the capped window — `kind='telegram_cap_throttle'`, `dedupe_key=<user>:<utc_date>`); log `outcome='cost_capped'`.
  3. Build `user_message` payload reusing the existing scheduler agent sender shape. Content prefix: `[telegram] ` for traceability in `messages` row.
  4. `session-queue.enqueue(sessionId, ...)`. `dropped` → reply `Session busy, message dropped. Try again in a moment.`. `dispatched` → send via the agent socket (existing helper from scheduler senders).
  5. Audit `outcome='dispatched'` with `update_id` so retries from Telegram are deduped (if `(chat_id, update_id)` already logged with `outcome='dispatched'`, skip).
- Photo handling: pick the largest `photo[i]` by area, `getFile` → `getFileContent` → base64 data URI, push onto `images[]` array on the `user_message` (matches existing web-client `send_message` plumbing). `caption` becomes the text. Reject >10MB (the hub-wide WS limit) with a polite reply.
- Document handling: text/* mime → embed as attachment text block (matches web `attachments` array); binary other than image → reply `Unsupported attachment type. Send text, image, or a text file.`. Voice / video / sticker / animation → same reply.

### T7. Webhook → dispatch wiring
**Files:** `hub/src/api/telegram-webhook.ts` (extend T4)
- On linked text update: try command parse first; if `cmd === null`, call `dispatchToSession` with `{ text }`.
- On photo / document: skip command parse, go straight to `dispatchToSession`.
- All branches MUST return 200 to Telegram unless the request was unauthenticated (401) — Telegram retries on non-2xx and we don't want duplicate dispatches.

---

## Verification gate — Wave 2

- [ ] `bun test hub/test/telegram-webhook.test.ts` (added in W5) covers: secret mismatch (401), `/start` link success + expired, unlinked silent-drop, command dispatch, `update_id` dedupe.
- [ ] Manual curl with hand-crafted Telegram `Update` JSON → end-to-end through to a mock agent socket receiving `user_message` with `[telegram]` prefix.
- [ ] Cost cap simulated → throttle reply lands once, subsequent capped hits within the same UTC day reply nothing.

---

## Wave 3 — Outbound bridge (after Wave 2)

### T8. Internal event bus (if absent)
**Files:** `hub/src/events/bus.ts` (new) OR reuse existing fan-out
- Grep `hub/src/ws/agent.ts` for the current `assistant_message` broadcast path. If it already pushes to an internal emitter, subscribe to that directly in T9 and skip this task. Otherwise: add a tiny `EventEmitter` keyed `assistant_message:final` carrying `{ userId, sessionId, content, message_id, cost_usd?, duration_ms? }`. Emit from the existing branch in `agent.ts` that finalizes an assistant message (the same place the run-finalize bookkeeping happens today). DO NOT change the WS broadcast path itself — additive only.

### T9. Outbound bridge
**Files:** `hub/src/telegram/bridge.ts` (new), wired in `hub/src/index.ts` boot
- Subscribe at boot. On `assistant_message:final`:
  1. Load the user. Skip if no `telegram_chat_id` or no `telegram_default_session_id` or default doesn't match the emitting session — outbound only follows the user's CURRENT default session (avoids leaking other sessions' replies to Telegram).
  2. `splitForTelegram(content)` → chunks. For each chunk: `client.sendMessage(chat_id, chunk, { parse_mode: 'MarkdownV2' })`. Failures log-only, never throw.
  3. Strip / never forward: `thinking`, `tool_use`, `tool_result`, `text_delta`. Bridge ONLY reacts to `assistant_message:final`.
- Errors swallowed: a broken Telegram link must not break the session.

---

## Verification gate — Wave 3

- [ ] Linked user with default session → supervisor emits `assistant_message` → Telegram receives the text within 1s.
- [ ] 6000-char reply → arrives as two messages, no mid-word split inside fenced code blocks (best-effort acceptable: split at last `\n` in the window).
- [ ] Switching `default_session_id` to a different session → outbound follows the new one; old session's replies no longer forwarded.
- [ ] Activity events fire repeatedly while Claude works → ZERO Telegram messages sent until the final `assistant_message`.

---

## Wave 4 — REST + Web UI (after Wave 3; T10/T11/T12 parallel)

### T10. REST endpoints `[P]`
**Files:** `hub/src/api/telegram.ts` (new), wired in `hub/src/index.ts` inside the auth catch-all
- All routes: Phase 07 cookie auth + CSRF double-submit (`hub/src/csrf.ts`).
- `GET /api/telegram/status` → `{ linked: bool, chat_id?, default_session_id?, bot_username, bot_configured: bool }`. `bot_configured` reflects whether `config.telegram.botToken` + `webhookSecret` are set on the hub (so the UI can hide the link button on misconfigured deploys).
- `POST /api/telegram/link-code` → generates code, returns `{ code, deep_link: 'https://t.me/<bot_username>?start=<code>', expires_at }`.
- `DELETE /api/telegram/link` → clears `telegram_chat_id` + `telegram_default_session_id`. Replies once to the now-unlinked chat: `This chat has been unlinked from <email>.` (best-effort, before clearing).
- `PUT /api/telegram/default-session` `{ session_id }` → validates ownership + sets.

### T11. Settings UI subsection `[P]`
**Files:** `web/src/components/SettingsTelegramSection.tsx` (new), `web/src/components/SettingsPage.tsx` (mount)
- Loads `GET /api/telegram/status`.
- States:
  - **bot_configured=false** → grey card "Telegram bridge not enabled on this server".
  - **linked=false** → "Link Telegram" button → POST link-code → opens deep link in new tab + shows the code below for manual paste.
  - **linked=true** → linked chat_id (last 4 digits), default-session `<select>` populated from `useSessions`, "Unlink" button (confirm modal).
- Visual baseline: existing `SettingsPage` subtle cards, indigo accent, status pills per `~/.claude/design-preferences.md` / project UI rules.

### T12. Bot-token & webhook-secret guidance docs `[P]`
**Files:** `docs/telegram-bridge.md` (new)
- BotFather setup walkthrough.
- Hub env vars + how to set the Telegram webhook (`POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<host>/api/telegram/webhook/<SECRET>`).
- Command reference.
- Threat model (see below) — security section.
- Rotation: generate new `TELEGRAM_WEBHOOK_SECRET`, re-call `setWebhook`, redeploy.

---

## Verification gate — Wave 4

- [ ] UI → "Link Telegram" → tap deep link on phone → `/start <code>` in Telegram → reply lands → UI auto-refreshes status to linked within 5s.
- [ ] Default session dropdown change → next inbound text routes to the new session.
- [ ] Unlink → outbound stops; subsequent Telegram messages silent-drop.
- [ ] Without `botToken` set, UI renders the disabled card and no link button.

---

## Wave 5 — Tests + docs + ship

### T13. Tests
**Files:** `hub/test/telegram-webhook.test.ts`, `hub/test/telegram-bridge.test.ts`, `hub/test/telegram-link.test.ts`
- `telegram-webhook.test.ts`: secret mismatch 401, `/start` link, `/start` expired, unlinked silent-drop with audit row, command dispatch, `update_id` dedupe, photo → image array, oversized photo rejection, voice/video/sticker rejection.
- `telegram-bridge.test.ts`: `assistant_message:final` → `sendMessage` called; non-final events ignored; 6000-char split into 2 chunks; default-session mismatch → no send; broken `sendMessage` does not throw upstream.
- `telegram-link.test.ts`: link-code rotation, unlink, default-session set, CSRF rejection without header, cookie-auth required.

### T14. Docs sync
- `docs/telegram-bridge.md` shipped in T12.
- `CLAUDE.md`: append "Phase 12: Telegram Bridge" section mirroring Phase 06/07 sections — file map, key invariants, doc-update mandate.
- `README.md`: one-liner + link.
- `bun run docs:sync` if any of the new routes are migrated to `@hono/zod-openapi` (decision: stay plain Hono in v1 — same as scheduler/error-capture v1; OpenAPI migration is a separate refactor). Note this explicitly in `docs/telegram-bridge.md`.

### T15. Deploy + verify in prod
- Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` in Coolify env for `remo-code` (UUID per `reference_deployment_infra.md`).
- Call BotFather setWebhook against the prod URL.
- Link own account via Settings, send "hi" from Telegram, confirm reply arrives.

---

## Threat model

| Threat | Mitigation |
|---|---|
| Webhook URL secret leak | URL-path secret is the only credential. Rotation: regenerate env var + re-call `setWebhook`. Constant-time compare on every request. Mismatch never writes to DB (avoids table-fill DoS). |
| Unlinked-chat spam / table fill | Unlinked messages still audit, but `telegram_inbound_log` is trimmed to 100/user via DAL housekeeping. Unknown chat_ids are silently dropped — no auto-create — so spam can't enumerate. |
| Cost-cap bypass | EVERY inbound user→session dispatch flows through `enforceCostCap`. No code path under T6/T7 sends to a session socket without the cap call. Test asserted in T13. |
| Message ordering / interleave with web UI | Same `session-queue.ts` 1-in-flight + 1-waiter the scheduler uses. Telegram bursts get queued; the third message replies "session busy" rather than racing. |
| Telegram retry duplication | Telegram retries non-2xx for up to 24h. Two defenses: (a) we always return 200 on accepted-but-skipped paths, (b) `(chat_id, update_id)` audit-row uniqueness short-circuits re-dispatch. |
| Bot token leak via outbound errors | `client.sendMessage` never logs the token. URL formatted once at call site; failures log status + body only. |
| Photo download → memory blow-up | Hard 10MB cap matching the hub-wide WS limit. `AbortSignal.timeout(10_000)` on every `getFileContent`. |
| MarkdownV2 injection from session output | Outbound forwards Claude's reply — Claude is trusted within the user's own session. We still escape MarkdownV2 control chars to avoid Telegram returning 400 on unbalanced markup; if Claude emits intentional Markdown, the escape preserves readable plain text. |
| Link-code brute force | 8-char Crockford base32 = 40 bits; 10-min TTL; single-use; one active code per user. Server constant-time compare. Brute force across 10 min is infeasible. |
| WhatsApp/Telegram cross-channel confusion | This phase is Telegram-only. WhatsApp is explicitly out of scope and would follow the same skeleton in a future phase. |

---

## Test plan summary

- Unit: parsers, MarkdownV2 escape, split-at-4096, link-code lifecycle, command parser.
- Webhook integration: secret gate, command routing, dispatch path with mock session queue, cost-cap branch, attachment handling.
- Bridge integration: event-bus subscription, split, default-session match logic.
- REST: cookie-auth + CSRF, link-code rotation, unlink, default-session.
- E2E manual (Wave 5/T15): real Telegram bot → real prod hub → linked account → reply round-trip.

No new external test fixtures; Telegram API is mocked via `fetch` stub in tests.

---

## Docs updates

- New: `docs/telegram-bridge.md`.
- Modified: `CLAUDE.md` (new "Phase 12" section), `README.md` (one-liner).
- Not regenerated: `docs/openapi.json` / `docs/api.md` — telegram routes stay plain Hono in v1; explicit note in `docs/telegram-bridge.md`.

---

## Rollout / rollback

**Rollout:**
1. Merge after Wave 5 verification.
2. Set the 3 env vars in Coolify; redeploy.
3. Call `setWebhook` once against prod URL.
4. Internal smoke test (link own account, round-trip a "hi").
5. Announce in README + release notes.

**Rollback:**
1. Unset `TELEGRAM_BOT_TOKEN` in Coolify; redeploy. Bridge silently no-ops; webhook returns 200 on every request without dispatching (bot_configured=false path).
2. Or: call `deleteWebhook` against BotFather so Telegram stops sending updates entirely.
3. Schema additions are nullable + additive — no DB rollback needed.
4. `hub/src/scheduler/post-run/telegram.ts` legacy per-user-token path is preserved for one release, so existing `user_integrations`-based outbound notifications keep working if we revert the bridge.

---

## Out of scope (explicit, so follow-ups aren't blocked)

- WhatsApp bridge (separate phase; same skeleton, Twilio or Meta Cloud API provider).
- Multi-user group chats (1 chat_id → 1 default_session_id only).
- Voice messages, video, stickers, animations, video notes.
- Inline keyboards / button UIs / reply markup.
- Editing previously-sent messages (Telegram supports it; v1 sends append-only).
- Multi-session fan-out to Telegram (only the current default session forwards outbound).
- Streaming partial assistant replies — v1 sends only the FINAL `assistant_message`. Streaming `text_delta` to Telegram would burn the cost cap and rate-limit the bot fast.
- Per-user bot tokens (the existing `user_integrations` outbound path stays for legacy callers but new work targets the hub-wide bot).

---

## Risks baked in

- **Hub-wide bot impersonation across users** → addressed by `chat_id` UNIQUE constraint + Telegram's authenticated sender id; one chat_id can only ever be linked to one user.
- **Default-session mismatch leak** → outbound bridge gates on `default_session_id === emitting_session_id`; switching default cleanly stops the old stream.
- **Webhook DoS via floods** → Telegram itself rate-limits update delivery; we additionally cap inbound-log writes per user. The cost cap caps the expensive (LLM) work; cheap (audit + 401) work is bounded by Telegram's own delivery rate.
- **Phase 06 / 07 invariant drift** — this plan reuses `session-queue.ts`, `enforceCostCap`, the public-route mounting discipline, raw-body-before-parse, constant-time URL-secret compare, cookie+CSRF auth, and the license-gate exclusion list. Any change to those primitives must update this phase's plumbing in lockstep.
