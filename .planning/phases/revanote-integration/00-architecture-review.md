# Revanote Integration — Architecture Review

**Status:** Pre-implementation review. Awaiting user green-light.
**Reviewer:** Backend Architect (remo-code)
**Date:** 2026-05-26
**Reference impl:** `C:/Users/artic/GitHub/revanote-hook/server.js` (Wrangler/Pages websites flow)
**Target:** New `app`-mode in revanote that routes annotations into remo-code supervisor sessions instead of standing up a parallel webhook service.

---

## 1. Recommended high-level design

A new first-class module `hub/src/revanote/` that mirrors the shape of `hub/src/error-capture/` (public token+HMAC webhook → dedupe/cap gates → per-session queue claim via `scheduler/session-queue.ts` → dispatch as `user_message` → finalize on next `assistant_message` → POST callback). Annotations are NOT folded into the scheduler's `task_kind` enum — they are inbound, externally-triggered, callback-bound work units with a different lifecycle than scheduled fan-out. They DO reuse the scheduler's `dispatcher.enforceCostCap` and `pickSessionTarget` helpers verbatim so the daily $ cap and per-supervisor concurrency budget apply.

Repo→app mapping lives in a new table `revanote_app_mappings(user_id, hostname_pattern, repo_path, supervisor_id, deploy_strategy)` with a JSONB fallback `users.revanote_default_mapping` for the smart "first supervisor root deployed at that host" path. Per-user Settings UI under Settings → Revanote.

The Claude session itself performs git ops + push; remo-code does NOT shell out to Wrangler. Default deploy strategy is **PR-mode** (branch + `gh pr create`, optional auto-merge label) — safer for production apps. Per-user toggle to `direct-push` for parity with the website flow. Coolify auto-deploys on push, so no separate redeploy step is needed.

---

## 2. Answers to the six open questions

### Q1. New module vs. fold into scheduler `task_kind`?
**New module `hub/src/revanote/`.** Reasons:
- Scheduler task_kinds are time-triggered, hub-originated, and fan-out. Revanote is webhook-triggered, externally-originated, and 1:1.
- Lifecycle differs: scheduler runs are fire-and-forget with optional post-run actions; revanote runs MUST POST a callback with a specific JSON contract regardless of success/failure.
- Mixing them bloats `scheduled_task_runs` semantics and the Schedules UI.
- BUT reuse the primitives: `enforceCostCap`, `pickSessionTarget`, `session-queue.claim`, `agent-sender.ts`, and the `parseTriageOutput`-style envelope parser.

### Q2. Where does repo→app mapping live?
**New table `revanote_app_mappings`** (relational, queryable, indexable on `hostname_pattern`) — NOT JSONB on `users`. Pattern matching needs LIKE/regex against `page_url` host; JSONB scan per webhook is wasteful and un-indexable.

```sql
CREATE TABLE revanote_app_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname_pattern text NOT NULL,         -- e.g. 'app.foo.com' or '*.foo.com'
  repo_path       text NOT NULL,          -- absolute path inside supervisor root
  supervisor_id   text,                   -- NULL = any supervisor that has the path
  deploy_strategy text NOT NULL DEFAULT 'pr',  -- 'pr' | 'direct' | 'none'
  auto_merge      boolean NOT NULL DEFAULT false,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_revanote_mappings_user_host ON revanote_app_mappings(user_id, hostname_pattern) WHERE enabled = true;
```

Smart fallback: if no row matches, scan the user's supervisor-reported repo list for a `git remote get-url origin` host that matches `page_url` host. Cache the resolution in `revanote_app_mappings` with `auto_created=true` for next time (require user confirmation in UI before enabling).

### Q3. Agent prompt envelope format?
**Reuse the `<<JSON>>...<<END>>` envelope from the reference impl, validated by a Zod schema mirroring `parseTriageOutput`.** Schema:

```ts
const RevanoteResult = z.object({
  resolved: z.boolean(),
  action_taken: z.string().min(1).max(500),
  agent_reply: z.string().max(2000).optional(),
  files_changed: z.array(z.string()).default([]),
  needs_clarification: z.boolean().default(false),
  clarification_question: z.string().optional(),
});
```

