import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { authMiddleware } from './auth/middleware'
import { sessions } from './api/sessions'
import { messages } from './api/messages'
import {
  createChannelWsData, handleChannelOpen, handleChannelMessage, handleChannelClose,
} from './ws/channel'
import {
  createClientWsData, handleClientOpen, handleClientMessage, handleClientClose,
} from './ws/client'

const app = new Hono()

// Security headers
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
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

// Protected API routes
app.use('/api/*', authMiddleware)
app.route('/api/sessions', sessions)
app.route('/api/messages', messages)

// Serve static web UI (built files from ../web/dist)
app.use('/*', serveStatic({ root: '../web/dist' }))
app.use('/*', serveStatic({ root: '../web/dist', path: 'index.html' })) // SPA fallback

// Start Bun server with WebSocket upgrade handling
const server = Bun.serve({
  port: config.port,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrades
    if (url.pathname === '/ws/channel') {
      const upgraded = server.upgrade(req, {
        data: { type: 'channel' as const, ...createChannelWsData() },
      })
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
    }

    if (url.pathname === '/ws/client') {
      const upgraded = server.upgrade(req, {
        data: { type: 'client' as const, ...createClientWsData() },
      })
      return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
    }

    // Hono handles REST
    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      if (ws.data.type === 'channel') handleChannelOpen(ws as any)
      if (ws.data.type === 'client') handleClientOpen(ws as any)
    },
    async message(ws, raw) {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      if (text.length > 65536) return // max message size

      if (ws.data.type === 'channel') await handleChannelMessage(ws as any, text)
      if (ws.data.type === 'client') await handleClientMessage(ws as any, text)
    },
    close(ws) {
      if (ws.data.type === 'channel') handleChannelClose(ws as any)
      if (ws.data.type === 'client') handleClientClose(ws as any)
    },
  },
})

console.log(`Hub server running on http://localhost:${server.port}`)
