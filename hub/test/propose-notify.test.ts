/**
 * auto-dev P3 — propose-to-chat + HITL unit tests.
 *
 * Pure helpers (parse/format/resolve) need no mocks. The throttle + capture
 * paths mock `../src/db/postgres.ts` (sql) and the post-run senders so the test
 * never touches Postgres or the network. Cache-bust the dynamic import + restore
 * mocks in afterAll to avoid cross-file bun mock.module pollution.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test'

// ── In-memory fakes ──────────────────────────────────────────────────────────
// notifications_sent rows the fake `sql` has "inserted" this run.
const notifyRows: Array<{ kind: string; dedupe_key: string; sent_at: number }> = []
// pending_proposal store keyed by taskId.
const pendingStore = new Map<string, any>()
// notes captured per taskId.
const notesStore = new Map<string, string>()
const emailCalls: any[] = []
const telegramCalls: any[] = []

// Fake tagged-template `sql`. We only need to satisfy the specific queries the
// module under test issues — match on the raw SQL text.
function fakeSql(strings: TemplateStringsArray, ...vals: any[]): any {
  const text = strings.join('?').replace(/\s+/g, ' ').trim()
  // throttle SELECT — kind is a SQL literal; params are [dedupeKey, ttlSeconds].
  if (text.startsWith('SELECT id FROM notifications_sent')) {
    const [dedupeKey, ttl] = vals as [string, number]
    const cutoff = Date.now() - ttl * 1000
    const hit = notifyRows.find(
      (r) => r.kind === 'propose_roadmap' && r.dedupe_key === dedupeKey && r.sent_at > cutoff,
    )
    return Promise.resolve(hit ? [{ id: 'x' }] : [])
  }
  // throttle INSERT — kind is a SQL literal; the only param is [dedupeKey].
  if (text.startsWith('INSERT INTO notifications_sent')) {
    const [dedupeKey] = vals as [string]
    notifyRows.push({ kind: 'propose_roadmap', dedupe_key: dedupeKey, sent_at: Date.now() })
    return Promise.resolve([])
  }
  throw new Error(`fakeSql: unexpected query: ${text}`)
}
;(fakeSql as any).json = (v: any) => v

mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

mock.module('../src/scheduler/post-run/email.ts', () => ({
  executeEmail: async (action: any, ctx: any) => {
    emailCalls.push({ action, ctx })
  },
}))
mock.module('../src/scheduler/post-run/telegram.ts', () => ({
  executeTelegram: async (action: any, ctx: any) => {
    telegramCalls.push({ action, ctx })
  },
}))

// DAL: override only the three P3 helpers; keep the rest real (the module
// transitively imports the whole DAL).
const realDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  setPendingProposal: async (taskId: string, proposal: any) => {
    pendingStore.set(taskId, proposal)
  },
  findPendingProposalTasksForUser: async (_userId: string) =>
    [...pendingStore.entries()]
      .map(([id, proposal]) => ({ id, name: `task-${id}`, proposal }))
      .sort((a, b) => (b.proposal.proposed_at > a.proposal.proposed_at ? 1 : -1)),
  captureProposalNotes: async (taskId: string, _userId: string, notes: string) => {
    if (!pendingStore.has(taskId)) return false
    notesStore.set(taskId, notes)
    pendingStore.delete(taskId)
    return true
  },
}))

const mod = await import('../src/scheduler/post-run/propose-notify.ts?p3')
const {
  parseRoadmapItems,
  formatProposalMessage,
  resolveApprovalNotes,
  parsePureSelection,
  surfaceProposal,
  captureApprovalReply,
} = mod as any

afterAll(() => mock.restore())

function resetState() {
  notifyRows.length = 0
  pendingStore.clear()
  notesStore.clear()
  emailCalls.length = 0
  telegramCalls.length = 0
}

const task = (over: any = {}) => ({
  id: 't1',
  user_id: 'u1',
  name: 'Nightly Dev on acme/widget',
  task_type: 'dev',
  ...over,
})
const decision = (roadmap: string | null) => ({
  action: 'propose',
  reason: 'no plan and no goal',
  next_goal: '',
  roadmap,
})

describe('propose-notify pure helpers', () => {
  test('parseRoadmapItems splits on " | " and strips bullets/numbering', () => {
    expect(parseRoadmapItems('Auth | Billing | Dashboard')).toEqual([
      'Auth',
      'Billing',
      'Dashboard',
    ])
    expect(parseRoadmapItems('1. Auth\n2. Billing')).toEqual(['Auth', 'Billing'])
    expect(parseRoadmapItems('   ')).toEqual([])
  })

  test('formatProposalMessage numbers items + reply instruction', () => {
    const msg = formatProposalMessage('My Routine', ['Auth', 'Billing'])
    expect(msg).toContain('Routine "My Routine" has no plan or goal and proposes:')
    expect(msg).toContain('1. Auth')
    expect(msg).toContain('2. Billing')
    expect(msg).toContain('Reply with the number(s) or text to approve')
  })

  test('parsePureSelection only matches numeric selections', () => {
    const items = ['Auth', 'Billing', 'Dashboard']
    expect(parsePureSelection(items, '1')).toBe('Auth')
    expect(parsePureSelection(items, '1, 3')).toBe('Auth; Dashboard')
    expect(parsePureSelection(items, '1 and 2')).toBe('Auth; Billing')
    expect(parsePureSelection(items, 'build the auth thing')).toBeNull()
    expect(parsePureSelection(items, '9')).toBeNull() // out of range
  })

  test('resolveApprovalNotes: selection → items, free text → verbatim', () => {
    const items = ['Auth', 'Billing']
    expect(resolveApprovalNotes(items, '2')).toBe('Billing')
    expect(resolveApprovalNotes(items, 'do the billing flow first')).toBe(
      'do the billing flow first',
    )
    expect(resolveApprovalNotes(items, '')).toBeNull()
  })
})

describe('surfaceProposal: notify + throttle/dedupe', () => {
  test('fires email + telegram with formatted roadmap; persists pending', async () => {
    resetState()
    const msg = await surfaceProposal({
      task: task(),
      decision: decision('Auth | Billing | Dashboard'),
      runId: 'run1',
    })
    expect(msg).toContain('1. Auth')
    expect(emailCalls).toHaveLength(1)
    expect(telegramCalls).toHaveLength(1)
    // the synthesized action body renders {{proposal}} via the sender
    expect(emailCalls[0].ctx.templateVars.proposal).toContain('2. Billing')
    expect(pendingStore.get('t1').items).toEqual(['Auth', 'Billing', 'Dashboard'])
  })

  test('two ticks with the SAME roadmap within the window → ONE notify', async () => {
    resetState()
    const args = { task: task(), decision: decision('Auth | Billing'), runId: 'r' }
    const first = await surfaceProposal(args)
    const second = await surfaceProposal(args)
    expect(first).not.toBeNull()
    expect(second).toBeNull() // suppressed by throttle
    expect(emailCalls).toHaveLength(1)
    expect(telegramCalls).toHaveLength(1)
  })

  test('different roadmap → new dedupe key → notifies again', async () => {
    resetState()
    await surfaceProposal({ task: task(), decision: decision('Auth | Billing'), runId: 'r' })
    await surfaceProposal({ task: task(), decision: decision('Search | Export'), runId: 'r' })
    expect(emailCalls).toHaveLength(2)
  })

  test('empty roadmap → no notify, no pending', async () => {
    resetState()
    const msg = await surfaceProposal({ task: task(), decision: decision(null), runId: 'r' })
    expect(msg).toBeNull()
    expect(emailCalls).toHaveLength(0)
    expect(pendingStore.size).toBe(0)
  })
})

describe('captureApprovalReply: HITL → payload.notes', () => {
  test('numeric selection writes chosen item to notes + clears pending', async () => {
    resetState()
    pendingStore.set('t9', {
      roadmap: 'Auth | Billing | Dashboard',
      items: ['Auth', 'Billing', 'Dashboard'],
      run_id: 'r',
      proposed_at: new Date().toISOString(),
    })
    const res = await captureApprovalReply('u1', '1, 3', { requireSelection: true })
    expect(res).not.toBeNull()
    expect(res.notes).toBe('Auth; Dashboard')
    expect(notesStore.get('t9')).toBe('Auth; Dashboard')
    expect(pendingStore.has('t9')).toBe(false) // proposal cleared
  })

  test('requireSelection ignores free-form chat (no hijack)', async () => {
    resetState()
    pendingStore.set('t9', {
      roadmap: 'Auth',
      items: ['Auth'],
      run_id: 'r',
      proposed_at: new Date().toISOString(),
    })
    const res = await captureApprovalReply('u1', 'what is the weather', {
      requireSelection: true,
    })
    expect(res).toBeNull()
    expect(pendingStore.has('t9')).toBe(true) // untouched
  })

  test('no pending proposal → null (regular chat passes through)', async () => {
    resetState()
    const res = await captureApprovalReply('u1', '1', { requireSelection: true })
    expect(res).toBeNull()
  })
})