Tolerate ```json fences (same as `parseTriageOutput`). The envelope markers `<<JSON>>` / `<<END>>` are kept for backward-compat with the reference impl's prompt — easier for an experienced annotation-prompting prompt to migrate. Place parser in `hub/src/revanote/result-schema.ts`.

### Q4. Direct push vs. PR?
**Per-user `deploy_strategy` on the mapping row, default `pr`.** Three values:
- `pr` (default): create branch `revanote/annotation-<id>`, commit, push, open PR. If `auto_merge=true`, merge immediately via gh CLI (squash). Coolify deploys on main merge.
- `direct`: commit on main, push directly. For solo/low-stakes apps. Matches reference impl autonomy.
- `none`: agent edits, does NOT push. User reviews locally. Mostly for debugging.

The reference impl's website flow is essentially `direct` + Wrangler. Apps deserve `pr` as the default because production blast radius is larger and Coolify auto-deploy means a bad merge ships to users immediately.

### Q5. Retry on transient failures?
Annotations are durable (`annotation_runs` row created on inbound webhook). Hub-side retry policy:
- Webhook signature invalid / token mismatch → **no retry**, 401/403, no row.
- Session offline > 10 min grace → reuse `error-capture/grace.ts` pattern, buffer up to 10 min, then mark `status='failed_offline'` and POST callback with `error='session_offline'`.
- Agent run exception or schema-parse failure → mark `status='failed'`, POST callback, expose **Retry** button in `#/revanote` UI that re-enqueues the same `annotation_id` (idempotent via unique `(annotation_id)` index — retries get a new `annotation_runs` row but the same annotation key).
- Callback POST failure → exponential backoff (1m, 5m, 15m, 1h, dead-letter), persist last error on the run row. Revanote MUST be idempotent on its end (already implied by "no retry on revanote side" gotcha — confirm with revanote owner).

### Q6. Show runs in Schedules UI or own page?
**Own page: `#/revanote`.** Schedules UI is already dense (search + filters + last-run chips). Revanote runs have annotation-specific fields (screenshot thumbnail, comment text, page_url, resolution status) that don't fit the scheduler row. Reuse the Schedules drawer pattern (`ScheduleRunsDrawer.tsx`) for the per-annotation run-history drawer.

---

## 3. Module + file layout to create

```
hub/src/revanote/
  auth.ts                   # parse X-Revuu-Signature + URL token, constant-time HMAC verify
  webhook.ts                # POST /api/revanote/webhook/:user_id/:token (mounted OUTSIDE JWT guard, like sentry-intake)
  dispatcher.ts             # claim session via session-queue, send to agent, finalize on assistant_message
  resolve-mapping.ts        # hostname_pattern lookup + smart-fallback
  prompt.ts                 # renderAnnotationPrompt(annotation, mapping, repo_path)
  result-schema.ts          # Zod RevanoteResult + parseRevanoteOutput (tolerates ```json fences + <<JSON>>...<<END>>)
  callback.ts               # POST callback_url with bearer auth, exponential backoff queue
  callback-queue.ts         # in-memory queue + retry scheduler; DB-backed via revanote_callback_attempts
  grace.ts                  # 10-min offline buffer (mirrors error-capture/grace.ts)
  deploy-strategy.ts        # pr | direct | none branch logic appended to the prompt
  run-lifecycle.ts          # finalize on next assistant_message in the bound session

hub/src/api/
  revanote-mappings.ts      # CRUD for revanote_app_mappings (JWT-authed)
  revanote-runs.ts          # list + detail + retry endpoints (JWT-authed)
  account.ts                # ADD: revanote_webhook_secret rotate/get (parallel to coolify_webhook_secret)

hub/src/db/schema.sql       # ADD: revanote_app_mappings, annotations, annotation_runs, revanote_callback_attempts, users.revanote_webhook_secret

hub/src/ws/protocol.ts      # ADD: 'annotation_received' | 'annotation_dispatched' | 'annotation_resolved' events

web/src/components/
  RevanotePage.tsx          # #/revanote — annotation list + status filter + retry button
  RevanoteRunDrawer.tsx     # per-annotation run history (mirrors ScheduleRunsDrawer)
  RevanoteMappingsEditor.tsx# Settings → Revanote (mappings + secret rotate)
  RevanoteDetailDrawer.tsx  # screenshot + comment + replies + resolution

hub/test/
  revanote-webhook.test.ts
  revanote-result-schema.test.ts
  revanote-mapping-resolve.test.ts
  revanote-callback-retry.test.ts

