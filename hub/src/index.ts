import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config'
import { authMiddleware } from './auth/middleware'
import { sessions } from './api/sessions'
import { messages } from './api/messages'
import { apiKeys } from './api/api-keys'
import { plugin } from './api/plugin'
import { setup } from './api/setup'
import { authRouter } from './api/auth'
import { profile } from './api/profile'
import { account } from './api/account'
import { supervisors as supervisorsApi, usersMe as usersMeApi } from './api/supervisors'
import { github as githubApi } from './api/github'
import { commands as commandsApi } from './api/commands'
import { transcribe as transcribeApi } from './api/transcribe'
import { scheduledTasks as scheduledTasksApi } from './api/scheduled-tasks'
import { scheduledTaskRuns as scheduledTaskRunsApi } from './api/scheduled-task-runs'
import { sentryIntake as sentryIntakeApi } from './api/sentry-intake'
import { errorProjectsRouter } from './api/error-projects'
import { errorsRouter } from './api/errors'
import { errorRunsRouter } from './api/error-runs'
import { chatTabs as chatTabsApi } from './api/chat-tabs'
import { repoGroups as repoGroupsApi } from './api/repo-groups'
import { instructions as instructionsApi } from './api/instructions'
import { errorSetup as errorSetupApi } from './api/error-setup'
import { coolifyWebhookRoutes } from './api/coolify-webhook'
import { revanoteWebhookRoutes } from './api/revanote-webhook'
import { telegramWebhookRoutes } from './api/telegram-webhook'
import { telegram as telegramApi } from './api/telegram'
import { revanoteMappings } from './api/revanote-mappings'
import { revanoteAnnotations } from './api/revanote-annotations'
import { webhooksTitanium } from './api/webhooks-titanium'
import { introspect as introspectApi } from './api/introspect'
import { tasks as tasksApi } from './api/tasks'
import { usage as usageApi } from './api/usage'
import { wellKnown } from './api/well-known'
import { clientConfig } from './api/client-config'
import { orchestrator as orchestratorApi } from './api/orchestrator'
import { orchestratorTasks as orchestratorTasksApi } from './api/orchestrator-tasks'
import { requireActiveLicense } from './license-gate'
import { openapi as openapiApp } from './api/_openapi'
import { runMigrations } from './db/migrate'
import { markOrphanedRunsInterrupted } from './db/scheduled-tasks-dal.ts'
// V2 scheduler.
import * as schedRegistry from './scheduler/registry.ts'
import * as schedCatchup from './scheduler/catchup.ts'
import { clearPendingTimers as clearPostRunTimers } from './scheduler/post-run/dispatcher.ts'
import { getGraceBuffer as getDispatchGraceBuffer } from './dispatch/grace.ts'
import { startRevanoteCallbackWorker } from './revanote/callback.ts'
import { startTelegramBridge } from './telegram/bridge.ts'
import { startRoutineQueueWorker, stopRoutineQueueWorker } from './orchestrator/queue.ts'
import { registerCycleRunnerIfEnabled, stopDueOrchestratorTick } from './orchestrator/controller.ts'
import { apiKeyMiddleware } from './auth/api-key-middleware'
import { rateLimit, rateLimitMulti } from './middleware/rate-limit'
import { securityHeaders } from './middleware/security-headers'
import { csrfGuard } from './csrf'
import { requireRecentAuth } from './auth/reauth'
import { requireAdmin } from './auth/require-admin'
import { adminRouter } from './api/admin'
import { recordAuthEvent } from './db/dal'
import { parseSessionCookieFromHeader } from './session'
import {
  createClientWsData, handleClientOpen, handleClientMessage, handleClientClose,
} from './ws/client'
import { isAllowedClientWsOrigin } from './ws/origin-guard'
import {
  createAgentWsData, handleAgentOpen, handleAgentMessage, handleAgentClose,
} from './ws/agent'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { log as obsLog } from './observability/logger'
import { withRequestId } from './observability/middleware'
import { setOfflineStaleAgentSessions, markStreamingMessagesAsInterrupted } from './db/dal.ts'
import { withHttpMetrics } from './observability/http-metrics'

