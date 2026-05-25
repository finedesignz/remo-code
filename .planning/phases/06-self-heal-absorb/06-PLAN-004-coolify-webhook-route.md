---
phase: 06-self-heal-absorb
plan: 004
type: execute
wave: 2
depends_on: [06-PLAN-001-schema-migration]
files_modified:
  - hub/src/api/coolify-webhook.ts
  - hub/src/index.ts
  - hub/src/db/dal.ts
  - hub/test/coolify-webhook.test.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "POST /api/coolify/webhook accepts HMAC-signed Coolify deployment events"
    - "Invalid/missing signature → 401; valid signature → 202"
    - "deployment.failed event persists a scheduled_task_runs row with deployment metadata"
    - "deployment.succeeded event persists metadata-only row with status=success, no triage spend"
    - "Replay (>5min skew) rejected with 401"
  artifacts:
    - path: "hub/src/api/coolify-webhook.ts"
      provides: "Public webhook route handler with HMAC verify + persist"
      exports: ["coolifyWebhookRoutes"]
    - path: "hub/src/db/dal.ts"
      provides: "getUserByCoolifyWebhookId() DAL helper"
  key_links:
    - from: "POST /api/coolify/webhook"
      to: "scheduled_task_runs (insert with deployment_* fields)"
      via: "DAL after HMAC verify"
    - from: "deployment.failed handler"
      to: "scheduler triage dispatch (plan 008 wire-up)"
      via: "stubbed call surface — actual dispatch lives in plan 008"
---

<objective>
Mount a public `POST /api/coolify/webhook/:user_id` route on the hub that verifies HMAC, persists deployment metadata into `scheduled_task_runs`, and emits a stub dispatch hook for triage runs. Triage routing lands in plan 008; this plan ships the ingress + storage.