docs/revanote.md            # architecture, webhook contract, prompt envelope, deploy strategies
```

DB tables (idempotent `CREATE TABLE IF NOT EXISTS` in `hub/src/db/schema.sql`):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS revanote_webhook_secret text;

CREATE TABLE IF NOT EXISTS annotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  annotation_id   text NOT NULL,                  -- revanote-side id
  page_url        text NOT NULL,
  screenshot_url text,
  x               numeric, y numeric,
  element_selector text,
  comment         text NOT NULL,
  replies_json    jsonb NOT NULL DEFAULT '[]',
  callback_url    text NOT NULL,
  mapping_id      uuid REFERENCES revanote_app_mappings(id),
  status          text NOT NULL DEFAULT 'pending', -- pending|dispatched|resolved|failed|failed_offline
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, annotation_id)
);
CREATE INDEX idx_annotations_user_status ON annotations(user_id, status);

CREATE TABLE IF NOT EXISTS annotation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id   uuid NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  session_id      text NOT NULL,
  status          text NOT NULL,                  -- running|resolved|failed
  resolved        boolean,
  action_taken    text,
  agent_reply     text,
  files_changed   jsonb NOT NULL DEFAULT '[]',
  deployed        boolean NOT NULL DEFAULT false,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX idx_annotation_runs_annotation ON annotation_runs(annotation_id);

CREATE TABLE IF NOT EXISTS revanote_callback_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id   uuid NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  attempt_no      int NOT NULL,
  http_status     int,
  error           text,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  next_retry_at   timestamptz
);
CREATE INDEX idx_callback_attempts_retry ON revanote_callback_attempts(next_retry_at) WHERE next_retry_at IS NOT NULL;
```

---

## 4. Recommended phase / PR breakdown (5 PRs)

**PR 1 — Webhook ingress + persistence (foundation).**
- `revanote_webhook_secret` column + rotate/get endpoint
- `POST /api/revanote/webhook/:user_id/:token` (HMAC verify, persist `annotations` row, 202)
- Tables: `annotations`, `revanote_app_mappings`, `annotation_runs`, `revanote_callback_attempts`
- Tests: HMAC verify, token mismatch, malformed body, replay window
- No dispatch yet — just intake. Mirrors the Coolify webhook absorb pattern.

**PR 2 — Mapping resolution + Settings UI.**
- `resolve-mapping.ts` with hostname-pattern match + smart fallback
- CRUD `/api/revanote/mappings`
- Settings → Revanote tab: mappings table, secret rotate, deploy_strategy dropdown
- Tests: pattern precedence, auto-fallback, disabled rows