// ════════════════════════════════════════════════════════════════════════════
// MOUNT-ORDER INVARIANT CONTRACT  (load-bearing — enforced by mount-order.test.ts)
// ════════════════════════════════════════════════════════════════════════════
// Hono runs `app.use`/`app.route` in registration order; that order IS the
// security boundary. These relations MUST hold. A reorder that breaks one is
// silent in prod but caught by hub/test/mount-order.test.ts (IR-8). The terse
// `// MUST be mounted BEFORE ...` notes at the original lines below point here.
//
//  (1) PUBLIC WEBHOOKS mount BEFORE the `/api/*` JWT/auth catch-all.
//      A webhook router registered AFTER the catch-all never matches first —
//      the catch-all's authMiddleware 401s it, OR (worse) it falls through to
//      static/SPA serving and returns 404, silently dropping ingress.
//        - /api/sentry          → sentryIntakeApi          (mounted ~L165)
//        - /api/coolify         → coolifyWebhookRoutes      (mounted ~L170)
//        - /api/revanote        → revanoteWebhookRoutes     (mounted ~L175)
//        - /api/telegram        → telegramWebhookRoutes     (mounted ~L181)
//        - /webhooks/titanium   → webhooksTitanium          (mounted ~L185)
//      The JWT/auth catch-all is `app.use('/api/*', ...)` (~L190) and its skip
//      list MUST include each webhook subpath (`/api/sentry/`, `/api/coolify/
//      webhook/`, `/api/revanote/webhook/`, `/api/telegram/webhook/`).
//      (`/webhooks/titanium` is outside `/api/*` so the catch-all never sees it.)
//
//  (2) LICENSE GATE mounts AFTER auth. `requireActiveLicense` reads `userId`
//      set by authMiddleware, so it MUST run after it (~L207, after ~L190).
//      Its skip list mirrors auth's so public webhooks never hit the gate.
//
//  (3) CSRF GUARD SKIPS the public webhook paths. `csrfGuard()` (~L222) is
//      registered after auth; its allowlist (hub/src/csrf.ts CSRF_PATH_ALLOWLIST)
//      MUST contain every webhook subpath so an unsigned-by-CSRF webhook POST
//      reaches the webhook's own auth instead of being 403'd by CSRF.
//
//  (4) /ws/agent IS KEYED BY api_keys, NOT user license. The agent WS upgrade
//      (in Bun.serve fetch) authenticates via api_keys and is NEVER routed
//      through requireActiveLicense — an expired-license user still observes
//      agent traffic read-only. No license check on the agent path.
// ════════════════════════════════════════════════════════════════════════════

export const app = new Hono()

// Observability: mint request_id + open ALS frame. Mounted FIRST so even the
// security-headers middleware and CORS responses inherit the request_id and
// every downstream log line carries it.
app.use('*', withRequestId())

// B4 (obs): record HTTP latency histogram. Mounted second so it sees the
// final status_class after all downstream handlers run.
app.use('*', withHttpMetrics())

// Global error handler — never leak internals
app.onError((err, c) => {
  obsLog.error('hono.onError', { error: err.message, path: c.req.path, method: c.req.method })
  return c.json({ error: 'internal error' }, 500)
})

// Phase 07-G: security headers (HSTS 2yr+preload, CSP, COOP/CORP, Permissions-
// Policy, X-Content-Type/Frame-Options, Referrer-Policy). Mounted FIRST so
// every response — including those from later middleware errors — carries them.
app.use('*', securityHeaders())

