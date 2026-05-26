// In-memory store for per-user Anthropic Claude subscription usage snapshots.
// Cleared on hub restart — agents repoll every 5 minutes so the store
// reconverges quickly. No DB persistence required.

export interface UsageWindow {
  utilization: number
  resets_at: string
}

export interface UsagePayload {
  five_hour: UsageWindow
  seven_day: UsageWindow
  seven_day_opus?: UsageWindow | null
  seven_day_oauth_apps?: UsageWindow | null
}

export interface UsageSnapshot {
  usage: UsagePayload
  updated_at: string
}

const store = new Map<string, UsageSnapshot>()

export function setUsage(userId: string, usage: UsagePayload): UsageSnapshot {
  const snap: UsageSnapshot = { usage, updated_at: new Date().toISOString() }
  store.set(userId, snap)
  return snap
}

export function getUsage(userId: string): UsageSnapshot | null {
  return store.get(userId) ?? null
}

export function clearUsage(userId: string): void {
  store.delete(userId)
}

/** Test-only — wipe all snapshots. */
export function _resetUsageStoreForTests(): void {
  store.clear()
}
