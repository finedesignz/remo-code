/**
 * Push-notification registration stub.
 *
 * Phase 12.2 lands the consumer surface so Phase 12 v1.1 is a one-file change.
 * No-op today. When `isMobileApp()` is true we log a single line so we can
 * grep for callers in dev builds; in the browser this function does nothing.
 */

import { isMobileApp } from './platform'

let logged = false

export async function registerForPush(): Promise<void> {
  if (!isMobileApp()) return
  if (logged) return
  logged = true
  // eslint-disable-next-line no-console
  console.log('[push] registerForPush() called — stub; real implementation lands in Phase 12 v1.1')
}
