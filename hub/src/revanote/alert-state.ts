import { fanOutNotify, type NotifyInput } from '../orchestrator/notify.ts'
import { sql } from '../db/postgres.ts'

export interface IncidentState { fingerprint: string; notifiedAt: number }

export function shouldNotifyIncident(previous: IncidentState | null, fingerprint: string, now: number, cooldown: number): boolean {
  return !previous || (previous.fingerprint !== fingerprint && now - previous.notifiedAt >= cooldown)
}

/** Serialize each user's monitor across sweeps/replicas. Store only delivered
 * incidents, and never include elapsed age in the fingerprint. The short
 * transaction holds an advisory lock through the bounded notification send.
 * A crash after delivery but before commit can repeat once (at-least-once).
 */
export async function notifyIncident(
  userId: string, monitor: string, fingerprint: string, now: number, cooldown: number,
  send: () => Promise<{ delivered: string[] }>,
  db = sql,
): Promise<boolean> {
  return db.begin(async tx => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${`revanote-alert:${userId}:${monitor}`}, 0)) AS acquired`
    if (!lock.acquired) return false
    const [row] = await tx`SELECT fingerprint, notified_at FROM revanote_alert_state WHERE user_id = ${userId} AND monitor = ${monitor}`
    const previous = row ? { fingerprint: row.fingerprint, notifiedAt: new Date(row.notified_at).getTime() } : null
    if (!shouldNotifyIncident(previous, fingerprint, now, cooldown)) return false
    const result = await send()
    if (result.delivered.length === 0) return false
    await tx`INSERT INTO revanote_alert_state (user_id, monitor, fingerprint, notified_at)
      VALUES (${userId}, ${monitor}, ${fingerprint}, ${new Date(now)})
      ON CONFLICT (user_id, monitor) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, notified_at = EXCLUDED.notified_at`
    return true
  }) as Promise<boolean>
}

/** A successful full sweep is the authority for recovery. A failed load must
 * never call this: otherwise a transient DB failure would re-arm every alert. */
export async function clearRecoveredIncidents(monitor: string, activeUsers: string[], observedAt: number, db = sql): Promise<void> {
  await db`DELETE FROM revanote_alert_state WHERE starts_with(monitor, ${monitor + ':'}) AND notified_at <= ${new Date(observedAt)} AND NOT (user_id = ANY(${db.array(activeUsers)}::uuid[]))`
}

/** Independent channel receipts: an in-app broadcast cannot mask a failed email. */
export async function notifyIncidentChannels(input: NotifyInput, monitor: string, fingerprint: string, now: number, cooldown: number, deps = { notify: notifyIncident, send: fanOutNotify }): Promise<{ delivered: string[] }> {
  const delivered: string[] = []
  for (const channel of input.channels) {
    const sent = await deps.notify(input.userId, `${monitor}:${channel}`, fingerprint, now, cooldown,
      () => deps.send({ ...input, channels: [channel] }))
    if (sent) delivered.push(channel)
  }
  return { delivered }
}
