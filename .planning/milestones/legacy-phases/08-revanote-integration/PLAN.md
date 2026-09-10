# Phase 08 — Revanote Integration: Execution Plan

**Branch:** `feat/phase-08-revanote-integration`
**Worktree:** `C:/Users/artic/GitHub/remo-code-phase-08-revanote`
**Context:** [`08-CONTEXT.md`](./08-CONTEXT.md)
**Architect review:** [`../revanote-integration/00-architecture-review.md`](../revanote-integration/00-architecture-review.md)

## Waves

### Wave 1 — Data + auth foundations
- **Plan 001 — Schema migrations.** Additive ALTERs + new tables in `hub/src/db/schema.sql`:
  - `users.revanote_webhook_secret TEXT NULL`
  - `users.revanote_budget_pct INTEGER NULL` (1..100; NULL = default 60)
  - `annotations(id UUID PK, user_id, annotation_id_external TEXT, page_url, annotation_url, screenshot_url, x, y, element_selector, comment, replies_json JSONB, callback_url, mapping_id NULL, status TEXT, source_ip TEXT, received_at, dispatched_at, resolved_at, payload_raw JSONB)` + UNIQUE `(user_id, annotation_id_external)` + indexes
  - `annotation_runs(id UUID PK, annotation_id FK, session_id, user_id, status, resolved BOOL, action_taken TEXT, agent_reply TEXT, files_changed JSONB, deployed BOOL, error TEXT, cost_usd NUMERIC, duration_ms INT, started_at, finished_at)`
  - `revanote_app_mappings(id UUID PK, user_id, hostname_pattern, repo_path, supervisor_id NULL, deploy_strategy TEXT CHECK pr|direct|none, auto_merge BOOL, enabled BOOL, auto_created BOOL, created_at, updated_at)`
  - `revanote_callback_attempts(id UUID PK, annotation_id FK, attempt_no INT, http_status INT NULL, error TEXT, attempted_at, next_retry_at NULL)` + partial index on `next_retry_at WHERE next_retry_at IS NOT NULL`
  - `revanote_webhook_attempts(id UUID PK, user_id, received_at, source_ip, event_type, status TEXT, reason TEXT, raw_body_preview TEXT)` capped 100/user
- **Plan 002 — DAL helpers** in `hub/src/db/revanote-dal.ts`: secret get/rotate/status; webhook-attempts insert+list+cap; mapping CRUD + best-match resolver; annotation insert+update; run insert+update; callback-attempts insert+claim+update.

### Wave 2 — Inbound webhook
- **Plan 003 — `hub/src/api/revanote-webhook.ts`**: `POST /api/revanote/webhook/:user_id/:token` mounted outside JWT/license/CSRF catch-all. Constant-time URL-token compare. Read raw body BEFORE JSON.parse. Verify `X-Revuu-Signature: sha256=<hex>` HMAC over raw body using same secret. 5-min timestamp skew if `timestamp` present in body. Zod-validate, persist `annotations` row, audit row, kick off dispatcher (fire-and-forget). Respond `202 { accepted: true, annotation_id }`.
- **Plan 004 — Account API + CSRF allowlist:** `POST /api/account/revanote-webhook-secret/rotate` returns `{ user_id, token, webhook_url, webhook_secret }`. `GET /api/account/revanote-webhook-secret`. `GET /api/account/revanote-webhook-attempts`. Add `/api/revanote/webhook/` to `csrf.ts` allowlist + index.ts auth/license skip lists.