// CORS
app.use('/api/*', cors({
  origin: config.allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// Health check. Both `/health` and `/healthz` are liveness aliases (the Coolify
// probe + tooling hit `/healthz`); `/healthz/deep` (introspectApi below) is the
// bearer-gated readiness endpoint, NOT a substitute for this cheap liveness ping.
app.get('/health', (c) => c.json({ ok: true }))
app.get('/healthz', (c) => c.json({ ok: true }))

// B4 (obs): /healthz/deep + /metrics. Bearer-gated via HUB_INTROSPECT_TOKEN.
// Mounted at root — bypasses /api/* auth, CSRF, license-gate, rate-limit
// catch-alls. The bearer check IS the credential.
app.route('/', introspectApi)

// Phase 12.1: public deep-link association files for iOS Universal Links and
// Android App Links. No auth, no license gate. Mounted at root before any
// /api/* middleware so Apple/Google can fetch them anonymously.
app.route('/.well-known', wellKnown)

// Phase 07-G: rate-limit auth endpoints BEFORE mounting the router.
// request-link: 3/min/IP + 5/hr/email — `silent: true` so the response still
// looks identical to a normal 200 (login-enumeration prevention). The handler
// itself checks `c.get('rateLimited')` to skip the email send if needed.
async function readEmailForRateLimit(c: any): Promise<string | null> {
  try {
    const body = await c.req.json()
    const email = body?.email?.toLowerCase?.().trim?.()
    return typeof email === 'string' && email.includes('@') ? email : null
  } catch { return null }
}
function ipKey(c: any): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon'
}

app.use('/api/auth/login/request-link', async (c, next) => {
  // We need to read the body but Hono lets us re-read via `c.req.json()` again.
  const email = await readEmailForRateLimit(c)
  const mw = rateLimitMulti({
    silent: true,
    buckets: [
      { bucket: 'request-link-ip', windowMs: 60_000, max: 3, keyFn: () => ipKey(c) },
      { bucket: 'request-link-email', windowMs: 3_600_000, max: 5, keyFn: () => email },
    ],
    onLimit: async (cc, bucket) => {
      try {
        await recordAuthEvent({
          eventType: 'rate_limited',
          ip: ipKey(cc),
          userAgent: cc.req.header('user-agent') ?? null,
          metadata: { route: 'request-link', bucket: bucket.bucket, email },
        })
      } catch {}
    },
  })
  return mw(c, next)
})

app.use('/api/auth/login/callback', rateLimit({
  bucket: 'login-callback',
  windowMs: 60_000,
  max: 10,
  keyFn: ipKey,
}))

// Auth routes (no auth required)
app.route('/api/auth', authRouter)

// Setup routes (no auth required — guarded internally by user count check)
app.route('/api/setup', setup)

// Public client bootstrap config (single feature-gate boolean, no secrets).
// Exposes the hub's REMO_PTY_INTERACTIVE flag so the SPA's default human surface
// (TerminalSurface vs ChatSurface) stays in lockstep with the env flip.
// MUST be mounted BEFORE the JWT catch-all (see MOUNT-ORDER INVARIANT (1) at top).
app.route('/api/client-config', clientConfig)

// Plugin routes (API key auth — MUST be before JWT catch-all)
app.use('/api/plugin/*', rateLimit({ windowMs: 60_000, max: 30, keyFn: (c) => c.req.header('authorization')?.slice(0, 20) || 'anon' }))
app.use('/api/plugin/*', apiKeyMiddleware)
app.route('/api/plugin', plugin)

// Sentry-style error intake — public, sentry_key in X-Sentry-Auth IS the credential.
// MUST be mounted BEFORE the JWT catch-all (see MOUNT-ORDER INVARIANT (1) at top).
app.use('/api/sentry/*', rateLimit({ windowMs: 60_000, max: 600, keyFn: (c) => c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'anon' }))
app.route('/api/sentry', sentryIntakeApi)

// Public Coolify deployment webhook (HMAC-signed, per-user secret in URL).
// MUST be mounted BEFORE the JWT catch-all (see MOUNT-ORDER INVARIANT (1) at top).
app.route('/api/coolify', coolifyWebhookRoutes)

// Phase 08: Public Revanote annotation webhook (URL-token + HMAC, per-user
// secret embedded in path). MUST be mounted BEFORE the JWT catch-all
// (see MOUNT-ORDER INVARIANT (1) at top).
app.route('/api/revanote', revanoteWebhookRoutes)

// Phase 12: Public Telegram inbound webhook (URL-path secret). MUST be
// mounted BEFORE the JWT catch-all (see MOUNT-ORDER INVARIANT (1) at top).
// Auth is :secret in the URL, constant-time compared to config.telegram.webhookSecret.
app.route('/api/telegram', telegramWebhookRoutes)

// Public Titanium license-changed webhook (HMAC-signed, shared secret).
// MUST be mounted BEFORE the JWT catch-all (see MOUNT-ORDER INVARIANT (1) at top).
// Inert (503) until secret set.
app.route('/webhooks/titanium', webhooksTitanium)

// Protected API routes (JWT auth, then rate limit keyed on userId)
// Skip /api/github/callback — it's hit by GitHub's redirect, not by an authed client.
// Skip /api/sentry — public Sentry-style intake authenticates via X-Sentry-Auth header.
// Skip /api/coolify/webhook/* — public path, auth is per-user HMAC.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/github/callback') return next()
  if (c.req.path.startsWith('/api/sentry/')) return next()
  if (c.req.path.startsWith('/api/coolify/webhook/')) return next()
  if (c.req.path.startsWith('/api/revanote/webhook/')) return next()
  if (c.req.path.startsWith('/api/telegram/webhook/')) return next()
  // Phase 07: public auth endpoints (login request-link, callback, logout, me).
  // The authRouter handles its own auth state internally where needed.
  if (c.req.path.startsWith('/api/auth/')) return next()
  // Public setup bootstrap (guarded by user-count check inside).
  if (c.req.path.startsWith('/api/setup')) return next()
  // Public client bootstrap config (single feature-gate boolean, no secrets).
  if (c.req.path.startsWith('/api/client-config')) return next()
  return authMiddleware(c, next)
})
app.use('/api/*', rateLimit({ windowMs: 60_000, max: 120, keyFn: (c) => c.get('userId') || 'anon' }))

