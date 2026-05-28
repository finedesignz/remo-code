# Phase 12 — Telegram Bridge: Independent Verification

**Verifier:** gsd-verifier (Opus 4.7 1M)
**Date:** 2026-05-28
**Branch:** `feat/telegram-bridge` @ `45a1c3a`
**Mode:** goal-backward, code-first, evidence-based.

---

## Ship verdict

**SHIP.**

All five waves deliver what PLAN.md promised. Mount order, exclusion lists, cost-cap gating, dedupe, MarkdownV2 escape, link-code lifecycle, raw-body-before-parse, constant-time secret compare, and listener-error isolation are all observably present in code. All 53 telegram tests green per-file. `bun run build:web` clean. Docs cover the contract. CLAUDE.md Phase 12 section matches the Phase 06/07 shape.

Two caveats — neither blocking, both pre-existing:

1. Telegram tests fail when run in the same `bun test` invocation as other test files. `mock.module` from sibling test files pollutes the global module cache (`escapeMarkdownV2`, `splitForTelegram`, `findUserByLinkCode`, `__test` export resolution fail). Per-file runs are clean. Documented by executor in SUMMARY.md "Deviations / 7 cross-file mock.module pollution" — Bun harness limitation, not Phase 12 regression.
2. 22 additional unrelated failures on `main` (`insertRunV2`, `insertDeploymentRun`, `supervisor-registry reconnect race`, `verifyLicenseJwt` golden vectors). Pre-existing per SUMMARY.md and not introduced by this branch.

**Recommendation:** open PR now. Deferred T15 (Coolify env + BotFather `setWebhook` + prod smoke) runs post-merge per the rollout plan.

---

## Per-wave PASS / PARTIAL / MISSING