### Wave 3 — Routing, prompt, dispatcher
- **Plan 005 — Result schema + parser** `hub/src/revanote/result-schema.ts`: `RevanoteResult` zod (`resolved`, `action_taken`, `agent_reply?`, `files_changed[]`, `needs_clarification`, `clarification_question?`) + `parseRevanoteOutput` (envelope `<<JSON>>...<<END>>` first, ```json fence fallback, then bare-prose `resolved:false`).
- **Plan 006 — Prompt builder** `hub/src/revanote/prompt.ts`: render storage prefix `[revanote: <30-grapheme preview via Intl.Segmenter>]\n\n<full prompt>` and the agent prompt body (page_url, annotation_url, element_selector, screenshot_url, comment, replies, mapping deploy_strategy, repo_path, envelope instructions).
- **Plan 007 — Dispatcher** `hub/src/revanote/dispatcher.ts`: mirrors `error-capture/dispatcher.ts`. Steps: resolve mapping (best-match) → resolve session (mapping.supervisor_id → existing session for repo_path; else `pickSessionTarget`) → cost-cap (`enforceCostCap` via the dispatcher's `isOverCostCap` helper) → threshold gate → session-queue claim (key `revanote:${supervisor_id}:${repo_path}` OR fall back to `sessionId`) → grace if offline → insert run + register lifecycle → `insertMessage` storage prefix + `user_message` send → broadcast `revanote_dispatched`.
- **Plan 008 — Run lifecycle** `hub/src/revanote/run-lifecycle.ts`: on next `assistant_message` for the session, finalize run, parse envelope via `parseRevanoteOutput`, persist into `annotation_runs`, broadcast `revanote_callback_sent` (status sent), enqueue callback via `revanote_callback_attempts`. Mirror error-capture lifecycle shape (register/getActive/onAgentReply/onAgentError).
- **Plan 009 — Grace (offline 10-min buffer)** `hub/src/revanote/grace.ts`: keyed by `sessionId`, replays on next agent connect via existing drain hook in `ws/agent.ts`. Mirror `error-capture/grace.ts`. Sweep loop start in `index.ts`.

### Wave 4 — Outbound callback
- **Plan 010 — Callback sender** `hub/src/revanote/callback.ts`: render JSON payload (`annotation_id, resolved, action_taken, agent_reply?, files_changed[], deployed, error?`). `POST <callback_url>` with `Authorization: Bearer <revanote_webhook_secret>` 10s timeout. 4xx → mark `dead`, 5xx + network → schedule next retry per `1m → 5m → 15m → 1h → dead-letter` with ±10% jitter. Worker loop polls `revanote_callback_attempts WHERE next_retry_at <= now()` every 30s, claims via `UPDATE … RETURNING id`. Start/stop in `index.ts` like the grace sweep.

### Wave 5 — Wiring + WS events + UI surfacing
- **Plan 011 — WS protocol** add `revanote_received`, `revanote_dispatched`, `revanote_callback_sent` to `hub/src/ws/protocol.ts` (discriminated union + `HubToClient` cases) and a `broadcastRevanoteEvent` in `hub/src/ws/registry.ts`.
- **Plan 012 — Agent ws hook + grace drain.** In `hub/src/ws/agent.ts` `assistant_message` block, after error-capture finalize add a revanote finalize via `revanote/run-lifecycle.ts`. On agent connect/reconnect, drain revanote grace queue for relevant sessions.
- **Plan 013 — Web pill in `MessageBubble`** + new `web/src/lib/revanote-message.ts` (`parseRevanotePrefix` + `stripRevanoteEnvelope`). Violet pill linking to `annotation_url`. Strip `<<JSON>>...<<END>>` from assistant render.

### Wave 6 — Settings + Revanote page
- **Plan 014 — Mapping CRUD API** `hub/src/api/revanote-mappings.ts`: list/create/update/delete + best-match resolver test endpoint. JWT + license + CSRF gated.
- **Plan 015 — Annotations API** `hub/src/api/revanote-annotations.ts`: list with filters, get-by-id, force-retry endpoint that re-dispatches via dispatcher.
- **Plan 016 — Settings → Revanote tab** in `web/src/components/SettingsPage.tsx`: webhook URL display + rotate button + attempts log + budget pct slider + mappings table CRUD.
- **Plan 017 — `#/revanote` page** `web/src/components/RevanotePage.tsx` (list + filters) + `RevanoteDetailDrawer.tsx` (detail + force retry).

### Wave 7 — Tests + Docs + OpenAPI + PR
- **Plan 018 — Tests** `hub/test/revanote-*.test.ts`: webhook (auth, hmac, raw-body, audit), rotate, schema, dispatcher (offline/busy/cap/budget/grace), callback (retry curve), envelope parser.
- **Plan 019 — Docs.** New `docs/revanote.md`. Update `CLAUDE.md` Phase 08 section. Run `bun run docs:sync` to regenerate OpenAPI spec.
- **Plan 020 — PR, deploy, cleanup.** Push, open PR, self-review, admin-merge, verify health.

## Acceptance criteria
1. Webhook POST with valid URL-token+HMAC inserts annotation, dispatches to bound session, response 202.
2. Bad token → 401 + audit `auth_failed`. Bad HMAC → 401 + audit `hmac_failed`. No timing oracle.
3. Storage row in `messages` carries `[revanote: …]\n\n…` prefix; web renders violet pill clickable to `annotation_url`.
4. Agent reply with `<<JSON>>{...}<<END>>` parses, finalizes run, posts callback, callback retries 1/5/15/60 min on 5xx.
5. Cost cap exceeded → no dispatch, callback `error: 'budget_threshold'` (or `cap_exceeded`), `annotation.status='failed'` with reason.
6. Offline session → grace 10-min, replays on agent reconnect; expiry → `failed_offline`.
7. Concurrent annotations against same `(supervisor_id, repo_path)` serialize via session-queue.
8. `bun test` green; `bun run build:web` green; `tsc --noEmit` zero errors hub + web; docs-drift CI green.