// Phase 07-D: License gate runs AFTER authMiddleware so it can read userId.
// `readOnlyOk: true` lets GET requests pass during the 7-day EXPIRED grace
// window; mutations always require ACTIVE. Same exclusion list as auth:
// /api/github/callback, /api/sentry/*, /api/coolify/webhook/* skip auth and
// therefore also skip the gate. /openapi.json and /docs are mounted outside
// /api/* so they are unaffected.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/github/callback') return next()
  if (c.req.path.startsWith('/api/sentry/')) return next()
  if (c.req.path.startsWith('/api/coolify/webhook/')) return next()
  if (c.req.path.startsWith('/api/revanote/webhook/')) return next()
  if (c.req.path.startsWith('/api/telegram/webhook/')) return next()
  if (c.req.path.startsWith('/api/auth/')) return next()
  if (c.req.path.startsWith('/api/setup')) return next()
  if (c.req.path.startsWith('/api/client-config')) return next()
  return requireActiveLicense({ readOnlyOk: true })(c, next)
})

// CSRF (Phase 07-C): double-submit cookie on mutating /api/* requests.
// Allowlist (sentry intake, coolify webhook, login/logout, plugin api-key,
// setup bootstrap, github oauth callback, health) lives in hub/src/csrf.ts.
// GET/HEAD/OPTIONS pass through.
app.use('/api/*', csrfGuard())

