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
import { instructions as instructionsApi } from './api/instructions'
import { errorSetup as errorSetupApi } from './api/error-setup'
import { coolifyWebhookRoutes } from './api/coolify-webhook'
import { revanoteWebhookRoutes } from './api/revanote-webhook'
import { telegramWebhookRoutes } from './api/telegram-webhook'
import { revanoteMappings } from './api/revanote-mappings'
import { revanoteAnnotations } from './api/revanote-annotations'
import { webhooksTitanium } from './api/webhooks-titanium'
import { orchestrator as orchestratorApi } from './api/orchestrator'
import { requireActiveLicense } from './license-gate'
import { openapi as openapiApp } from './api/_openapi'
import { runMigrations } from './db/migrate'
import { markOrphanedRunsInterrupted } from './db/scheduled-tasks-dal.ts'
// V2 scheduler.
import * as schedRegistry from './scheduler/registry.ts'
import * as schedDispatcher from './scheduler/dispatcher.ts'
import * as schedCatchup from './scheduler/catchup.ts'
import { clearPendingTimers as clearPostRunTimers } from './scheduler/post-run/dispatcher.ts'
import { startErrorGraceSweep } from './error-capture/grace.ts'
import { startRevanoteGraceSweep } from './revanote/grace.ts'
import { startRevanoteCallbackWorker } from './revanote/callback.ts'
import { startTelegramBridge } from './telegram/bridge.ts'
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
import {
  createAgentWsData, handleAgentOpen, handleAgentMessage, handleAgentClose,
} from './ws/agent'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

const app = new Hono()

// Global error handler — never leak internals
app.onError((err, c) => {
  console.error('[error]', err.message)
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

// Health check
app.get('/health', (c) => c.json({ ok: true }))

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

// Plugin routes (API key auth — MUST be before JWT catch-all)
app.use('/api/plugin/*', rateLimit({ windowMs: 60_000, max: 30, keyFn: (c) => c.req.header('authorization')?.slice(0, 20) || 'anon' }))
app.use('/api/plugin/*', apiKeyMiddleware)
app.route('/api/plugin', plugin)

// Sentry-style error intake — public, sentry_key in X-Sentry-Auth IS the credential.
// MUST be mounted before the JWT catch-all, and the catch-all MUST skip this path.
app.use('/api/sentry/*', rateLimit({ windowMs: 60_000, max: 600, keyFn: (c) => c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'anon' }))
app.route('/api/sentry', sentryIntakeApi)

// Public Coolify deployment webhook (HMAC-signed, per-user secret in URL).
// MUST be mounted BEFORE the JWT catch-all middleware below.
app.route('/api/coolify', coolifyWebhookRoutes)

// Phase 08: Public Revanote annotation webhook (URL-token + HMAC, per-user
// secret embedded in path). MUST be mounted BEFORE the JWT catch-all.
app.route('/api/revanote', revanoteWebhookRoutes)

// Phase 12: Public Telegram inbound webhook (URL-path secret). MUST be
// mounted BEFORE the JWT catch-all. Auth is :secret in the URL, constant-time
// compared to config.telegram.webhookSecret.
app.route('/api/telegram', telegramWebhookRoutes)

// Public Titanium license-changed webhook (HMAC-signed, shared secret).
// MUST be mounted BEFORE the JWT catch-all. Inert (503) until secret set.
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
app.route('/api/error-projects', errorProjectsRouter)
app.route('/api/errors', errorsRouter)
app.route('/api/error-runs', errorRunsRouter)
app.route('/api/chat-tabs', chatTabsApi)
app.route('/api/instructions', instructionsApi)
app.route('/api/error-setup', errorSetupApi)
// Phase 08: JWT-authed revanote sub-routes (mappings + annotations).
// The public webhook route lives at /api/revanote/webhook/* (mounted above).
app.route('/api/orchestrator', orchestratorApi)
app.route('/api/revanote/mappings', revanoteMappings)
app.route('/api/revanote/annotations', revanoteAnnotations)

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

// Start Bun server with WebSocket upgrade handling.
//
// idleTimeout: Bun's default is 10s, which kills any HTTP request whose
// upstream WS round-trip takes longer (notably POST /api/supervisors/:id/scan,
// which fans out to the supervisor over WS with a 20s sendRequest budget, plus
// /clone at 300s). Hitting Bun's 10s before the WS reply arrives terminates
// the HTTP connection mid-flight, which Coolify's Traefik in turn surfaces as
// 502 Bad Gateway. Bump to 305s (5s above the longest sendRequest budget) so
// HTTP keep-alives never expire before the WS response can be serialized.
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades — with origin validation (C2 fix) and connection limits
    if (url.pathname === '/ws/client' || url.pathname === '/ws/agent') {
      // Origin check for browser clients
      if (url.pathname === '/ws/client') {
        const origin = req.headers.get('origin')
        if (origin && !config.allowedOrigins.includes(origin)) {
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
import { setOfflineStaleAgentSessions, markStreamingMessagesAsInterrupted } from './db/dal.ts'
runMigrations()
  .then(() => setOfflineStaleAgentSessions())
  .then(() => markStreamingMessagesAsInterrupted())
  .then(() => markOrphanedRunsInterrupted())
  .then(async () => {
    // V2 scheduler: wire dispatcher → queue, load enabled tasks, run catch-up.
    schedDispatcher.init()
    await schedRegistry.loadAll()
    await schedCatchup.runOnce()
    startErrorGraceSweep()
    startRevanoteGraceSweep()
    startRevanoteCallbackWorker()
    // Phase 12 W3 — outbound Telegram bridge. No-op when TELEGRAM_BOT_TOKEN
    // is unset; otherwise subscribes to assistant_message:final events.
    startTelegramBridge()
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
  setTimeout(() => process.exit(0), 250)
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

console.log(`Hub server running on http://localhost:${server.port}`)
console.log(`Serving web UI from: ${webDist}`)