**PR 3 — Dispatch + agent prompt + envelope parse.**
- `prompt.ts` (renderAnnotationPrompt with deploy_strategy directive)
- `result-schema.ts` (`<<JSON>>...<<END>>` + ```json fence tolerant parser)
- `dispatcher.ts` (cost-cap → session-queue.claim → agent send → finalize on next `assistant_message`)
- `grace.ts` (10-min offline buffer; reuse error-capture pattern)
- Tests: envelope parse edge cases, cost-cap gate, queue claim, finalize lifecycle

**PR 4 — Callback delivery + retry queue.**
- `callback.ts` POST with `Authorization: Bearer <secret>`
- `callback-queue.ts` exponential backoff (1m, 5m, 15m, 1h, dead-letter)
- `revanote_callback_attempts` audit rows
- Tests: success, 5xx retry, 4xx no-retry, dead-letter

**PR 5 — Web UI (`#/revanote`) + observability.**
- `RevanotePage.tsx`, `RevanoteRunDrawer.tsx`, `RevanoteDetailDrawer.tsx`
- WS events `annotation_received` / `annotation_dispatched` / `annotation_resolved`
- Retry button → `POST /api/revanote/runs/:id/retry`
- `docs/revanote.md`

Each PR is independently shippable behind a feature flag (`REMO_REVANOTE_ENABLED=true`) until PR 5 ships the UI.

---

## 5. Risks

1. **Auth surface widens.** Two new public webhook endpoints (`/api/revanote/webhook/...` joins `/api/coolify/webhook/...` and `/api/sentry/...`). Same URL-token+HMAC pattern as PR #44, but every new public path is a new auth perimeter. Mitigation: identical raw-body-before-parse discipline, constant-time compare, 5-min timestamp skew, `revanote_webhook_attempts` audit rows for forensic review.

2. **Cost-cap interaction.** Annotations are user-driven and burstier than scheduled tasks. A user spamming comments during a design review could blow the daily cap and starve scheduled triage runs. Mitigation: `enforceCostCap` applies uniformly, AND add a per-source budget split (e.g. revanote may consume max 60% of daily cap) configurable in Settings. Surface "throttled by cap" in the callback so revanote can show a banner to the user.

3. **Concurrent annotations on the same repo.** Two comments → two Claude sessions → race on `git push`. Mitigation: `session-queue.ts` already serializes per-session (1 in-flight + 1 waiter). Additionally, scope the queue key to `(supervisor_id, repo_path)` not `session_id` — annotations against the same repo serialize even if user adds a second annotation while the first is mid-flight.

4. **Callback retry storms.** Revanote being down briefly should not DDoS it on recovery. Mitigation: jittered exponential backoff, dead-letter after ~24h, expose `Force Retry` in UI for manual recovery. Confirm revanote-side idempotency on the `annotation_id`.

5. **PR-mode auto-merge collisions.** Auto-merge of revanote-generated PRs while a human PR is open could break the human's work or hit merge conflicts. Mitigation: PR-mode bot uses a `revanote/*` branch namespace, never merges if base branch has changed since branch-off without re-running the agent.

6. **Mapping ambiguity.** Multiple hostname patterns matching the same URL (e.g. `*.foo.com` vs `app.foo.com`). Mitigation: most-specific-pattern-wins; tie-broken by most-recently-updated. Surface ambiguity warning in Settings UI.

7. **Stacktrace/PII leakage.** Comments may include sensitive copy from staging environments piped into Claude. Mitigation: same trust model as existing in-session content; mention in `docs/revanote.md` privacy section.

8. **`<<JSON>>...<<END>>` parser brittleness.** Claude occasionally double-fences, omits END marker, or interleaves prose. Mitigation: tolerant parser that finds the LAST valid JSON object between markers OR in a fenced block; reject with structured error logged to the run row; expose raw output in `RevanoteRunDrawer` for debugging.

9. **Wrangler→Coolify mental model gap.** The reference impl deploys synchronously inside the hook process (waits for `wrangler deploy` to finish before callback). Remo-code design has Claude push, then Coolify deploys asynchronously. The callback's `deployed: true` flag therefore means "pushed to deploy branch", NOT "live in production". Document this contract clearly — or extend with a Coolify deploy-status poll before callback (slower but more accurate).

10. **`claude_*_threshold_pct` gate (PR #52) applies.** Same uniformity argument as cost-cap. If a user is over their token threshold, annotations should be queued with backoff or rejected with `error='budget_threshold'` in the callback.

---

## 6. Files to reuse / extend (exact paths)

| Purpose | Existing file | Action |
|---|---|---|
| URL-token + HMAC auth pattern | `hub/src/api/coolify-webhook.ts` | Pattern reference; copy verify discipline |
| Session-queue claim | `hub/src/scheduler/session-queue.ts` | Reuse verbatim |
| Cost cap | `hub/src/scheduler/dispatcher.ts → enforceCostCap` | Reuse |
| Target routing | `hub/src/scheduler/dispatcher.ts → pickSessionTarget` | Reuse |
| Concurrency budget | `hub/src/supervisor/concurrency.ts` (PR #25) | Reuse |
| Threshold gate | `hub/src/scheduler/budget-gate.ts` (PR #52) | Reuse |
| Envelope parser pattern | `hub/src/scheduler/triage-schema.ts` | Pattern reference |
| Grace buffer | `hub/src/error-capture/grace.ts` | Pattern reference; near-duplicate ok |
| Webhook secret column | `hub/src/db/dal.ts → *CoolifyWebhookSecret` | Add parallel `*RevanoteWebhookSecret` |
| Audit log table | `coolify_webhook_attempts` | Add parallel `revanote_webhook_attempts` |
| WS event registration | `hub/src/ws/protocol.ts` | Add 3 new events |
| Settings tab shell | `web/src/components/SettingsPage.tsx` | Add "Revanote" tab |

---

## 7. Deliverable & next steps

- Architecture review: **this file**.
- DO NOT IMPLEMENT until user green-lights.
- After green-light: open `feat/revanote-integration` worktree off `origin/main` (per project rule), start PR 1.
- Coordinate any `hub/src/ws/protocol.ts` edit with the Phase 05 session (shared file, line-level coordination).
- Update `docs/revanote.md` in the same commit as PR 1 (per rule #14 / API docs convention).
