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
import { supervisors as supervisorsApi } from './api/supervisors'
import { github as githubApi } from './api/github'
import { runMigrations } from './db/migrate'
import { apiKeyMiddleware } from './auth/api-key-middleware'
import { rateLimit } from './middleware/rate-limit'
import {
  createChannelWsData, handleChannelOpen, handleChannelMessage, handleChannelClose,
} from './ws/channel'
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

// Security headers (C2 fix: CSP + HSTS)
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  c.header('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' wss:",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; '))
})

// CORS
app.use('/api/*', cors({
  origin: config.allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// Health check
app.get('/health', (c) => c.json({ ok: true }))

// Auth routes (no auth required)
app.route('/api/auth', authRouter)

// Setup routes (no auth required — guarded internally by user count check)
app.route('/api/setup', setup)

// Plugin routes (API key auth — MUST be before JWT catch-all)
app.use('/api/plugin/*', rateLimit({ windowMs: 60_000, max: 30, keyFn: (c) => c.req.header('authorization')?.slice(0, 20) || 'anon' }))
app.use('/api/plugin/*', apiKeyMiddleware)
app.route('/api/plugin', plugin)

// Protected API routes (JWT auth, then rate limit keyed on userId)
app.use('/api/*', authMiddleware)
app.use('/api/*', rateLimit({ windowMs: 60_000, max: 120, keyFn: (c) => c.get('userId') || 'anon' }))
app.route('/api/sessions', sessions)
app.route('/api/api-keys', apiKeys)
app.route('/api/messages', messages)
app.route('/api/profile', profile)
app.route('/api/supervisors', supervisorsApi)
app.route('/api/github', githubApi)

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

// Start Bun server with WebSocket upgrade handling
const server = Bun.serve({
  port: config.port,
  async fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades — with origin validation (C2 fix) and connection limits
    if (url.pathname === '/ws/channel' || url.pathname === '/ws/client' || url.pathname === '/ws/agent') {
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
      } else if (url.pathname === '/ws/channel') {
        wsData = { type: 'channel' as const, ip, ...createChannelWsData() }
      } else {
        wsData = { type: 'client' as const, ip, ...createClientWsData() }
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

    const file = Bun.file(filePath)
    if (await file.exists()) return new Response(file)

    // SPA fallback
    const indexFile = Bun.file(join(webDist, 'index.html'))
    if (await indexFile.exists()) return new Response(indexFile)

    return new Response('not found', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 10 * 1024 * 1024, // 10 MB (supports image attachments)
    open(ws) {
      if (ws.data.type === 'agent') handleAgentOpen(ws as any)
      else if (ws.data.type === 'channel') handleChannelOpen(ws as any)
      else if (ws.data.type === 'client') handleClientOpen(ws as any)
    },
    async message(ws, raw) {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)

      if (ws.data.type === 'agent') await handleAgentMessage(ws as any, text)
      else if (ws.data.type === 'channel') await handleChannelMessage(ws as any, text)
      else if (ws.data.type === 'client') await handleClientMessage(ws as any, text)
    },
    close(ws) {
      const ip = (ws.data as any).ip
      if (ip) decrementIp(ip)

      if (ws.data.type === 'agent') handleAgentClose(ws as any)
      else if (ws.data.type === 'channel') handleChannelClose(ws as any)
      else if (ws.data.type === 'client') handleClientClose(ws as any)
    },
  },
})

// On startup: apply migrations, then mark all sessions as offline
import { setOfflineStaleAgentSessions } from './db/dal.ts'
runMigrations()
  .then(() => setOfflineStaleAgentSessions())
  .then(() => {
    console.log('[startup] reset all session statuses to offline')
  })
  .catch((err) => {
    console.error('[startup] migration/init error:', err.message)
  })

console.log(`Hub server running on http://localhost:${server.port}`)
console.log(`Serving web UI from: ${webDist}`)
