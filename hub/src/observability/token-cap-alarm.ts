/**
 * PTYCAP-04-05 (D-13, SC-3): the daily-token-ceiling ALARM.
 *
 * Emails the owner when today's tokens first cross REMO_TOKEN_CAP_ALARM_PCT (default 60)
 * of the ceiling. Distinct from observability/cap-alert.ts (the 80 percent orchestrator
 * alert), which is unchanged.
 *
 * Event-driven, never polled: recordTokenUsage (db/token-usage-dal.ts) calls the listener
 * registered here after the ledger commit; evaluation is coalesced per user on a trailing
 * edge (quiet window, bounded by a maximum wait) BEFORE any async lookup, so a usage-event
 * flood cannot amplify into DB reads or mail (T-04-24).
 *
 * Durable claim: one token_cap_alarms row per (user, local day), won by an atomic INSERT ...
 * ON CONFLICT DO NOTHING. `delivered` flips true ONLY when sendEmail returned true; an
 * undelivered claim is retried (atomic UPDATE) after a cooldown, bounded by an attempt
 * maximum, so a failed send never burns the day's slot (T-04-25).
 */
import { sql } from '../db/postgres.ts'
import { setTokenUsageListener } from '../db/token-usage-dal.ts'
import { alarmPct } from '../dispatch/automation-controls.ts'

/** Re-exported so callers/tests have one name for the effective threshold percent. */
export const tokenCapAlarmPct = alarmPct

export const ALARM_MAX_ATTEMPTS = 5
export const ALARM_RETRY_COOLDOWN_SECONDS = 300
export const ALARM_QUIET_MS = 5_000
export const ALARM_MAX_WAIT_MS = 30_000

// ── claim ────────────────────────────────────────────────────────────────────
export interface ClaimArgs {
  userId: string
  timezone: string
  pct: number
  tokens: number
  cap: number
  maxAttempts?: number
  cooldownSeconds?: number
}

/**
 * One atomic claim per (user, local day). local_date is the date of now() in the USER's
 * timezone. Returns the row id when this call won the first claim or a bounded retry of an
 * undelivered one; null when the day is already delivered / exhausted / cooling down.
 */
export async function claimTokenCapAlarm(args: ClaimArgs, q: any = sql): Promise<string | null> {
  const maxAttempts = args.maxAttempts ?? ALARM_MAX_ATTEMPTS
  const cooldown = args.cooldownSeconds ?? ALARM_RETRY_COOLDOWN_SECONDS
  const won = await q`
    INSERT INTO token_cap_alarms (user_id, local_date, pct, tokens, cap, attempts, last_attempt_at)
    VALUES (${args.userId}::text, (now() AT TIME ZONE ${args.timezone}::text)::date,
            ${Math.round(args.pct)}::int, ${Math.round(args.tokens)}::bigint, ${Math.round(args.cap)}::bigint, 1, now())
    ON CONFLICT (user_id, local_date) DO NOTHING
    RETURNING id
  `
  if (won.length > 0) return won[0].id as string
  const retried = await q`
    UPDATE token_cap_alarms
       SET attempts = attempts + 1, last_attempt_at = now(), tokens = ${Math.round(args.tokens)}::bigint
     WHERE user_id = ${args.userId}::text
       AND local_date = (now() AT TIME ZONE ${args.timezone}::text)::date
       AND delivered = false
       AND attempts < ${maxAttempts}::int
       AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => ${cooldown}::int))
    RETURNING id
  `
  return retried.length > 0 ? (retried[0].id as string) : null
}

async function markAlarmDelivered(id: string, q: any = sql): Promise<void> {
  await q`UPDATE token_cap_alarms SET delivered = true WHERE id = ${id}::text`
}

// ── evaluation ───────────────────────────────────────────────────────────────
export interface AlarmDeps {
  getUser: (id: string) => Promise<{ email?: string | null; timezone?: string | null } | null>
  getStatus: (userId: string, tz: string) => Promise<{ over: boolean; tokens: number; cap: number }>
  claim: (args: ClaimArgs) => Promise<string | null>
  markDelivered: (id: string) => Promise<void>
  sendEmail: (input: { to: string; subject: string; html: string; text: string }) => Promise<boolean>
  notify: (input: {
    userId: string
    sessionId: string
    event: 'info'
    level: 'info'
    detail: string
    channels: ('inapp' | 'telegram')[]
  }) => Promise<unknown>
  pct: () => number
}

async function defaultDeps(): Promise<AlarmDeps> {
  const dal = await import('../db/dal.ts')
  const gates = await import('../dispatch/gates.ts')
  const mail = await import('../lib/email.ts')
  const notify = await import('../orchestrator/notify.ts')
  return {
    getUser: dal.getUserById as any,
    getStatus: gates.getTokenCapStatus,
    claim: (a) => claimTokenCapAlarm(a),
    markDelivered: (id) => markAlarmDelivered(id),
    sendEmail: mail.sendEmail,
    notify: (i) => notify.fanOutNotify(i),
    pct: alarmPct,
  }
}

function localDate(tz: string): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz })
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

