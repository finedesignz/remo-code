/**
 * Phase 12 Wave 4 — `/doctor` command + auto-heal on dispatch failure.
 *
 * Walks 6 checks in order, replying after EACH so the user sees progress
 * in real time. Every reply is best-effort (try/catch) — a failed send
 * never aborts the rest of the flow.
 *
 *   1. account link present (telegram_chat_id)
 *   2. default session bound (telegram_default_session_id)
 *   3. session row still exists (not deleted)
 *   4. supervisor connected (last_seen_at < 60s ago) AND in the live registry
 *   5. session already has a live channel (`getChannel(sessionId)`)
 *   6. AUTO-FIX: emit `session.start` via `launchSessionForUser` and schedule
 *      a 20s deferred check that replies once with success/timeout.
 *
 * The webhook handler dispatches this on `/doctor` AND optionally on a
 * silent `agent_offline` outcome (auto-heal opt-out via the
 * `users.telegram_auto_doctor` flag — defaults ON).
 */
import { sql } from '../db/postgres.ts'
import { sendMessage } from './client.ts'
import { getChannel } from '../ws/registry.ts'
import {
  listSupervisorsForUser,
} from '../db/supervisor-dal.ts'
import { isSupervisorOnline } from '../ws/supervisor-registry.ts'
import { launchSessionForUser } from './launch.ts'
import type { TelegramUserRow } from '../db/dal.ts'

const SUPERVISOR_STALE_MS = 60 * 1000
const LAUNCH_POLL_MS = 20 * 1000

async function safeSay(chatId: number | bigint | string, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text)
  } catch (err: any) {
    console.warn('[telegram-doctor] sendMessage failed:', err?.status ?? '?', err?.message)
  }
}