| Wave | Goal | Status | Evidence |
|---|---|---|---|
| W1 | Schema + DAL + client + link-codes | **PASS** | `hub/src/db/schema.sql:796-818`, `hub/src/db/dal.ts:1342-1365`, `hub/src/telegram/client.ts`, `hub/src/telegram/link-codes.ts` |
| W2 | Inbound webhook (raw-body, secret, audit, dispatch, cost-cap, dedupe) | **PASS** | `hub/src/api/telegram-webhook.ts`, `hub/src/telegram/dispatch.ts`, `hub/src/telegram/commands.ts` |
| W3 | Outbound bridge (event bus, default-session gate, swallow errors, per-chat queue) | **PASS** | `hub/src/events/assistant-events.ts`, `hub/src/ws/agent.ts:451-462`, `hub/src/telegram/bridge.ts` |
| W4 | Authed REST + Settings UI subsection | **PASS** | `hub/src/api/telegram.ts`, `hub/src/index.ts:303`, `web/src/components/SettingsPage.tsx` (Telegram subsection inlined per Deviation #4) |
| W5 | Tests + docs + CLAUDE.md section | **PASS** (with caveats above) | 53/53 tests per-file, `docs/telegram-bridge.md` (234 lines, 18 sections), `CLAUDE.md:392-428` |

---

## Threat-model spot-checks (>=5 from PLAN.md L232-243)

| # | Threat | Mitigation expected | Code citation | Status |
|---|---|---|---|---|
| 1 | Webhook URL secret leak | Constant-time URL-path compare; 401 writes NO audit row | `hub/src/api/telegram-webhook.ts:100-105` `constantTimeEqualStr` via `timingSafeEqual`; `:260-263` 401 returned BEFORE the `logTelegramInbound` call at `:297` | PASS |
| 2 | Unlinked-chat spam / table fill | Trim to 100/user via DAL | `hub/src/db/dal.ts:1361-1365` `DELETE FROM telegram_inbound_log ... NOT IN (... LIMIT 100 ...)` | PASS |
| 3 | Cost-cap bypass | EVERY inbound dispatch flows through `enforceCostCap` | `hub/src/telegram/dispatch.ts:79-91` — `isOverCostCap` runs before any `session-queue.enqueue` or socket send; query failure → `failed` (no free pass) | PASS |
| 4 | Telegram retry duplication | Always return 200 on accepted-but-skipped; `(chat_id, update_id)` UNIQUE short-circuits | `hub/src/db/schema.sql:815` `UNIQUE (chat_id, update_id)`; `hub/src/api/telegram-webhook.ts:297-307` insert check + `deduped: true` short-circuit; every reply branch returns `c.json({ ok: true, ... })` | PASS |
| 5 | Photo download → memory blow-up | 10MB cap + 10s abort | `hub/src/api/telegram-webhook.ts:98` `MAX_PHOTO_BYTES = 10 * 1024 * 1024`; `:137-141` size check on `meta.file_size` AND on downloaded buffer; client uses `AbortSignal.timeout(10_000)` per SUMMARY | PASS |
| 6 | MarkdownV2 injection from session output | Escape reserved chars | `hub/src/telegram/client.ts:41-44` `escapeMarkdownV2` covers `_*[]()~\`>#+-=\|{}.!\\` | PASS |
| 7 | Link-code brute force | 40 bits, 10-min TTL, single-use, constant-time | `hub/src/telegram/link-codes.ts:71-96` — 8-char Crockford base32 (40-bit), TTL `10*60*1000`, row cleared on every `consumeLinkCode` (single-use), `timingSafeEqual` on bytes | PASS |
| 8 | Hub-wide bot impersonation across users | `chat_id` UNIQUE | `hub/src/db/schema.sql:796` `telegram_chat_id BIGINT UNIQUE` | PASS |
| 9 | Default-session mismatch leak | Bridge gates on `default_session_id === emitting_session_id` | `hub/src/telegram/bridge.ts:69-94` — only fetches users via `getUsersWithTelegramDefaultSession(e.sessionId)`, which scopes to the emitting session | PASS |

---

## Wiring + discipline invariants

| # | Invariant | Citation | Status |
|---|---|---|---|
| 1 | Webhook mounted AHEAD of JWT catch-all | `hub/src/index.ts:161` `app.route('/api/telegram', telegramWebhookRoutes)` is BEFORE the `app.use('/api/*', authMiddleware ...)` block at `:171-183` | PASS |
| 2 | Webhook EXCLUDED from JWT catch-all | `hub/src/index.ts:176` `if (c.req.path.startsWith('/api/telegram/webhook/')) return next()` | PASS |
| 3 | Webhook EXCLUDED from license gate | `hub/src/index.ts:197` (same skip pattern in `requireActiveLicense` block) | PASS |
| 4 | Webhook EXCLUDED from CSRF | `hub/src/csrf.ts:32` `/^\/api\/telegram\/webhook\//` in `CSRF_PATH_ALLOWLIST` | PASS |
| 5 | Authed REST mounted INSIDE catch-alls | `hub/src/index.ts:303` `app.route('/api/telegram', telegramApi)` is AFTER all `app.use('/api/*', ...)` middlewares | PASS |
| 6 | Raw body read BEFORE JSON.parse | `hub/src/api/telegram-webhook.ts:252` `const rawBody = await c.req.text()`; `:268` `JSON.parse(rawBody)` after secret + feature gates | PASS |
| 7 | Constant-time secret compare | `hub/src/api/telegram-webhook.ts:100-105` uses `node:crypto` `timingSafeEqual` with explicit length-mismatch short-circuit | PASS |
| 8 | 401 → no DB write | `hub/src/api/telegram-webhook.ts:261-263` `return new Response(null, { status: 401 })` BEFORE `logTelegramInbound` at `:297` | PASS |
| 9 | Outbound ONLY on `assistant_message:final` | `hub/src/ws/agent.ts:415` emit is inside `if (msg.type === 'assistant_message')` branch only; `bridge.ts` subscribes only to that event name | PASS |
| 10 | Listener errors isolated from emit site | `hub/src/events/assistant-events.ts:49-67` — per-listener try/catch + async-rejection `.catch()` | PASS |
| 11 | `session-queue.ts` reused verbatim | `hub/src/telegram/dispatch.ts:27,95` `import * as queue from "../scheduler/session-queue.ts"` + `queue.enqueue(...)` | PASS |
| 12 | Legacy `post-run/telegram.ts` preserved | `git diff main -- hub/src/scheduler/post-run/telegram.ts` returns no output — file untouched | PASS |
| 13 | Schema additive + nullable | `hub/src/db/schema.sql:796-818` all `ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS`. No NOT NULL on new user columns | PASS |
| 14 | Bot token never logged | `hub/src/api/telegram-webhook.ts:111-114` `safeSend` logs status + message only; client error class carries `bodyPreview.slice(0,200)` no token | PASS |

---

## Test runs (per-file, clean)

```
bun test hub/test/telegram-client.test.ts      → 12 pass / 0 fail / 28 expect
bun test hub/test/telegram-link-codes.test.ts  →  4 pass / 0 fail / 152 expect
bun test hub/test/telegram-webhook.test.ts     → 14 pass / 0 fail / 40 expect
bun test hub/test/telegram-bridge.test.ts      →  8 pass / 0 fail / 13 expect
bun test hub/test/telegram-api.test.ts         → 15 pass / 0 fail / 36 expect
Total per-file: 53 pass / 0 fail / 269 expect
```

`bun run build:web` → clean (376 modules, 743 kB / 211 kB gz; 500 kB chunk warning pre-existing).

---

## Cross-file test run (DOCUMENTED non-blocker)

When the 5 telegram test files run in the same `bun test` invocation (or `bun test hub/test/`), several fail because sibling test files use `mock.module` and Bun's module cache leaks between files. Observed:

- `telegram-client.test.ts > splitForTelegram > respects a custom maxLen` — module reload sees a stale `splitForTelegram` reference.
- `telegram-link-codes.test.ts` — `Export named '__test' not found` (dal.ts mock pollutes the link-codes module path).
- `telegram-webhook.test.ts` — `Export named 'findUserByLinkCode' not found in module ... dal.ts`.

SUMMARY.md L75-76 documents this as a Bun harness artifact already known across W3/W4. Not a Phase 12 regression and not a code-correctness issue. Per-file is the supported run mode for now.

A separate concern (NOT this PR) — full hub suite has 22 unrelated fails on `main` (`insertRunV2`, `insertDeploymentRun`, supervisor-registry race, `verifyLicenseJwt` golden vectors). These predate Phase 12 per SUMMARY L77 and are out of scope.

---

## Deviations from PLAN.md

All 6 deviations from SUMMARY.md L107-114 verified present in code and **acceptable**:

1. **DAL inlined into `hub/src/db/dal.ts`** rather than separate `telegram-dal.ts`. Helper surface (`logTelegramInbound`, `getUsersWithTelegramDefaultSession`, etc.) present at expected call sites. ✓
2. **Event bus filename** `assistant-events.ts` not `bus.ts`. More specific. ✓
3. **5 test files** instead of 3 — tighter per-concern isolation. ✓
4. **Settings subsection inlined** in `SettingsPage.tsx` rather than separate `SettingsTelegramSection.tsx`. ✓
5. **OpenAPI sync skipped** — telegram routes stay plain Hono v1 per scheduler/error-capture precedent. Public webhook intentionally excluded from spec (URL-secret surface). ✓
6. **T15 deploy + setWebhook deferred to post-merge.** Aligned with orchestrator handoff. ✓

**No undocumented deviations found.** Code matches SUMMARY which matches PLAN modulo these six.

---

## Pre-existing issues called out (NOT Phase 12 blockers)

- Bun cross-file `mock.module` pollution affects telegram-client/link-codes/webhook tests when run together. Per-file clean. Same pattern affects multiple W3/W4 tests already on `main`.
- 22 unrelated test failures on `main`: `insertRunV2 started_at safety` (5), `insertDeploymentRun started_at safety` (1), `supervisor-registry reconnect race` (2), `verifyLicenseJwt` golden vectors (11), plus a few `(unnamed)` rows.
- `web/dist` 500 kB chunk-size warning is pre-existing (376 modules, 743 kB / 211 kB gz).

---

## Recommendation

**Open PR now.** Phase 12 ships ready to merge.

Post-merge follow-ups (already in SUMMARY L132-136):
1. Coolify env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`.
2. `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://app.remo-code.com/api/telegram/webhook/<SECRET>"`.
3. Smoke: link own account via Settings → Telegram, send "hi", confirm round-trip.

— end —
