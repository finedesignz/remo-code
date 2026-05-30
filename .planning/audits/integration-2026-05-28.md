# Integration audit — 2026-05-28

Scope: WS protocol contracts, `/ws/agent` + `/ws/client` lifecycle, REST↔WS bridges,
CSRF + license-gate, public webhook auth (Coolify / Sentry / Titanium), scheduler
dispatcher + grace + post-run, error-capture pipeline, schema↔code drift.
HEAD `5e3674d`. Frontend + orchestrator paths skipped per brief.

## Critical (data loss, auth bypass, security hole)

- **Triage task INSERT violates schema CHECK** — `hub/src/db/dal.ts:585` (and the
  scheduled-tasks API at `hub/src/api/scheduled-tasks.ts:42`) insert
  `task_type='triage'`, but `hub/src/db/schema.sql:170` constrains task_type to
  `('prompt','skill','security_scan','log_check','continue_dev')` — no `triage`.
  Reproducer: any successful Coolify `deployment.failed` webhook → `dispatchTriage` →
  `ensureInternalTriageTask` → `INSERT … 'triage' …` raises Postgres 23514 and
  the 202 path silently swallows it (`void dispatchTriage(...).catch(...)` at
  `coolify-webhook.ts:212`). Net: zero triage runs in prod despite green tests.
  Fix: ship the planned migration in `.planning/phases/11-…/PLAN.md:114` to drop
  + re-add the constraint with `'triage'` included; idempotent.

- **Magic-link callback sets cookie then redirects — cookie may not persist** —
  `hub/src/api/auth.ts:285`. `c.redirect('/')` produces a 302; while Hono *does*
  carry the `Set-Cookie` header on redirect responses, this is fragile: any
  Cloudflare/Coolify proxy that strips Set-Cookie on 30x (some reverse-proxy
  configs do for cache safety) breaks login silently. Combined with no
  diagnostic page the user just bounces to `/` unauthenticated. Suggested:
  render a tiny HTML page that does `location.replace('/')` after the
  `Set-Cookie` has demonstrably been accepted, OR add an integration test that
  asserts the cookie round-trip through the deployed edge.

## High (silent drop, race condition, contract drift)

- **`subscribe` refine is a no-op — empty payload passes** —
  `hub/src/ws/protocol.ts:41-44`. The `.refine` accepts `session_id` OR
  `session_ids` of length `>= 0`, so `{ type: 'subscribe' }` (neither field)
  parses successfully because `session_ids` defaults to `undefined`, not `[]`,
  and the `||` short-circuits. The handler at `client.ts:167` then treats
  `requested = []`, calls `subscribeClient(entry, [])` and silently clears the
  user's subscription set. Wire a malformed-payload client → its real chat goes
  dark with no error. Fix: `(d) => !!d.session_id || Array.isArray(d.session_ids)`.

- **Stale agent socket leaks `streamingBySession` state on close** —
  `hub/src/ws/agent.ts`. `handleAgentClose` (line 688) does NOT
  `streamingBySession.delete(sessionId)`. If a runner disconnects mid-stream the
  in-memory placeholder + buffered deltas live forever (keyed by sessionId).
  When the same session reconnects and a new turn begins, the old `flushTimer`
  may fire and `appendToMessage` to a now-`interrupted` placeholder, polluting
  the message row. The same sessionId is reused via `findOrCreateAgentSession`,
  so this is the common path, not the edge case.