function repoBasename(p: string | null | undefined): string {
  if (!p) return '(no path)'
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

interface SessionRow {
  id: string
  name: string | null
  project_dir: string | null
  hostname: string | null
  deleted_at: string | null
}

async function fetchSession(userId: string, sessionId: string): Promise<SessionRow | null> {
  const rows = await sql<SessionRow[]>`
    SELECT id, name, project_dir, hostname, deleted_at
      FROM sessions
     WHERE id = ${sessionId} AND user_id = ${userId}
     LIMIT 1
  `
  return rows[0] ?? null
}

interface DoctorOpts {
  user: TelegramUserRow
  chatId: number | bigint | string
  /** Injectable for tests. Defaults to `getChannel` from `ws/registry`. */
  getChannelImpl?: typeof getChannel
  /** Injectable for tests. Defaults to `setTimeout`. */
  scheduleDelayed?: (cb: () => void, ms: number) => void
  /** Injectable for tests — overrides the 20s poll window. */
  pollWindowMs?: number
}

export type DoctorOutcome =
  | 'cmd_doctor_ok'
  | 'cmd_doctor_no_chat'
  | 'cmd_doctor_no_session'
  | 'cmd_doctor_session_gone'
  | 'cmd_doctor_supervisor_offline'
  | 'cmd_doctor_supervisor_ambiguous'
  | 'cmd_doctor_at_capacity'
  | 'cmd_doctor_launched'
  | 'cmd_doctor_launch_failed'
  | 'cmd_doctor_internal_error'

export async function runDoctor(opts: DoctorOpts): Promise<{ outcome: DoctorOutcome }> {
  const { user, chatId } = opts
  const getCh = opts.getChannelImpl ?? getChannel
  const schedule = opts.scheduleDelayed ?? ((cb, ms) => { setTimeout(cb, ms) })
  const pollWindow = opts.pollWindowMs ?? LAUNCH_POLL_MS

  await safeSay(chatId, '🩺 Running diagnostics…')

  // Check 1 — account link
  if (!user.telegram_chat_id) {
    await safeSay(chatId, '❌ Check 1/6: Telegram not linked. Generate a code from Settings → Telegram.')
    return { outcome: 'cmd_doctor_no_chat' }
  }
  await safeSay(chatId, '✅ Check 1/6: Account linked.')

  // Check 2 — default session bound
  const sessionId = user.telegram_default_session_id
  if (!sessionId) {
    await safeSay(chatId, '❌ Check 2/6: No default session bound. Use /list to pick one.')
    return { outcome: 'cmd_doctor_no_session' }
  }
  await safeSay(chatId, `✅ Check 2/6: Default session ${sessionId.slice(0, 8)} bound.`)

  // Check 3 — session row exists
  let session: SessionRow | null
  try {
    session = await fetchSession(user.id, sessionId)
  } catch (err: any) {
    await safeSay(chatId, `❌ Check 3/6: DB error fetching session: ${err?.message}`)
    return { outcome: 'cmd_doctor_internal_error' }
  }
  if (!session || session.deleted_at) {
    await safeSay(chatId, '❌ Check 3/6: Session was deleted. Use /list to pick a new one.')
    return { outcome: 'cmd_doctor_session_gone' }
  }
  const repoLabel = session.name || repoBasename(session.project_dir)
  await safeSay(chatId, `✅ Check 3/6: Session row exists (${repoLabel}).`)

  // Check 4 — supervisor connected
  let onlineHostnames: string[] = []
  let supervisorMatchOnline = false
  try {
    const sups = (await listSupervisorsForUser(user.id)) as Array<{
      id: string
      hostname: string
      last_seen_at: string | Date
    }>
    const now = Date.now()
    for (const s of sups) {
      const seen = new Date(s.last_seen_at as any).getTime()
      const stale = isNaN(seen) || now - seen > SUPERVISOR_STALE_MS
      const live = isSupervisorOnline(s.id) && !stale
      if (live) {
        onlineHostnames.push(s.hostname)
        if (session.hostname && s.hostname === session.hostname) supervisorMatchOnline = true
        if (!session.hostname) supervisorMatchOnline = true
      }
    }
  } catch (err: any) {
    await safeSay(chatId, `❌ Check 4/6: DB error checking supervisors: ${err?.message}`)
    return { outcome: 'cmd_doctor_internal_error' }
  }

  if (!supervisorMatchOnline) {
    const target = session.hostname ? `'${session.hostname}'` : 'your dev machine'
    const onlineNote = onlineHostnames.length
      ? ` (online: ${onlineHostnames.join(', ')})`
      : ''
    await safeSay(
      chatId,
      `❌ Check 4/6: Supervisor for ${target} isn't connected${onlineNote}. Start the Remo Code Supervisor app and try again.`,
    )
    return { outcome: 'cmd_doctor_supervisor_offline' }
  }
  await safeSay(chatId, `✅ Check 4/6: Supervisor online (${session.hostname || onlineHostnames[0]}).`)

  // Check 5 — session has live channel
  const channel = getCh(sessionId)
  if (channel) {
    await safeSay(chatId, '✅ Check 5/6: Session has a live runner.\n\n🎉 Everything looks good — try sending your message again.')
    return { outcome: 'cmd_doctor_ok' }
  }
  await safeSay(chatId, '⚠ Check 5/6: Session has no live runner — auto-fixing…')

  // Check 6 — auto-fix: launch
  const launch = await launchSessionForUser({ userId: user.id, sessionId })
  if (!launch.ok) {
    switch (launch.reason) {
      case 'at_capacity':
        await safeSay(
          chatId,
          `❌ Check 6/6: Supervisor at concurrency cap (${launch.running}/${launch.cap}). Stop a session in the web UI first.`,
        )
        return { outcome: 'cmd_doctor_at_capacity' }
      case 'supervisor_ambiguous':
        await safeSay(
          chatId,
          `❌ Check 6/6: ${launch.count} supervisors online — can't pick one automatically. Click Launch in the web UI.`,
        )
        return { outcome: 'cmd_doctor_supervisor_ambiguous' }
      case 'no_online_supervisor':
        await safeSay(chatId, '❌ Check 6/6: No online supervisor matches this session. Start the Supervisor app.')
        return { outcome: 'cmd_doctor_supervisor_offline' }
      case 'session_not_found':
        await safeSay(chatId, '❌ Check 6/6: Session vanished mid-fix. Use /list to pick a new one.')
        return { outcome: 'cmd_doctor_session_gone' }
      case 'no_project_dir':
        await safeSay(chatId, '❌ Check 6/6: Session has no project directory — can\'t launch.')
        return { outcome: 'cmd_doctor_launch_failed' }
      case 'send_failed':
        await safeSay(chatId, `❌ Check 6/6: Could not reach supervisor: ${launch.error}`)
        return { outcome: 'cmd_doctor_launch_failed' }
      case 'internal_error':
      default:
        await safeSay(chatId, `❌ Check 6/6: Launch failed: ${(launch as any).error ?? 'unknown'}`)
        return { outcome: 'cmd_doctor_internal_error' }
    }
  }

  await safeSay(
    chatId,
    `🟡 Check 6/6: Launching '${repoLabel}' on '${launch.hostname}'… give it ~10 seconds, then resend your message.`,
  )

  // Deferred poll — does NOT block the webhook return.
  schedule(() => {
    let live = false
    try {
      live = !!getCh(sessionId)
    } catch {}
    if (live) {
      void safeSay(chatId, "✅ Launch complete — session online. Resend your message and I'll forward it.")
    } else {
      void safeSay(
        chatId,
        '⚠ Launch is taking longer than expected. Check the web UI for errors, or try /doctor again.',
      )
    }
  }, pollWindow)

  return { outcome: 'cmd_doctor_launched' }
}
