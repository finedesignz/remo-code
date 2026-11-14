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

/** One 7d ticket per signature (deduped per outage by the ingest). Never throws; sends nothing when AAF is unconfigured. */
export function reportTicket(signature: string): void {
  void import('../agentautofix/reporter.ts')
    .then(({ reportSelfErrorToAgentautofix }) =>
      reportSelfErrorToAgentautofix({
        fingerprint: `corch-gsdc:${signature}`,
        errorType: 'CorchGsdcSourceFailure',
        errorValue: `gsd-console ingest failure signature: ${signature}`,
        source: 'corch-gsdc',
      }),
    )
    .catch(() => {})
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
  })
  current.start()
}

export function stopGsdcIngest(): void {
  current?.stop()
  current = null
}