- **`sendRequest` to a supervisor never times out the response on socket close** —
  `hub/src/ws/supervisor-registry.ts:60-66`. `unregisterSupervisor` walks
  `entry.pendingReqs` and rejects them — good — BUT the reconnect-race guard at
  line 59 (`if (ws && entry.ws !== ws) return`) means a close arriving AFTER the
  supervisor has reconnected is ignored entirely. Any `sendRequest` in flight
  when the supervisor flapped will hang for the full `timeoutMs` (default 30s,
  up to 300s in some callers) because both the old socket and the new socket
  use the same `supervisorId` key. The pending request was created against the
  OLD `entry.pendingReqs` map, which is GC'd when the new register replaced it,
  so the timeout fires correctly but the promise resolves never — only the
  setTimeout reject path saves us. Net: REST callers (e.g. `error-setup.ts:101`
  with `15_000` ms) block their handler thread for the full window on every
  supervisor reconnect race. Fix: when `registerSupervisor` evicts the prior
  entry (line 30-32), drain `e.pendingReqs` with a `supervisor_replaced` reject
  before replacement.

- **`recentlyDisconnectedForProjectDir` is called with `__supervisor__`** —
  `hub/src/ws/agent.ts:201`. The supervisor branch returns at line 170 so
  it never reaches line 201, BUT a supervisor that sends `role: 'supervisor'`
  AND has its API key fail capability check ends up at line 173 (the agent
  fallback `verifyApiKey`). For a real agent that happens to use `project_dir =
  '__supervisor__'` (vanishingly unlikely but not enforced), the disconnect
  check would match unrelated rows. Minor; flag and move on.

- **CSRF self-heal on cookie users without a session token is silently broken
  during request body consumption** — `hub/src/csrf.ts:157-173`. The self-heal
  re-issues a CSRF cookie when the session is valid but the csrf cookie is
  missing. But this runs BEFORE the route handler reads the body. Hono's body
  is single-read; if a downstream middleware (e.g. account.ts) also calls
  `c.req.json()`, the original POST works — but the request that triggered the
  self-heal returns `next()` and proceeds with NO CSRF check at all. That's the
  intended behavior (allowed self-heal), but the threat-model comment claims
  "SameSite=Lax blocks cross-site POST" — true for top-level navigation but
  Lax also allows top-level GETs that read the cookie. Lax+self-heal is sound
  here but worth verifying that the cookie's actual `SameSite` value is Lax
  (it is, `session.ts:62`).

- **Coolify webhook idempotency placeholder isn't written before Octokit call** —
  `hub/src/scheduler/post-run/github-issue.ts:174-180`. Comment says "Record
  placeholder before API call to narrow the race window" but the placeholder
  recording is a stray `void hash` — the actual `recordOpenIssueForHash` runs
  only AFTER `octokit.issues.create` succeeds (line 211). A second webhook
  arriving in the ~500ms-2s Octokit window for the same `(repo, app_uuid,
  deploy_uuid)` will create a duplicate GitHub issue. Coolify retry semantics
  on webhook timeouts make this plausible. Fix: insert placeholder with
  `issue_number=0` before Octokit, update on success, delete on terminal
  failure.

- **`broadcastToSubscribers` JSON-stringifies once per call but `for…of clients`
  is O(N_clients · N_sessions)** — `hub/src/ws/registry.ts:70`. Each broadcast
  scans the entire `clients` Set. With 100+ active SPA tabs this is unbounded
  per text_delta on a hot session. Today's web cap (12 sessions/conn) limits
  Set membership but a single grid-view user with 12 hot streams produces
  12 × 30Hz × N_clients RAF work on the hub. Latency under load, not
  correctness; mark as High because text_delta is the highest-rate event in
  the system.

## Medium (latency, observability, error-path gaps)

- **`broadcastScheduledRun` accepts the dispatcher's payload but the dispatcher
  emits `status: 'skipped_quota'` (not in schema)** — `hub/src/ws/protocol.ts:100`
  vs `hub/src/scheduler/dispatcher.ts:133`. Schema enum: `'pending' |
  'in_flight' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'`.
  Dispatcher broadcasts `'skipped_quota'`. The validated broadcaster
  (`registry.ts:99`) drops the event with a console.warn — so the run row
  flips state in DB but the web UI never receives the lifecycle event. The
  list-row poll will eventually pick it up; the run-history drawer's live
  view does not.