Purpose: G2 + G5 absorption (deployment webhook ingest + metadata).
Output: New route file, DAL helper, integration test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/06-self-heal-absorb/06-CONTEXT.md
@hub/src/index.ts
@hub/src/api/scheduled-tasks.ts
@hub/src/scheduler/post-run/webhook.ts
@hub/src/db/dal.ts
@C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create coolify-webhook route + HMAC verification + persist metadata</name>
  <files>hub/src/api/coolify-webhook.ts, hub/src/db/dal.ts, hub/src/index.ts</files>
  <read_first>
    - hub/src/index.ts (route mounting pattern — how other routers are app.route()'d)
    - hub/src/scheduler/post-run/webhook.ts (existing HMAC sign() helper — reuse `createHmac('sha256', key).update(body).digest('hex')` pattern with constant-time compare)
    - C:/Users/artic/GitHub/coolify-ai-monitor/src/index.js (lines 264-323 — webhook payload field names: `deployment_uuid`, `application_uuid`, `git_repository`, `commit_sha`, `status`)
    - hub/src/db/scheduled-tasks-dal.ts (`insertRunV2` signature and `RunStatus` type)
    - .planning/phases/06-self-heal-absorb/06-CONTEXT.md §"Webhook ingress (G2 + G5)"
  </read_first>
  <action>Create `hub/src/api/coolify-webhook.ts` exporting a Hono router `coolifyWebhookRoutes`. Route: `POST /api/coolify/webhook/:user_id` (user_id in path so the handler can look up the per-user secret without a JWT — the JWT-protected version is on the rotate endpoint in plan 005). Handler flow: (1) read raw body via `await c.req.text()` BEFORE any JSON parse — needed for HMAC; (2) read header `x-coolify-signature` (case-insensitive); reject 401 if missing; (3) read header `x-coolify-timestamp` (unix seconds); reject 401 if missing OR `Math.abs(nowSec - ts) > 300` (5-min skew); (4) load user via new DAL helper `getUserCoolifyWebhookSecret(userId: string): Promise<string | null>`; if null → 401 `{ error: 'webhook_not_configured' }`; (5) compute `expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')` and compare to header using `crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))` — wrap in length check first to avoid throw; mismatch → 401; (6) JSON.parse(rawBody), validate with Zod schema `CoolifyWebhookPayload = z.object({ event: z.enum(['deployment.failed','deployment.succeeded','deployment.in_progress']), deployment_uuid: z.string().min(1), application_uuid: z.string().min(1), git_repository: z.string().optional(), commit_sha: z.string().optional() })`; (7) for `deployment.succeeded` or `deployment.in_progress`: INSERT a scheduled_task_runs row with `task_id=null` (allow null — note schema implication: if FK currently forbids null, document this as a follow-up; for now use a sentinel reserved task UUID `00000000-0000-0000-0000-000000000006`-style internal task created lazily via `ensureInternalDeploymentTask(userId)`), `status='success'`, `target_kind='internal'`, `output_snippet=null`, `deployment_uuid`, `application_uuid`, `git_repository`, `commit_sha`; (8) for `deployment.failed`: same insert but `status='pending'` and immediately call `dispatchTriageStub(userId, runId, payload)` — define `dispatchTriageStub` as an exported NO-OP that logs `console.log('[coolify-webhook] triage stub:', { userId, runId, deployment_uuid })`. Plan 008 will replace the stub body with the real `pickSessionTarget` call. (9) Always return 202 `{ ok: true, run_id }` on success. Add DAL helper `getUserCoolifyWebhookSecret(userId: string): Promise<string | null>` in `hub/src/db/dal.ts` that does `SELECT coolify_webhook_secret FROM users WHERE id = $1`. Mount the router in `hub/src/index.ts` BEFORE any auth middleware that would block public routes — colocate with other public webhook mounts if any, else just before the JWT-guarded `/api/*` group.</action>
  <verify>
    <automated>cd hub ; bun test test/coolify-webhook.test.ts</automated>
  </verify>
  <done>Route mounted; HMAC verify works (constant-time compare); valid failed event inserts pending run with metadata; valid succeeded event inserts success row; invalid sig / stale timestamp / missing secret all return 401.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Integration test for webhook auth + persist paths</name>
  <files>hub/test/coolify-webhook.test.ts</files>
  <read_first>
    - hub/test/scheduled-tasks.e2e.test.ts (DB fixture pattern, REMO_E2E_DB_URL gating)
    - hub/src/api/coolify-webhook.ts (under test)
  </read_first>
  <behavior>
    - Missing signature header → 401
    - Stale timestamp (>5 min old) → 401
    - User has no webhook secret → 401
    - Valid signature + deployment.succeeded → 202, row exists with status=success and the four metadata columns populated
    - Valid signature + deployment.failed → 202, row exists with status=pending, dispatchTriageStub called once
    - Wrong-secret-derived signature → 401 even when timestamp is fresh
  </behavior>
  <action>Create `hub/test/coolify-webhook.test.ts` using `bun:test`. Spin up the Hono app in-test, seed a user with a known webhook secret directly via SQL, fire requests with hand-rolled HMAC signatures using node:crypto. Skip the file if `REMO_E2E_DB_URL` is unset. Spy on `dispatchTriageStub` by importing the module and replacing the export with a tracking shim, or assert via console.log capture if monkey-patch isn't clean. Clean up inserted rows in afterAll.</action>
  <verify>
    <automated>cd hub ; REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test test/coolify-webhook.test.ts</automated>
  </verify>
  <done>All six cases green when DB is set; file skips when not.</done>
</task>

</tasks>

<verification>
- `bun test hub/test/coolify-webhook.test.ts` green.
- `grep -n "coolifyWebhookRoutes" hub/src/index.ts` shows the mount line.
- Manual curl with a known-good signature returns 202.
</verification>

<success_criteria>
- HMAC verify is constant-time and rejects tampered bodies.
- Deployment metadata persisted on every accepted event.
- Triage dispatch is a callable stub ready for plan 008.
</success_criteria>

<output>
Create `.planning/phases/06-self-heal-absorb/06-004-SUMMARY.md` when done.
</output>
