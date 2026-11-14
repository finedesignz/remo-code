// hub/src/corch/gsdc-boot.ts
//
// CORCH-04: boot wiring for the gsd-console ingest. A true no-op (no ingest object, no store access, no
// connection, no timer) while REMO_CORCH_ENABLED is OFF or REMO_CORCH_GSDC_URL / REMO_CORCH_GSDC_TOKEN are unset.

import { corchEnabled, gsdcConfig } from './flag.ts'
import { createGsdcIngest, type GsdcOutage } from './gsdc-ingest.ts'
import { corchStore } from './store.ts'
import { evaluateUserNow, REAL_TIMERS } from './dispatcher.ts'

async function notifyOutage(o: GsdcOutage): Promise<string[]> {
  const { fanOutNotify } = await import('../orchestrator/notify.ts')
  // The detail carries the error signature only: never console text, never the token.
  const reached: string[] = []
  for (const userId of o.userIds) {
    if (!o.isLive()) break // stopped or superseded: no further recipients
    const r = await fanOutNotify({
      userId,
      sessionId: '',
      event: 'failure',
      level: 'blocking',
      detail: `CORCH gsd-console source unavailable (${o.signature}); no work was added or cancelled from it`,
      channels: ['telegram', 'email'],
    })
    // inapp is a live-socket broadcast that persists nothing, so it never counts. Delivered only on a durable
    // channel: email (accepted by the mail service) or telegram (stored by Telegram for the owner).
    if (r.delivered.includes('email') || r.delivered.includes('telegram')) reached.push(userId)
  }
  return reached
}

/**
 * One 7d ticket per signature (deduped per outage by the ingest). True only on a positive delivery, so the ingest
 * retries a failed one. Immediate (non-aggregated, no hourly throttle) so a second outage with the same signature
 * is still ticketed. Never throws; sends nothing and returns false when AgentAutofix is unconfigured.
 */
export async function reportTicket(signature: string): Promise<boolean> {
  try {
    const { reportTriageFindingToAgentautofix } = await import('../agentautofix/reporter.ts')
    return await reportTriageFindingToAgentautofix({
      fingerprint: `corch-gsdc:${signature}`,
      errorType: 'CorchGsdcSourceFailure',
      errorValue: `gsd-console ingest failure signature: ${signature}`,
      source: 'corch-gsdc',
    })
  } catch {
    return false
  }
}

let current: ReturnType<typeof createGsdcIngest> | null = null

export function startGsdcIngest(): void {
  if (!corchEnabled() || gsdcConfig().state === 'off') return
  if (current) return
  current = createGsdcIngest({
    store: corchStore,
    fetch: (url, init) => fetch(url, init),
    timers: REAL_TIMERS,
    notifyOutage,
    reportTicket,
    onEnqueued: evaluateUserNow,
    // CORCH-09: an item the console cancelled releases its kept worktree and memlog claim.
    onCancelled: async (items) => {
      const { releaseWorkItemNow } = await import('./dispatcher.ts')
      for (const i of items) await releaseWorkItemNow({ userId: i.userId, itemId: i.itemId, status: 'cancelled' })
    },
  })
  current.start()
}

export function stopGsdcIngest(): void {
  current?.stop()
  current = null
}