// Re-auth gate (Phase 07-C / C.5): elevated-impact ops require a session that
// is younger than 5 minutes (re-auth via fresh magic-link). Cookie-only —
// legacy bearer JWTs cannot satisfy because they carry no creation-time.
app.use('/api/api-keys', async (c, next) => {
  const m = c.req.method.toUpperCase()
  if (m === 'POST' || m === 'DELETE') return requireRecentAuth()(c, next)
  return next()
})
// NOTE: rotate intentionally does NOT require recent-auth. Legacy Bearer-JWT
// clients carry no session creation timestamp, so requireRecentAuth() would
// hard-fail them with `no_cookie_session` 401 with no client-side recovery.
// Cookie-auth users with a session >5 min old would also 401. Threat model
// for rotate: an attacker who already has the user's valid session/bearer
// can rotate the webhook secret — but they already control the account, so
// re-auth on rotate alone buys nothing. The userMutationLimit (10/min/user)
// below still applies. Sister gates on api-keys + error-projects DELETE
// remain — those grant credential issuance / data destruction.
app.use('/api/error-projects/:id', async (c, next) => {
  if (c.req.method.toUpperCase() === 'DELETE') return requireRecentAuth()(c, next)
  return next()
})

// Phase 07-G: per-user mutation rate-limit. 10/min/user on mutating methods
// of credential/state-bearing endpoints. Applied AFTER authMiddleware so the
// userId key is populated.
function isMutating(c: any): boolean {
  const m = c.req.method.toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}
