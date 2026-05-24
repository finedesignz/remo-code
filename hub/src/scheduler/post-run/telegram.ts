/**
 * Telegram post-run action (W2/T8.6).
 *
 * Soft-load the user's telegram chat from a `user_integrations` table if it
 * exists; missing config → silent skip with log. Best-effort, log-only.
 *
 * TODO(wave3+): wire into the unified gateway lookup per global CLAUDE.md
 * MCP gateway pattern once available.
 */
import type { PostRunAction } from './schema.ts'
import { render } from './template.ts'
import { sql } from '../../db/postgres.ts'

interface TelegramCtx { userId: string; templateVars: Record<string, unknown> }

async function lookupTelegramChat(userId: string): Promise<{ bot_token: string; chat_id: string } | null> {
  try {
    const rows = await sql<{ config: any }[]>`
      SELECT config FROM user_integrations
      WHERE user_id = ${userId} AND provider = 'telegram' AND revoked_at IS NULL
      LIMIT 1
    `
    if (!rows[0]) return null
    const cfg = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
    if (!cfg?.bot_token || !cfg?.chat_id) return null
    return { bot_token: String(cfg.bot_token), chat_id: String(cfg.chat_id) }
  } catch {
    return null
  }
}

export async function executeTelegram(action: PostRunAction, ctx: TelegramCtx): Promise<void> {
  if (action.type !== 'notify_telegram') return
  const cfg = await lookupTelegramChat(ctx.userId)
  if (!cfg) {
    console.warn(`[post-run.telegram] user=${ctx.userId} has no telegram integration; skipping`)
    return
  }
  const text = render(action.config.body, ctx.templateVars)
  try {
    const url = `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chat_id, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[post-run.telegram] send failed ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (err: any) {
    console.error('[post-run.telegram] threw', err?.message)
  }
}