const ascii = (s: string): string => s.replace(/[^\x20-\x7e\n]/g, '?')
const withCommas = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export function buildAlarmMessage(args: { tokens: number; cap: number; pct: number; tz: string }): {
  subject: string
  text: string
  html: string
} {
  const pctNow = args.cap > 0 ? Math.round((args.tokens / args.cap) * 100) : 0
  const date = localDate(args.tz)
  const subject = `remo-code: daily token ceiling at ${pctNow} percent`
  const text =
    `Today's token usage (${date}, ${args.tz}) has reached ${pctNow} percent of the daily ceiling.\n` +
    `Tokens used: ${withCommas(args.tokens)}\n` +
    `Daily ceiling: ${withCommas(args.cap)}\n` +
    `Alarm threshold: ${args.pct} percent\n` +
    `Automated dispatches stop at 100 percent of the ceiling.`
  const html = `<p>${text.replace(/\n/g, '<br>')}</p>`
  return { subject: ascii(subject), text: ascii(text), html: ascii(html) }
}

export async function evaluateTokenCapAlarm(
  userId: string,
  sessionId: string,
  deps?: AlarmDeps,
): Promise<{ fired: boolean }> {
  const d = deps ?? (await defaultDeps())
  const user = await d.getUser(userId)
  if (!user) return { fired: false }
  const tz = user.timezone || 'UTC'
  const status = await d.getStatus(userId, tz)
  if (!status || status.cap <= 0) return { fired: false } // cap explicitly disabled: silent
  const pct = d.pct()
  if (status.tokens < (status.cap * pct) / 100) return { fired: false }

  const id = await d.claim({ userId, timezone: tz, pct, tokens: status.tokens, cap: status.cap })
  if (!id) return { fired: false }

  if (!user.email) {
    console.warn(`[token-cap-alarm] user ${userId} has no email; alarm attempt recorded, nothing sent`)
    return { fired: true }
  }
  const msg = buildAlarmMessage({ tokens: status.tokens, cap: status.cap, pct, tz })
  let sent = false
  try {
    sent = await d.sendEmail({ to: user.email, subject: msg.subject, html: msg.html, text: msg.text })
  } catch (err: any) {
    console.warn(`[token-cap-alarm] sendEmail threw: ${err?.message ?? err}`)
  }
  if (!sent) {
    console.warn(`[token-cap-alarm] email not delivered for user ${userId}; claim stays undelivered for a bounded retry`)
    return { fired: true }
  }
  await d.markDelivered(id)
  // Best-effort extra channels (never email/push): failure is irrelevant to the alarm.
  try {
    await d.notify({
      userId,
      sessionId,
      event: 'info',
      level: 'info',
      detail: msg.text.split('\n')[0]!,
      channels: ['inapp', 'telegram'],
    })
  } catch (err: any) {
    console.warn(`[token-cap-alarm] fan-out failed: ${err?.message ?? err}`)
  }
  return { fired: true }
}

// ── trailing-edge scheduler ──────────────────────────────────────────────────
export interface ScheduleOpts {
  quietMs?: number
  maxWaitMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  now?: () => number
  evaluate?: (userId: string, sessionId: string) => Promise<unknown>
}

interface Pending {
  timer: unknown
  firstAt: number
}
const pending = new Map<string, Pending>()

/** Number of users with a pending coalesced evaluation (test/diagnostic hook). */
export function pendingAlarmCount(): number {
  return pending.size
}

/**
 * Coalesce usage events per user: every call re-arms a quiet-window timer, bounded by a
 * maximum wait measured from the FIRST pending event; the timer then evaluates once. No
 * polling and no interval: a timer exists only while events are arriving.
 */
export function scheduleTokenCapAlarm(userId: string, sessionId: string, opts: ScheduleOpts = {}): void {
  const quiet = opts.quietMs ?? ALARM_QUIET_MS
  const maxWait = opts.maxWaitMs ?? ALARM_MAX_WAIT_MS
  const now = opts.now ?? Date.now
  const setT =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t: any = setTimeout(fn, ms)
      t?.unref?.()
      return t
    })
  const clearT = opts.clearTimer ?? ((t: unknown) => clearTimeout(t as any))
  const evaluate = opts.evaluate ?? ((u: string, s: string) => evaluateTokenCapAlarm(u, s))

  const existing = pending.get(userId)
  const firstAt = existing?.firstAt ?? now()
  if (existing) clearT(existing.timer)
  const delay = Math.max(0, Math.min(quiet, firstAt + maxWait - now()))
  const timer = setT(() => {
    pending.delete(userId)
    Promise.resolve()
      .then(() => evaluate(userId, sessionId))
      .catch((err: any) => console.warn(`[token-cap-alarm] evaluation failed: ${err?.message ?? err}`))
  }, delay)
  pending.set(userId, { timer, firstAt })
}

/** Test hook: drop pending state without firing. */
export function resetTokenCapAlarmScheduler(clearT: (t: unknown) => void = (t) => clearTimeout(t as any)): void {
  for (const p of pending.values()) clearT(p.timer)
  pending.clear()
}

/** Boot registration: usage events schedule an evaluation. No timers are created here. */
export function registerTokenCapAlarm(): void {
  setTokenUsageListener((u) => {
    if (!u.userId) return
    scheduleTokenCapAlarm(u.userId, u.sessionId ?? '')
  })
}