const userMutationLimit = rateLimit({
  bucket: 'user-mutation',
  windowMs: 60_000,
  max: 10,
  keyFn: (c) => c.get('userId') || 'anon',
})
app.use('/api/api-keys', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/api-keys/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/scheduled-tasks', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/scheduled-tasks/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/error-projects', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/error-projects/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/account/coolify-webhook-secret/rotate', userMutationLimit)
app.use('/api/account/revanote-webhook-secret/rotate', userMutationLimit)

// REVIEW HI-01/02/03: step-up auth on Phase 12 sensitive endpoints.
// Prompts (claude_global_md / codex_agents_md / codex_config_toml) and
// supervisor roots both reach the supervisor filesystem; profile mutates
// user identity. Stolen-cookie attacker must re-auth before driving these.
app.use('/api/users/me/prompts', async (c, next) =>
  isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/users/me/profile', async (c, next) =>
  isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/supervisors/:id/roots', async (c, next) =>
  isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/users/me/prompts', async (c, next) =>
  isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/users/me/profile', async (c, next) =>
  isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/supervisors/:id/roots', async (c, next) =>
  isMutating(c) ? userMutationLimit(c, next) : next())
// Orchestrator: mutating endpoints require fresh login (15-min step-up).
app.use('/api/orchestrator', async (c, next) => isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/orchestrator/*', async (c, next) => isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/orchestrator', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/orchestrator/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/revanote/mappings', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/revanote/mappings/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.use('/api/revanote/annotations/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())

// Phase 07-G: admin endpoints. requireAdmin enforces role; requireRecentAuth
// enforces fresh session (≤5min). userMutationLimit applies to mutating ops.
app.use('/api/admin/*', requireAdmin())
app.use('/api/admin/*', async (c, next) => isMutating(c) ? requireRecentAuth()(c, next) : next())
app.use('/api/admin/*', async (c, next) => isMutating(c) ? userMutationLimit(c, next) : next())
app.route('/api/admin', adminRouter)

// OpenAPI sample route + /openapi.json + /docs (Scalar UI).
// Mounted ahead of plain-Hono routers so the documented twin of
// /api/profile/cost-today wins over the legacy plain version.
app.route('/', openapiApp)

app.route('/api/sessions', sessions)
app.route('/api/api-keys', apiKeys)
app.route('/api/messages', messages)
app.route('/api/profile', profile)
app.route('/api/account', account)
app.route('/api/supervisors', supervisorsApi)
app.route('/api/users/me', usersMeApi)
app.route('/api/github', githubApi)
app.route('/api/commands', commandsApi)
app.route('/api/transcribe', transcribeApi)
app.route('/api/scheduled-tasks', scheduledTasksApi)
app.route('/api/scheduled-task-runs', scheduledTaskRunsApi)
app.route('/api/tasks', tasksApi)
app.route('/api/usage', usageApi)
app.route('/api/error-projects', errorProjectsRouter)
app.route('/api/errors', errorsRouter)
app.route('/api/error-runs', errorRunsRouter)
app.route('/api/chat-tabs', chatTabsApi)
app.route('/api/repo-groups', repoGroupsApi)
app.route('/api/instructions', instructionsApi)
app.route('/api/error-setup', errorSetupApi)
// Phase 08: JWT-authed revanote sub-routes (mappings + annotations).
// The public webhook route lives at /api/revanote/webhook/* (mounted above).
app.route('/api/orchestrator', orchestratorApi)
// Phase 31 (auto-dev-orchestrator): authed config REST for the one-per-session
// orchestrator task + its rows. Data-only (controller path is flag-OFF). Mounted
// alongside the other authed user routes (post-auth catch-all).
app.route('/api/orchestrator-tasks', orchestratorTasksApi)
app.route('/api/revanote/mappings', revanoteMappings)
app.route('/api/revanote/annotations', revanoteAnnotations)
// Phase 12 Wave 4: authed Telegram REST. Mounted INSIDE the /api/* auth +
// CSRF + license-gate catch-alls above. The public webhook router was
// already mounted earlier at the same prefix (line ~160) and handles only
// /api/telegram/webhook/:secret — non-matching paths fall through to this
// router. The webhook is in the auth+CSRF+license skip lists; status /
// link-code / link / default-session are NOT — they require a valid cookie
// session and a matching X-CSRF-Token on mutating methods.
app.route('/api/telegram', telegramApi)

// ── Server boot ─────────────────────────────────────────────────────────────
// Everything below only runs when this module is the process entrypoint
// (`bun src/index.ts`). Importing `index.ts` in a test (mount-order.test.ts)
// gives the fully-configured `app` above WITHOUT booting Bun.serve, warming
// JWKS, installing self-capture, running migrations, or registering signal
// handlers. `import.meta.main` is true for the entrypoint, false on import.
if (import.meta.main) {
  await boot()
}

async function boot() {
// Resolve web dist directory (works both in Docker and locally)
const webDistCandidates = ['./web/dist', '../web/dist', resolve(__dirname, '../../web/dist')]
const webDist = resolve(webDistCandidates.find(p => existsSync(p)) || './web/dist')

// Track WS connections per IP for DoS protection
const wsConnectionsPerIp = new Map<string, number>()
const MAX_WS_CONNECTIONS_PER_IP = 100

function decrementIp(ip: string) {
  const count = wsConnectionsPerIp.get(ip) || 1
  if (count <= 1) wsConnectionsPerIp.delete(ip)
  else wsConnectionsPerIp.set(ip, count - 1)
}

// Phase 07-A: warm Titanium JWKS at boot if configured. Previously this was a
// hard refuse-to-bind gate — that was the wrong call. JWKS warm failure must
// NOT block the hub from binding its port: the hub serves many surfaces that
// don't need Titanium JWT verification (health checks, public webhooks, the
// web SPA, the scheduler, agent WS), and a stalled/404 Titanium endpoint
// should never take production down. Auth-gated routes fail closed at request
// time via `verifyLicenseJwt`, which lazily warms on first use. We log
// loudly so misconfiguration is still obvious in deploy logs.
if (config.titaniumBypass) {
  console.warn('[titanium] BYPASS mode active — JWKS warm skipped, license gate disabled, magic-link endpoints will 503')
} else if (config.titanium.keygenApiUrl) {
  try {
    const { warmJwksCache } = await import('./titanium-client')
    const keyCount = await warmJwksCache()
    console.log(`[titanium] JWKS warmed (${keyCount} keys)`)
  } catch (err) {
    console.error(
      '[titanium] JWKS warm failed at boot — continuing to bind port; ' +
      'auth-gated routes will retry warm on first verify and fail closed if still unavailable:',
      (err as Error).message,
    )
  }
}

// B2 (obs): hub self-error capture. Installs uncaughtException +
// unhandledRejection hooks, registers a wrapping app.onError that captures
// before responding, and seeds the `__hub_self__` error_projects row.
// Gated by HUB_SELF_OWNER_USER_ID; inert when unset. Dispatch is hard-off
// for self-errors (no feedback loop into a Claude session).
{
  const { installSelfCapture } = await import('./observability/self-capture')
  try {
    await installSelfCapture(app, config.hubSelfOwnerUserId)
  } catch (err) {
    console.error('[self-capture] install failed; continuing:', (err as Error)?.message ?? err)
  }
}

// Start Bun server with WebSocket upgrade handling.
//
// REVIEW BL-06: idleTimeout — Bun's default is 10s, which kills any HTTP
// request whose upstream WS round-trip takes longer (notably
// POST /api/supervisors/:id/scan, which fans out to the supervisor over WS
// with a 20s sendRequest budget, plus /clone at 300s). Hitting Bun's 10s
// before the WS reply arrives terminates the HTTP connection mid-flight,
// which Coolify's Traefik in turn surfaces as 502 Bad Gateway. Bump to 255s
// (5s above the longest sendRequest budget) so HTTP keep-alives never
// expire before the WS response can be serialized.
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades — with origin validation (C2 fix) and connection limits
    if (url.pathname === '/ws/client' || url.pathname === '/ws/agent') {
      // Origin / CSWSH check for browser clients (Phase 16 NH-3 / R-PTY-34).
      // The /ws/client cookie ⇒ human actor inference treats ANY authenticated
      // browser WS as human; a cross-site WebSocket handshake riding the user's
      // cookie could then drive PTY input as "human". Enforce Origin ∈
      // HUB_ALLOWED_ORIGINS at the handshake. HARDENED for CSWSH: a /ws/client
      // handshake with a DISALLOWED **or MISSING** Origin is rejected — browsers
      // always send Origin on a WS handshake, so an absent one is not a
      // legitimate browser client and must not be treated as a human actor.
      if (url.pathname === '/ws/client') {
        const origin = req.headers.get('origin')
        if (!isAllowedClientWsOrigin(origin, config.allowedOrigins)) {
          return new Response('forbidden', { status: 403 })
        }
      }

      // Connection limit per IP (DoS protection)
      // Prefer trusted proxy headers, fall back to x-forwarded-for
      const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
      const currentCount = wsConnectionsPerIp.get(ip) || 0
      if (currentCount >= MAX_WS_CONNECTIONS_PER_IP) {
        return new Response('too many connections', { status: 429 })
      }
      wsConnectionsPerIp.set(ip, currentCount + 1)

      let wsData: any
      if (url.pathname === '/ws/agent') {
        wsData = { type: 'agent' as const, ip, ...createAgentWsData() }
      } else {
        // Phase 07-C: extract __Host-remo_sid + csrf_token cookies at the
        // upgrade so /ws/client can authenticate from cookie alone (preferred
        // path) and enforce CSRF on mutating WS messages.
        const cookieHeader = req.headers.get('cookie')
        const cookieToken = parseSessionCookieFromHeader(cookieHeader)
        let csrfCookie: string | null = null
        if (cookieHeader) {
          for (const part of cookieHeader.split(/;\s*/)) {
            const eq = part.indexOf('=')
            if (eq < 0) continue
            if (part.slice(0, eq) === 'csrf_token') {
              csrfCookie = decodeURIComponent(part.slice(eq + 1))
              break
            }
          }
        }
        wsData = { type: 'client' as const, ip, cookieToken, csrfCookie, ...createClientWsData() }
      }

      const upgraded = server.upgrade(req, { data: wsData })
      if (!upgraded) {
        decrementIp(ip)
        return new Response('upgrade failed', { status: 400 })
      }
      return undefined
    }

    // Try Hono (API routes, health)
    const honoResponse = await app.fetch(req)
    if (honoResponse.status !== 404) return honoResponse

    // Serve static files from web/dist — with path traversal protection (M4 fix)
    const requestedPath = decodeURIComponent(url.pathname)
    const filePath = resolve(webDist, requestedPath === '/' ? 'index.html' : requestedPath.slice(1))
    if (!filePath.startsWith(webDist)) {
      return new Response('forbidden', { status: 403 })
    }

    // Cache policy: hashed /assets/* are content-addressed → cache forever;
    // index.html and other HTML must revalidate so deploys land immediately
    // instead of leaving browsers pinned to old bundle hashes.
    const isHtml = filePath.endsWith('.html') || requestedPath === '/'
    const isHashedAsset = requestedPath.startsWith('/assets/')
    const cacheHeaders: HeadersInit = isHtml
      ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      : isHashedAsset
        ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
        : {}

    const file = Bun.file(filePath)
    if (await file.exists()) return new Response(file, { headers: cacheHeaders })

    // SPA fallback — always index.html → no-cache
    const indexFile = Bun.file(join(webDist, 'index.html'))
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } })
    }

    return new Response('not found', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 10 * 1024 * 1024, // 10 MB (supports image attachments)
    open(ws) {
      if (ws.data.type === 'agent') handleAgentOpen(ws as any)
      else if (ws.data.type === 'client') handleClientOpen(ws as any)
    },
    async message(ws, raw) {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)

      if (ws.data.type === 'agent') await handleAgentMessage(ws as any, text)
      else if (ws.data.type === 'client') await handleClientMessage(ws as any, text)
    },
    close(ws) {
      const ip = (ws.data as any).ip
      if (ip) decrementIp(ip)

      if (ws.data.type === 'agent') handleAgentClose(ws as any)
      else if (ws.data.type === 'client') handleClientClose(ws as any)
    },
  },
})

