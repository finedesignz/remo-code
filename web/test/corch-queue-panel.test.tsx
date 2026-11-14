/**
 * CORCH-11 (R6.1, R6.3): the queue panel renders from a snapshot, is fed by the `corch_queue` WS event
 * (pure reducer, no polling in the hook), and offers cancel only on queued items.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { CorchQueueView } from '../src/components/CorchQueuePanel'
import { reduceCorchQueue, type CorchQueue } from '../src/hooks/useCorchQueue'

const item = (over: Partial<CorchQueue['items'][number]>): CorchQueue['items'][number] => ({
  id: 'i1', project_id: 'p1', repo_ident: 'github://acme/app', title: 'Fix the thing', source: 'manual', priority: 3,
  status: 'queued', wait_reason: null, not_before: null, attempts: 0, pr_url: null, created_at: '2026-11-14T00:00:00Z', ...over,
})

const Q: CorchQueue = {
  paused: false,
  max_concurrent_runs: 2,
  projects: [],
  items: [
    item({ id: 'q', title: 'Queued one', wait_reason: 'quota:5h' }),
    item({ id: 'r', title: 'Running one', status: 'running' }),
    item({ id: 'b', title: 'Blocked one', status: 'blocked', wait_reason: 'launch_error' }),
    item({ id: 'd', title: 'Done one', status: 'done' }),
  ],
  live_runs: [{ id: 'run1', work_item_id: 'r', repo_ident: 'github://acme/app', status: 'running', account_slot: 'slot-a', supervisor_id: 's', started_at: 'x', heartbeat_at: 'y', age_seconds: 125 }],
  quota_accounts: [{ account_id: 'a1', slot: 'slot-a', eligible: false, reason: 'quota:over_ceiling', not_before: null, five_h_pct: 61.4, seven_d_pct: 10 }],
  generated_at: 'z',
}
const noop = { setPaused: async () => {}, setPriority: async () => {}, cancel: async () => {} }
const html = (q: CorchQueue | null, error: string | null = null) => renderToStaticMarkup(createElement(CorchQueueView, { queue: q, error, actions: noop }))

describe('reduceCorchQueue', () => {
  test('accepts only a corch_queue event with a snapshot', () => {
    expect(reduceCorchQueue({ type: 'corch_queue', queue: Q })).toBe(Q)
    expect(reduceCorchQueue({ type: 'subscription_usage', queue: Q })).toBeNull()
    expect(reduceCorchQueue({ type: 'corch_queue' })).toBeNull()
    expect(reduceCorchQueue({ type: 'corch_queue', queue: { items: 1 } })).toBeNull()
    expect(reduceCorchQueue(null)).toBeNull()
  })
})

describe('CorchQueueView', () => {
  test('renders items, live run, wait reason, quota account', () => {
    const h = html(Q)
    expect(h).toContain('Queued one')
    expect(h).toContain('quota:5h')
    expect(h).toContain('Running one')
    expect(h).toContain('slot-a')
    expect(h).toContain('2m') // 125s
    expect(h).toContain('1/2') // live runs / cap
    expect(h).toContain('Recently closed')
    expect(h).toContain('61%')
  })

  test('cancel control exists only for queued items', () => {
    const h = html(Q)
    expect(h.match(/aria-label="Cancel"/g)?.length).toBe(1)
    const queuedRow = h.split('<li').find((s) => s.includes('data-status="queued"'))!
    expect(queuedRow).toContain('aria-label="Cancel"')
    for (const st of ['running', 'blocked', 'done']) {
      expect(h.split('<li').find((s) => s.includes(`data-status="${st}"`))!).not.toContain('aria-label="Cancel"')
    }
  })

  test('pause button flips to resume and shows a paused dot when paused', () => {
    expect(html(Q)).toContain('aria-label="Pause dispatch"')
    const h = html({ ...Q, paused: true })
    expect(h).toContain('aria-label="Resume dispatch"')
    expect(h).toContain('aria-label="Paused"')
  })

  test('empty queue says Idle; no snapshot shows loading or the error', () => {
    expect(html({ ...Q, items: [], live_runs: [], quota_accounts: [] })).toContain('Idle')
    expect(html(null)).toContain('Loading queue')
    expect(html(null, 'boom')).toContain('boom')
  })

  test('icon buttons carry tooltips and accessible names, no native title attribute', () => {
    const h = html(Q)
    expect(h).toContain('role="tooltip"')
    expect(h).not.toMatch(/\btitle=/)
    expect(h).toContain('aria-label="Raise priority"')
  })
})

describe('no client polling', () => {
  test('the hook and panel schedule nothing: no interval, no timeout, no rAF loop', () => {
    for (const f of ['../src/hooks/useCorchQueue.ts', '../src/components/CorchQueuePanel.tsx']) {
      const src = readFileSync(join(import.meta.dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
      expect(src).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
    }
  })
  test('the hook fetches once on mount and otherwise subscribes to the WS event', () => {
    const src = readFileSync(join(import.meta.dir, '../src/hooks/useCorchQueue.ts'), 'utf8')
    expect((src.match(/'\/api\/corch\/queue'/g) ?? []).length).toBe(1)
    expect(src).toContain("'corch_queue'")
    expect(src).toContain('subscribe(')
  })
})
