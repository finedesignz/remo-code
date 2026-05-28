# Phase 12: Telegram Bridge — SUMMARY

## Goal

A linked user can DM the remo-code Telegram bot and get a reply from their default Claude Code session within seconds. `/start <code>` binds chat_id to remo-code account; `/session`, `/list`, `/help` for session control; photo/document attachments forwarded; final `assistant_message` routed back. Unlinked chat_ids silently dropped + audited. Cost cap applies to every inbound dispatch. Webhook secret rotatable from env.

## Outcome

**Shipped.** All five waves complete on branch `feat/telegram-bridge`. 53 telegram-specific tests pass per file. Build clean. Ready for PR.

Deployment + BotFather `setWebhook` (PLAN.md T15) intentionally NOT executed here — orchestrator opens the PR and the deploy step runs after merge.

## What shipped

### Wave 1 — Foundations
- `hub/src/db/schema.sql` (mod) — additive: `users.telegram_chat_id` BIGINT UNIQUE, `telegram_default_session_id`, `telegram_link_code`, `telegram_link_code_expires_at`; `telegram_inbound_log` table with `(user_id, received_at DESC)` index. Idempotent.
- `hub/src/db/dal.ts` (mod) — Telegram DAL helpers folded inline (not separate `telegram-dal.ts`; see Deviations).
- `hub/src/config.ts` (mod) — `config.telegram.{botToken,webhookSecret,botUsername}`, all optional.
- `hub/src/telegram/client.ts` (new) — `sendMessage` / `getFile` / `getFileContent`, `escapeMarkdownV2`, `splitForTelegram`, per-chat serial queue, 10s `AbortSignal.timeout`.
- `hub/src/telegram/link-codes.ts` (new) — 8-char Crockford base32, 10-min TTL, single-use, constant-time compare.

