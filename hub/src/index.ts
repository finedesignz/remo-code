import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
import { existsSync } from 'fs'
import { join, resolve } from 'path'

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

// Resolve web dist directory (works both in Docker and locally)
const webDistCandidates = ['./web/dist', '../web/dist', resolve(__dirname, '../../web/dist')]
const webDist = webDistCandidates.find(p => existsSync(p)) || './web/dist'

// Start Bun server with WebSocket upgrade handling
const server = Bun.serve({
  port: config.port,
  async fetch(req, server) {
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

    // Try Hono (API routes, health)
    const honoResponse = await app.fetch(req)
    if (honoResponse.status !== 404) return honoResponse

    // Serve static files from web/dist
    const filePath = join(webDist, url.pathname === '/' ? 'index.html' : url.pathname)
    const file = Bun.file(filePath)
    if (await file.exists()) return new Response(file)

    // SPA fallback — serve index.html for client-side routing
    const indexFile = Bun.file(join(webDist, 'index.html'))
    if (await indexFile.exists()) return new Response(indexFile)

    return new Response('not found', { status: 404 })
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
console.log(`Serving web UI from: ${resolve(webDist)}`)
