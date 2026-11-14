// hub/src/corch/queue-telegram.ts
//
// CORCH-11 (CORCH-R6.4): the read-only Telegram /queue summary. A human surface: it is not kill-switch gated and
// it never writes, so there is no pause / priority / cancel here (those stay web-only). Pure renderer + one
// handler; the snapshot comes from the same builder as GET /api/corch/queue.

import type { QueueSnapshot } from './queue-view.ts'

export const QUEUE_TOP_N = 5

const short = (repo: string) => repo.replace(/^github:\/\//, '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s)

export function renderQueueSummary(q: QueueSnapshot): string {
  const queued = q.items.filter((i) => i.status === 'queued')
  const blocked = q.counts.blocked ?? 0
  const queuedTotal = q.counts.queued ?? queued.length
  const lines: string[] = [
    `CORCH queue: ${q.paused ? 'PAUSED (live runs continue, nothing new starts)' : 'running'}`,
    `Live runs: ${q.live_runs.length}/${q.max_concurrent_runs}`,
  ]
  for (const r of q.live_runs) lines.push(`  - ${short(r.repo_ident)} (${r.status}${r.account_slot ? `, slot ${r.account_slot}` : ''})`)
  lines.push(`Queued: ${queuedTotal}`)
  queued.slice(0, QUEUE_TOP_N).forEach((i, n) => {
    lines.push(`  ${n + 1}. ${short(i.repo_ident)}: ${clip(i.title, 60)} [p${i.priority}] ${i.wait_reason ? `waiting: ${clip(i.wait_reason, 40)}` : 'ready'}`)
  })
  if (queuedTotal > QUEUE_TOP_N) lines.push(`  ...and ${queuedTotal - QUEUE_TOP_N} more`)
  lines.push(`Blocked: ${blocked}`)
  return lines.join('\n')
}
