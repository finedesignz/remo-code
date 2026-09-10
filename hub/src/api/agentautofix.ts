/**
 * AgentAutofix — plugin identity token route (directive A, click-to-comment
 * widget). Mounted at `/api/agentautofix`, AFTER `authMiddleware` (see
 * hub/src/index.ts) so `c.get('userId')` is always a real logged-in user.
 *
 * Returns a 600s-TTL identity JWT the widget attaches as
 * `Authorization: Bearer <token>` on every AgentAutofix ingest call, plus the
 * public (browser-safe) host/key the widget needs to build its config-check
 * and comment-submit requests. `signing_secret` never leaves this process.
 *
 * 404s (not 401/500) when AgentAutofix isn't configured — every hub
 * environment without the five AGENTAUTOFIX_* vars set (local dev, any
 * future deploy target) must be able to boot and run with the feature
 * silently absent.
 */
import { Hono } from 'hono'
import { config } from '../config.ts'
import { mintAgentautofixIdentityToken } from '../agentautofix/identity.ts'

export const agentautofix = new Hono()

agentautofix.get('/token', (c) => {
  if (!config.agentautofix.configured) {
    return c.json({ error: 'not_configured' }, 404)
  }
  const userId = c.get('userId') as string
  const userEmail = c.get('userEmail') as string | undefined
  const userRole = c.get('userRole') as string | undefined

  const token = mintAgentautofixIdentityToken({ sub: userId, email: userEmail, role: userRole })

  return c.json(
    {
      token,
      host: config.agentautofix.host,
      public_key: config.agentautofix.publicKey,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
})