// On startup: apply migrations, then mark all sessions as offline,
// boot the W2 scheduler (registry + catchup) alongside the legacy v0.
runMigrations()
  .then(() => setOfflineStaleAgentSessions())
  .then(() => markStreamingMessagesAsInterrupted())
  .then(() => markOrphanedRunsInterrupted())
  .then(async () => {
    // V2 scheduler: load enabled tasks, run catch-up. Waiter promotion lives in
    // the shared dispatch pipeline (onSessionReply → queue.markFinished →
    // re-dispatch); there is no dispatcher init step to wire anymore.
    await schedRegistry.loadAll()
    await schedCatchup.runOnce()
    // Round-2 migration: error-capture grace now lives in the shared dispatch
    // GraceBuffer, whose 60s sweep self-starts on first access. Warm it here so
    // the sweep is alive even before the first offline-parked dispatch.
    getDispatchGraceBuffer()
    startRevanoteCallbackWorker()
    // Phase 12 W3 — outbound Telegram bridge. No-op when TELEGRAM_BOT_TOKEN
    // is unset; otherwise subscribes to assistant_message:final events.
    startTelegramBridge()
    // Phase 22 — auto-dev-orchestrator global routine-cycle queue drain worker.
    // Dormant until Phase 23 registers a cycle-runner via setCycleRunner(); it
    // claims nothing without one, so starting it here is safe.
    startRoutineQueueWorker()
    // Phase 32 — auto-dev-orchestrator live path. Registers the cycle-runner and
    // starts the due-scan enqueue tick ONLY when REMO_ORCHESTRATOR_ENABLED is ON.
    // With the flag OFF (default) this is a no-op: no runner is registered (queue
    // stays dormant) and the due-scan tick never starts (nothing is enqueued).
    registerCycleRunnerIfEnabled()
    console.log('[startup] reset sessions/messages/runs; scheduler ready')
  })
  .catch((err) => {
    console.error('[startup] migration/init error:', err.message)
  })

// Graceful shutdown — pause cron jobs and clear pending post-run timers.
function gracefulShutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, pausing schedulers`)
  try { schedRegistry.pauseAll() } catch {}
  try { clearPostRunTimers() } catch {}
  try { stopRoutineQueueWorker() } catch {}
  try { stopDueOrchestratorTick() } catch {}
  setTimeout(() => process.exit(0), 250)
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

console.log(`Hub server running on http://localhost:${server.port}`)
console.log(`Serving web UI from: ${webDist}`)
} // end boot()
