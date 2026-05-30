/**
 * Phase 12 UX pass — `/status` command.
 *
 * Single compact status report: link, default session, supervisor liveness,
 * session channel, today's cost. Reuses the same primitives `/doctor` and
 * `dispatchToSession` do — no new DB columns, no new cost-cap math.
 *
 * Every row is user-scoped via `user.id` — never accepts another user's
 * data, never echoes a chat_id that wasn't on the request.
 */
import { sql } from '../db/postgres.ts'
import { sendMessage } from './client.ts'
import { getChannel } from '../ws/registry.ts'
import { listSupervisorsForUser } from '../db/supervisor-dal.ts'
import { isSupervisorOnline } from '../ws/supervisor-registry.ts'
import { getTodayTokenCostUsd } from '../db/token-usage-dal.ts'
import type { TelegramUserRow } from '../db/dal.ts'

const SUPERVISOR_STALE_MS = 60 * 1000

async function safeSay(chatId: number | bigint | string, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text)
  } catch (err: any) {
    console.warn('[telegram-status] sendMessage failed:', err?.status ?? '?', err?.message)
  }
}

function repoBasename(p: string | null | undefined): string {
  if (!p) return '(no path)'
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function relAgo(d: Date | string | null): string {
  if (!d) return 'never'
  const t = new Date(d as any).getTime()
  if (isNaN(t)) return 'never'
  const ms = Date.now() - t
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export interface StatusOpts {
  user: TelegramUserRow
  chatId: number | bigint | string
  /** Injectable for tests. Defaults to `getChannel`. */
  getChannelImpl?: typeof getChannel
}

export type StatusOutcome =
  | 'cmd_status_ok'
  | 'cmd_status_internal_error'

export async function runStatus(opts: StatusOpts): Promise<{ outcome: StatusOutcome }> {
  const { user, chatId } = opts
  const getCh = opts.getChannelImpl ?? getChannel

  try {
    const lines: string[] = ['🤖 Remo Code — quick status', '']

    // Linked-as row
    lines.push(`🔗 Linked as ${user.email}`)

    // Default session
    let sessionLabel = ''
    let sessionShortId = ''
    let sessionHostname: string | null = null
    let sessionRowExists = false
    if (user.telegram_default_session_id) {
      const rows = await sql<{ name: string | null; project_dir: string | null; hostname: string | null }[]>`
        SELECT name, project_dir, hostname
          FROM sessions
         WHERE id = ${user.telegram_default_session_id} AND user_id = ${user.id} AND deleted_at IS NULL
         LIMIT 1
      `
      if (rows[0]) {
        sessionRowExists = true
        sessionLabel = rows[0].name || repoBasename(rows[0].project_dir)
        sessionShortId = user.telegram_default_session_id.slice(0, 8)
        sessionHostname = rows[0].hostname
        lines.push(`🎯 Default: ${sessionLabel} (${sessionShortId})`)
      } else {
        lines.push('⚠ Default: session was deleted — use /list to pick a new one')
      }
    } else {
      lines.push('⚠ Default: not set — use /list')
    }

    // Supervisor liveness
    const sups = (await listSupervisorsForUser(user.id)) as Array<{
      id: string
      hostname: string
      last_seen_at: string | Date
    }>
    if (sups.length === 0) {
      lines.push('⚠ Supervisor: none registered — install the Supervisor app')
    } else {
      // Prefer the supervisor matching the session's hostname; fall back to most-recent.
      const match = sessionHostname
        ? sups.find((s) => s.hostname === sessionHostname)
        : undefined
      const pick = match ?? sups[0]!
      const seen = new Date(pick.last_seen_at as any).getTime()
      const stale = isNaN(seen) || Date.now() - seen > SUPERVISOR_STALE_MS
      const live = isSupervisorOnline(pick.id) && !stale
      const dot = live ? '🟢' : '⚠'
      const tail = live ? `(last seen ${relAgo(pick.last_seen_at)})` : `offline (last seen ${relAgo(pick.last_seen_at)})`
      lines.push(`${dot} Supervisor: ${pick.hostname} ${tail}`)
    }

    // Session channel
    if (sessionRowExists && user.telegram_default_session_id) {
      const channel = getCh(user.telegram_default_session_id)
      if (channel) {
        lines.push('🟢 Session: online (channel live)')
      } else {
        lines.push('⚪ Session: offline (run `/doctor` to launch)')
      }
    }

    // Cost
    try {
      const rows = await sql<{ cap: string; tz: string }[]>`
        SELECT daily_cost_cap_usd::text AS cap, COALESCE(timezone, 'UTC') AS tz
          FROM users
         WHERE id = ${user.id}
         LIMIT 1
      `
      const cap = Number(rows[0]?.cap ?? 10)
      const tz = rows[0]?.tz || 'UTC'
      const spent = await getTodayTokenCostUsd(user.id, tz)
      const capStr = Number.isFinite(cap) ? cap.toFixed(2) : '∞'
      const spentStr = spent.toFixed(2)
      lines.push(`💰 Today: $${spentStr} / $${capStr}`)
    } catch (err: any) {
      lines.push('💰 Today: (cost lookup failed)')
    }

    lines.push('', '/list • /doctor • /help')

    await safeSay(chatId, lines.join('\n'))
    return { outcome: 'cmd_status_ok' }
  } catch (err: any) {
    console.warn('[telegram-status] internal error:', err?.message)
    await safeSay(chatId, `❌ /status failed: ${err?.message ?? 'unknown'}`)
    return { outcome: 'cmd_status_internal_error' }
  }
}
