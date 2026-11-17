// hub/src/corch/queue-view.ts
//
// CORCH-11 (CORCH-R6.1): the read model behind GET /api/corch/queue, the `corch_queue` WS event and the Telegram
// /queue summary. ONE builder, so the three surfaces can never disagree. Read-only: it never writes and never
// touches the dispatcher. No email or token field exists in any source row (quota rows carry account_id + slot only).

import type { CorchProject, CorchSettings, CorchStore, QueueViewItem, QueueViewRun } from './store.ts'
import { evaluateAccounts, type QuotaAccountRow } from './quota-eligibility.ts'

export const QUEUE_VIEW_MAX_ITEMS = 200

export interface QueueSnapshot {
  paused: boolean
  max_concurrent_runs: number
  projects: Array<Pick<CorchProject, 'id' | 'repo_ident' | 'priority' | 'enabled' | 'aaf_provision_status'>>
  /** Item counts per status over all items (the `items` list is capped; these are not). */
  counts: Record<string, number>
  items: Array<Omit<QueueViewItem, 'not_before' | 'created_at'> & { not_before: string | null; created_at: string }>
  live_runs: Array<Omit<QueueViewRun, 'started_at' | 'heartbeat_at'> & { started_at: string; heartbeat_at: string; age_seconds: number }>
  quota_accounts: Array<{ account_id: string; slot: string | null; eligible: boolean; reason: string | null; not_before: string | null; five_h_pct: number | null; seven_d_pct: number | null }>
  generated_at: string
}

export interface QueueViewDeps {
  store: Pick<CorchStore, 'listProjects' | 'getSettings' | 'queueViewItems' | 'queueViewRuns' | 'queueViewCounts'>
  accountsFor(userId: string): Promise<QuotaAccountRow[]>
  liveRunsByAccount(userId: string): Promise<Record<string, number>>
  ceilingPct(): number
  now(): Date
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString())

export async function buildQueueSnapshot(deps: QueueViewDeps, userId: string): Promise<QueueSnapshot> {
  const now = deps.now()
  const ceilingPct = deps.ceilingPct()
  const [projects, settings, items, runs, counts, rows, busyByAccount] = await Promise.all([
    deps.store.listProjects(userId),
    deps.store.getSettings(userId),
    deps.store.queueViewItems(userId, QUEUE_VIEW_MAX_ITEMS),
    deps.store.queueViewRuns(userId),
    deps.store.queueViewCounts(userId),
    deps.accountsFor(userId),
    deps.liveRunsByAccount(userId),
  ])
  const evals = evaluateAccounts(rows, { now, ceilingPct, busyByAccount })
  const s: CorchSettings = settings ?? { corch_paused: false, corch_max_concurrent_runs: 1 }
  return {
    paused: s.corch_paused,
    max_concurrent_runs: s.corch_max_concurrent_runs,
    counts,
    projects: projects.map((p) => ({
      id: p.id,
      repo_ident: p.repo_ident,
      priority: p.priority,
      enabled: p.enabled,
      aaf_provision_status: p.aaf_provision_status,
    })),
    items: items.map((i) => ({ ...i, not_before: iso(i.not_before), created_at: iso(i.created_at)! })),
    live_runs: runs.map((r) => ({
      ...r,
      started_at: iso(r.started_at)!,
      heartbeat_at: iso(r.heartbeat_at)!,
      age_seconds: Math.max(0, Math.round((now.getTime() - new Date(r.started_at).getTime()) / 1000)),
    })),
    quota_accounts: rows.map((r, i) => ({
      account_id: r.account_id,
      slot: r.slot,
      eligible: evals[i]!.eligible,
      reason: evals[i]!.reason,
      not_before: evals[i]!.not_before,
      five_h_pct: r.five_h_pct,
      seven_d_pct: r.seven_d_pct,
    })),
    generated_at: now.toISOString(),
  }
}

/** Real deps, built lazily so importing this module never opens the DB. */
export async function realQueueViewDeps(): Promise<QueueViewDeps> {
  const { corchStore } = await import('./store.ts')
  const { quotaStore } = await import('./quota-store.ts')
  const { corchQuotaCeilingPct } = await import('./flag.ts')
  return {
    store: corchStore,
    accountsFor: (u) => quotaStore.accountsFor(u),
    liveRunsByAccount: (u) => quotaStore.liveRunsByAccount(u),
    ceilingPct: corchQuotaCeilingPct,
    now: () => new Date(),
  }
}

/** The WS event the web panel renders. The full snapshot rides the event, so the client never re-fetches or polls. */
export interface CorchQueueEvent {
  type: 'corch_queue'
  queue: QueueSnapshot
}

/**
 * Publish the user's queue after a transition. Coalesced per user with promises only (no timer): a call while a
 * build is in flight marks one more build, so the LAST published snapshot always reflects the newest transition.
 * Never throws and never blocks the caller's transition (a failed publish is logged and dropped).
 */
export function createQueuePublisher(
  build: (userId: string) => Promise<QueueSnapshot>,
  send: (userId: string, event: CorchQueueEvent) => void,
  log: (msg: string) => void = (m) => console.warn(m),
): (userId: string) => Promise<void> {
  const running = new Map<string, Promise<void>>()
  const dirty = new Set<string>()
  return (userId) => {
    const cur = running.get(userId)
    if (cur) {
      dirty.add(userId)
      return cur
    }
    const p = (async () => {
      try {
        do {
          dirty.delete(userId)
          // A failed build is logged and dropped, but a trigger that arrived meanwhile still gets its own rebuild.
          try {
            send(userId, { type: 'corch_queue', queue: await build(userId) })
          } catch (err: any) {
            log(`[corch] queue publish failed user=${userId}: ${err?.message ?? err}`)
          }
        } while (dirty.has(userId))
      } finally {
        running.delete(userId)
      }
    })()
    running.set(userId, p)
    return p
  }
}

let realPublisher: ((userId: string) => Promise<void>) | null = null

/** Process-wide publisher over the real DB + WS registry. Safe with the flag OFF (reads only, nothing dispatches). */
export function publishCorchQueue(userId: string): Promise<void> {
  if (!realPublisher) {
    realPublisher = createQueuePublisher(
      async (u) => buildQueueSnapshot(await realQueueViewDeps(), u),
      (u, event) => {
        void import('../ws/registry.ts').then((m) => m.broadcastToUser(u, event)).catch(() => {})
      },
    )
  }
  return realPublisher(userId)
}
