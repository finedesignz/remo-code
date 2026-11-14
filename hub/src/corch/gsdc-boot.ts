// hub/src/corch/gsdc-boot.ts
//
// CORCH-04: boot wiring for the gsd-console ingest. A true no-op (no ingest object, no store access, no
// connection, no timer) while REMO_CORCH_ENABLED is OFF or REMO_CORCH_GSDC_URL / REMO_CORCH_GSDC_TOKEN are unset.

import { corchEnabled, gsdcConfig } from './flag.ts'
import { createGsdcIngest, type GsdcOutage } from './gsdc-ingest.ts'
import { corchStore } from './store.ts'
import { evaluateUserNow, REAL_TIMERS } from './dispatcher.ts'

async function notifyOutage(o: GsdcOutage): Promise<void> {
  const { fanOutNotify } = await import('../orchestrator/notify.ts')
  // The detail carries the error signature only: never console text, never the token.
  let delivered = 0
  for (const userId of o.userIds) {
    if (!o.isLive()) return // stopped or superseded: no further recipients
    const r = await fanOutNotify({
      userId,
      sessionId: '',
      event: 'failure',
      level: 'blocking',
      detail: `CORCH gsd-console source unavailable (${o.signature}); no work was added or cancelled from it`,
      channels: ['telegram', 'inapp', 'email', 'push'],
    })
    if (r.delivered.length > 0) delivered++
  }
  // fanOutNotify swallows channel failures: when NO owner got it on any channel, throw so the ingest keeps
  // the outage un-notified and retries on the next failure instead of going silent for its whole length.
  if (o.userIds.length > 0 && delivered === 0) throw new Error('gsdc_outage_notification_undelivered')
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
    onEnqueued: evaluateUserNow,
  })
  current.start()
}

export function stopGsdcIngest(): void {
  current?.stop()
  current = null
}