### Wave 2 — Inbound webhook
- `hub/src/api/telegram-webhook.ts` (new) — `POST /api/telegram/webhook/:secret`, mounted ahead of JWT + license + CSRF. Raw body before parse, constant-time URL-secret compare, zod `Update` envelope, audit row per accepted request, `(chat_id, update_id)` dedupe.
- `hub/src/telegram/commands.ts` (new) — `/start`, `/session`, `/list`, `/help` parser + handlers.
- `hub/src/telegram/dispatch.ts` (new) — `enforceCostCap` → `session-queue.enqueue` → agent socket. Photo (largest-by-area + base64) and document (text/* embed; binary reject). Throttled cap-reached reply.
- `hub/src/index.ts` (mod) — webhook mounted outside auth catch-all.

### Wave 3 — Outbound bridge
- `hub/src/events/assistant-events.ts` (new) — internal `EventEmitter`, `assistant_message:final`.
- `hub/src/ws/agent.ts` (mod) — emits `assistant_message:final` at existing finalize branch. Additive.
- `hub/src/db/dal.ts` (mod) — `getUsersWithTelegramDefaultSession`.
- `hub/src/telegram/bridge.ts` (new) — outbound subscriber. Default-session match gate. `splitForTelegram` + MarkdownV2 `sendMessage`. Errors swallowed.
- `hub/src/index.ts` (mod) — bridge started at boot.

### Wave 4 — REST + Web UI
- `hub/src/api/telegram.ts` (new) — `GET /status`, `POST /link-code`, `DELETE /link`, `PUT /default-session`. Cookie auth + CSRF. Plain Hono.
- `hub/src/csrf.ts` (mod) — Telegram REST covered by existing middleware.
- `hub/src/index.ts` (mod) — authed REST mounted inside auth catch-all.
- `web/src/components/SettingsPage.tsx` (mod) — inline Telegram subsection. bot_configured / linked / unlinked states. Link-code mint + deep link. Default-session dropdown. Unlink confirm.

### Wave 5 — Docs + QC + ship
- `docs/telegram-bridge.md` (new).
- `CLAUDE.md` (mod) — Phase 12 section appended.
- `.planning/phases/12-telegram-bridge/SUMMARY.md` (this file).

## File inventory

**Hub new (8):** `hub/src/api/telegram-webhook.ts`, `hub/src/api/telegram.ts`, `hub/src/events/assistant-events.ts`, `hub/src/telegram/bridge.ts`, `hub/src/telegram/client.ts`, `hub/src/telegram/commands.ts`, `hub/src/telegram/dispatch.ts`, `hub/src/telegram/link-codes.ts`.

**Hub modified (6):** `hub/src/config.ts`, `hub/src/csrf.ts`, `hub/src/db/dal.ts`, `hub/src/db/schema.sql`, `hub/src/index.ts`, `hub/src/ws/agent.ts`.

**Web modified (1):** `web/src/components/SettingsPage.tsx`.

**Tests new (5, 53 tests, 269 expects):** `hub/test/telegram-api.test.ts` (15), `hub/test/telegram-bridge.test.ts` (8), `hub/test/telegram-client.test.ts` (12), `hub/test/telegram-link-codes.test.ts` (4), `hub/test/telegram-webhook.test.ts` (14).

**Docs / planning new (2):** `docs/telegram-bridge.md`, `.planning/phases/12-telegram-bridge/SUMMARY.md`.

**Docs modified (1):** `CLAUDE.md`.

## Test results

Per-file (clean — recommended run mode):

| File | Pass | Fail | Expects |
|---|---|---|---|
| `telegram-api.test.ts` | 15 | 0 | 36 |
| `telegram-bridge.test.ts` | 8 | 0 | 13 |
| `telegram-client.test.ts` | 12 | 0 | 28 |
| `telegram-link-codes.test.ts` | 4 | 0 | 152 |
| `telegram-webhook.test.ts` | 14 | 0 | 40 |
| **Total** | **53** | **0** | **269** |

Full hub suite (`bun test hub/test/`): **447 pass, 99 skip, 29 fail, 1 error**.

Of the 29 fails:
- **7 are telegram-client cross-file `mock.module` pollution** (`escapeMarkdownV2` × 2, `splitForTelegram` × 5). Same tests pass cleanly per file (verified above). Pre-existing Bun harness artifact noted across W3 + W4 — NOT a Phase 12 regression.
- **22 are pre-existing fails on `main`** unrelated to telegram: `insertRunV2 started_at safety` (5), `insertDeploymentRun started_at safety` (1), `supervisor-registry reconnect race` (2), `verifyLicenseJwt` golden vectors (11 — JWKS), plus a few `(unnamed)` rows from the same suites.

`bun run build:web`: **clean**. 376 modules, 743 kB / 211 kB gzipped. Size warning pre-existing.

No `lint` / `typecheck` npm script exists. `bun run docs:sync` not run — Telegram routes stay plain Hono in v1; nothing to regenerate in `docs/openapi.json` / `docs/api.md`.

## Commits (`a57172d..HEAD`, 19 base commits + W5 docs commit)

```
0793322 feat(12-4-ui): Telegram subsection in SettingsPage
2a9c0db test(12-4): cover authed Telegram REST endpoints (15 tests)
e716f83 feat(12-4-mount): wire authed Telegram REST router under /api/telegram
6117df0 feat(12-4-routes): authenticated Telegram REST endpoints
cffd589 test(12-3): cover telegram outbound bridge (8 tests)
bb1dbef feat(12-3-boot): start Telegram outbound bridge at hub boot
b9f6c98 feat(12-3-bridge): outbound bridge forwards final assistant messages to Telegram
dd61d10 feat(12-3-dal): add getUsersWithTelegramDefaultSession lookup
bb93e1d feat(12-3-events): add assistant_message:final event bus + emit from ws/agent
401aed5 test(12-2): cover telegram inbound webhook end-to-end
fe68ad5 feat(12-2-mount): mount telegram webhook before JWT + license + CSRF guards
50842af feat(12-2-commands): telegram inbound webhook route
e935ba5 feat(12-2-webhook): telegram command parser + inbound dispatch
d2c2af9 test(12-1): unit cover telegram client + link-code generator
ac5dd9c feat(12-1-dal): add telegram DAL helpers
abf4d21 feat(12-1-client): add telegram api client + link-code helpers
5a95e89 feat(12-1-config): add optional telegram bot config block
749a1c5 feat(12-1-schema): add telegram_chat_id + telegram_inbound_log
a57172d plan(12): telegram bridge phase
```

## Deviations from PLAN.md

1. **DAL location.** PLAN.md T1 specified `hub/src/db/telegram-dal.ts`. Implementation folded helpers into the existing `hub/src/db/dal.ts` to match the prevailing per-feature pattern. Helper surface unchanged.
2. **Event bus filename.** PLAN.md T8 suggested `hub/src/events/bus.ts`; implementation used `hub/src/events/assistant-events.ts` — more specific, avoids implying a general-purpose bus when only one event is published.
3. **Test file granularity.** PLAN.md named 3 files; implementation shipped 5 for tighter per-concern isolation (`-client`, `-link-codes`, `-webhook`, `-bridge`, `-api`). Each independently runnable.
4. **Settings UI inlined.** Plan said "subsection inside existing `SettingsPage.tsx` (NOT a new page)". Implemented inline rather than as a separate `SettingsTelegramSection.tsx`. Same UX, less indirection.
5. **OpenAPI sync skipped.** PLAN.md T14 gated `docs:sync` on route migration to `@hono/zod-openapi`; Phase 12 routes stayed plain Hono per the v1 convention. Public webhook intentionally NOT in OpenAPI (URL-secret surface).
6. **T15 deploy + BotFather `setWebhook` deferred to post-merge.** Out of scope for this wave per orchestrator handoff.

## Rollout / rollback

**Rollout:**
1. Merge PR.
2. Coolify `remo-code` env: set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (random URL-safe 32+ chars), `TELEGRAM_BOT_USERNAME` (no `@`).
3. Redeploy.
4. `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://app.remo-code.com/api/telegram/webhook/<SECRET>"`.
5. Smoke: link own account via Settings → Telegram, send "hi", confirm reply.

**Rollback:**
1. Unset `TELEGRAM_BOT_TOKEN` + redeploy. Bridge silently no-ops; webhook short-circuits via `bot_configured=false`.
2. Or `deleteWebhook` against BotFather to stop Telegram delivery entirely.
3. Schema additive + nullable — no DB rollback.
4. Legacy per-user `hub/src/scheduler/post-run/telegram.ts` preserved for one release — existing `user_integrations` outbound notifications continue working.

## Deferred

- Group chats, voice, video, stickers, animations, video notes, inline keyboards, message editing, streaming partial replies — explicit v1 out-of-scope.
- OpenAPI migration of authed `/api/telegram/*` routes — defers to codebase-wide sweep.
- Bun cross-file `mock.module` pollution fix — pre-existing harness artifact.
- T15 prod deploy + BotFather `setWebhook` + prod smoke — runs post-merge.

## Verification checklist (gsd-verifier)

- [ ] `bun test hub/test/telegram-api.test.ts` → 15 pass
- [ ] `bun test hub/test/telegram-bridge.test.ts` → 8 pass
- [ ] `bun test hub/test/telegram-client.test.ts` → 12 pass
- [ ] `bun test hub/test/telegram-link-codes.test.ts` → 4 pass
- [ ] `bun test hub/test/telegram-webhook.test.ts` → 14 pass
- [ ] `bun run build:web` → clean
- [ ] `docs/telegram-bridge.md` exists; covers setup, commands, architecture, security, limits, file map.
- [ ] `CLAUDE.md` has Phase 12 section in Phase 06/07 shape.
- [ ] `hub/src/api/telegram-webhook.ts` mounted ahead of JWT + license + CSRF catch-alls in `hub/src/index.ts`.
- [ ] `hub/src/api/telegram.ts` mounted inside the auth catch-all.
- [ ] Auth-fail (401) path writes no audit row (`telegram-webhook.test.ts`).
- [ ] `(chat_id, update_id)` dedupe on Telegram retries (`telegram-webhook.test.ts`).
- [ ] Outbound bridge gates on default-session match (`telegram-bridge.test.ts`).
- [ ] Bridge swallows `sendMessage` errors (`telegram-bridge.test.ts`).
- [ ] Schema additions additive + nullable.
- [ ] Legacy `hub/src/scheduler/post-run/telegram.ts` untouched.