- **License-gate refresh fails open on `TitaniumApiError` but logs nothing** —
  `hub/src/license-gate.ts:154-159`. A network blip during refresh preserves
  the cached `ACTIVE` and silently returns. If Titanium is down for days and
  the cache TTL expires while the user is active, every request quietly
  bypasses re-validation. Add a `console.warn` at minimum so deploy logs show
  the drift.

- **Error-capture grace replay re-enters `dispatchPendingError` which re-uses
  the SAME error row** — `hub/src/error-capture/grace.ts:43`. If the session
  was offline → grace-parked → reconnects but threshold-blocked at
  dispatcher.ts:74, the row is marked `skipped(quota_threshold_reached)` and
  the error is lost. No replay queue, no notify. This is correct by design
  but the user has no signal beyond the email throttle.

- **`extractSentryKey` regex accepts whitespace-bounded key** —
  `hub/src/error-capture/auth.ts:9`. Pattern `sentry_key=([^,\s]+)` works on
  the documented Sentry header format but will also accept
  `sentry_key=abc,sentry_key=def` (matches first). Not exploitable today
  because lookup is `getErrorProjectBySentryKey` and one match suffices; flag.

- **Coolify webhook `handleAuthenticated` does NOT use `parseAsync` for the
  EVENT_ALIAS transform** — `hub/src/api/coolify-webhook.ts:187`. The transform
  is synchronous so `safeParse` is fine here, but a future async refinement
  would break with no compile-time signal. Pin via comment.

- **Heartbeat ping on `/ws/agent` is unconditional fire-and-forget** —
  `hub/src/ws/agent.ts:168, 295`. If the underlying socket is half-open, the
  hub never observes the failed write — it only sees the absence of `pong`,
  but there is no pong-timeout. A wedged supervisor stays "online" in the
  registry until Bun's TCP layer closes the socket (minutes). The client-side
  `send_message` half-open detection (`client.ts:316`) is the only safety net.
  Add a missed-pong counter.

- **`onAgentReply` (error-capture) and `onAssistantMessage` (scheduler/agent)
  both fire on the same assistant_message** — `hub/src/ws/agent.ts:432-449`.
  Each runs `queue.markFinished(sessionId)` (error-capture via
  `run-lifecycle.ts:75`, scheduler indirectly via `finalizeRun`→queue). With
  both an error-run and a scheduled-run somehow active on the same session,
  the queue waiter is double-promoted. The session-queue cap of 1+1 should
  prevent this in practice; assertion or single-source-of-truth would harden.

- **`schedule-rules`-based tasks: catchup walks `cron_expr` only** —
  `hub/src/scheduler/catchup.ts:27`. If a user has only `schedule_rules`
  populated (no legacy `cron_expr`), catchup returns no missed fires and
  silently does nothing on boot. Verify the DAL backfills `cron_expr` from
  `rule[0]` on write (claimed in schema comment, not re-checked here).

## Notes (out-of-scope but worth recording)

- The Phase 04 `pickSessionTarget` referenced by `triage.ts:62` and `sessions.ts`
  lives in `hub/src/sessions/routing.ts` — not read this pass per scope. Triage
  is fully wired pending the Critical above.
- `/webhooks/titanium/license-changed` is mounted outside `/api/*` so it
  correctly bypasses csrfGuard and the license gate. `recordAuthEvent` reuses
  `'license_check_failed'` event_type for the success path (`webhooks-titanium.ts:113`)
  — misleading audit value; consider `'license_changed_webhook'`.
- `TITANIUM_REQUIRE_REDIS=true` is enforced on the magic-link callback path
  (`auth.ts:105`) — invariant holds. Good.
- The legacy Coolify HMAC route returns `Deprecation: true` + Sunset header,
  but `markUserCoolifyWebhookLegacyHit` is fire-and-forget — a flood of legacy
  webhooks each spawns an unawaited promise. Bounded by request rate.
- `subscribeClient` REPLACES the Set (line 65 registry.ts) which is the
  documented Phase 03 behavior — confirmed.
