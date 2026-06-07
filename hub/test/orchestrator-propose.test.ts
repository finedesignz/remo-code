/**
 * Phase 28 (auto-dev-orchestrator) — tiered-autonomy propose-to-chat.
 *
 * REUSE assertion: the orchestrator propose path rides the SHIPPED P3 building
 * blocks — the `executeEmail` / `executeTelegram` post-run senders + the
 * `notifications_sent` throttle (kind `propose_roadmap`). We mock both senders and
 * a fake `sql` so the test NEVER touches Telegram, email, or Postgres.
 *
 * Covers:
 *   1. proposeToChat formats + calls BOTH senders for ship / complete-milestone / tag.
 *   2. throttle suppresses a duplicate within the TTL (second identical call → no send).
 *   3. verify-tail surface (notifyChatSurface) surfaces via the SAME notify path.
 *   4. flag-OFF dormancy: STUB_SEAMS.proposeToChat does NOT send (no senders called).
 *   5. only powerful commands propose — build/qc/plan/execute are NOT propose units
 *      (PROPOSE_COMMANDS membership), so the wave runner never routes them here.
 *
 * Bun's mock.module is process-global — restored in afterAll (feedback_bun_mock_pollution).
 */
import { describe, test, expect, mock, afterEach, afterAll } from 'bun:test'

// ── In-memory fakes ──────────────────────────────────────────────────────────
// notifications_sent rows the fake `sql` has "inserted" this run.
const notifyRows: Array<{ kind: string; dedupe_key: string; sent_at: number }> = []
const emailCalls: any[] = []
const telegramCalls: any[] = []

// Fake tagged-template `sql` — matches only the two throttle queries propose.ts issues.
function fakeSql(strings: TemplateStringsArray, ...vals: any[]): any {
  const text = strings.join('?').replace(/\s+/g, ' ').trim()
  if (text.startsWith('SELECT id FROM notifications_sent')) {
    const [dedupeKey, ttl] = vals as [string, number]
    const cutoff = Date.now() - ttl * 1000
    const hit = notifyRows.find(
      (r) => r.kind === 'propose_roadmap' && r.dedupe_key === dedupeKey && r.sent_at > cutoff,
    )
    return Promise.resolve(hit ? [{ id: 'x' }] : [])
  }
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

// Import AFTER the mocks so propose.ts binds the fakes. Cache-bust the import.
const mod = await import('../src/orchestrator/propose.ts?p28')
const { proposeToChat, notifyChatSurface, composeProposalMessage } = mod
const { PROPOSE_COMMANDS } = await import('../src/orchestrator/waves.ts')

function unit(command: string, microPrompt: string | null = null) {
  return { command, propose: true, priority: 0, microPrompt }
}
const ctx = { sessionId: 'sess-1', repoKey: 'finedesignz/remo-code', userId: 'user-1' }

afterEach(() => {
  notifyRows.length = 0
  emailCalls.length = 0
  telegramCalls.length = 0
})
afterAll(() => {
  mock.restore()
})

describe('composeProposalMessage (pure)', () => {
  test('names the command + repo + one-tap instruction; no fabricated PR diff', () => {
    const msg = composeProposalMessage(unit('ship'), 'finedesignz/remo-code')
    expect(msg).toContain('finedesignz/remo-code')
    expect(msg).toContain('HIGH-TIER')
    expect(msg).toContain('APPROVE')
    expect(msg).toContain('ship')
  })
  test('includes micro-prompt context when present', () => {
    const msg = composeProposalMessage(unit('tag', 'v1.2.0 release'), 'r')
    expect(msg).toContain('v1.2.0 release')
  })
})

describe('proposeToChat — surfaces high-tier commands via P3 senders', () => {
  for (const cmd of ['ship', 'complete-milestone', 'tag']) {
    test(`${cmd} → email + telegram sent once`, async () => {
      const res = await proposeToChat(unit(cmd), ctx)
      expect(res.surfaced).toBe(true)
      expect(res.throttled).toBe(false)
      expect(emailCalls.length).toBe(1)
      expect(telegramCalls.length).toBe(1)
      // Reuse check: the synthesized actions are the P3 post-run notify shapes.
      expect(emailCalls[0].action.type).toBe('notify_email')
      expect(telegramCalls[0].action.type).toBe('notify_telegram')
      expect(emailCalls[0].ctx.userId).toBe('user-1')
    })
  }

  test('throttle suppresses an identical proposal within the TTL', async () => {
    const first = await proposeToChat(unit('ship'), ctx)
    expect(first.surfaced).toBe(true)
    expect(emailCalls.length).toBe(1)

    const second = await proposeToChat(unit('ship'), ctx)
    expect(second.surfaced).toBe(false)
    expect(second.throttled).toBe(true)
    // No new send on the duplicate.
    expect(emailCalls.length).toBe(1)
    expect(telegramCalls.length).toBe(1)
  })

  test('no userId → not surfaced (best-effort, no send)', async () => {
    const res = await proposeToChat(unit('ship'), { ...ctx, userId: null })
    expect(res.surfaced).toBe(false)
    expect(emailCalls.length).toBe(0)
    expect(telegramCalls.length).toBe(0)
  })

  test('does NOT import the run-log (wave runner owns the proposed row)', async () => {
    // propose.ts must not import appendRunLog — the 'proposed' row is runUnit's job.
    const src = await Bun.file(new URL('../src/orchestrator/propose.ts', import.meta.url)).text()
    expect(src).not.toMatch(/import\s[^\n]*appendRunLog/)
    expect(src).not.toMatch(/from\s+['"]\.\/run-log\.ts['"]/)
  })
})

describe('notifyChatSurface — verify-tail exhausted-fix surface', () => {
  test('surfaces via the same email + telegram path', async () => {
    await notifyChatSurface({ sessionId: 'sess-1', userId: 'user-1', summary: 'broken deploy' })
    expect(emailCalls.length).toBe(1)
    expect(telegramCalls.length).toBe(1)
    expect(emailCalls[0].ctx.templateVars.proposal).toContain('broken deploy')
  })
  test('throttle suppresses an identical summary within the TTL', async () => {
    await notifyChatSurface({ sessionId: 'sess-1', userId: 'user-1', summary: 'same' })
    await notifyChatSurface({ sessionId: 'sess-1', userId: 'user-1', summary: 'same' })
    expect(emailCalls.length).toBe(1)
  })
  test('no userId → log-only, no send', async () => {
    await notifyChatSurface({ sessionId: 'sess-1', userId: null, summary: 'x' })
    expect(emailCalls.length).toBe(0)
    expect(telegramCalls.length).toBe(0)
  })
})

describe('tiered-autonomy boundary', () => {
  test('only ship/complete-milestone/tag are PROPOSE commands', () => {
    expect(PROPOSE_COMMANDS.has('ship')).toBe(true)
    expect(PROPOSE_COMMANDS.has('complete-milestone')).toBe(true)
    expect(PROPOSE_COMMANDS.has('tag')).toBe(true)
    // Autonomous-tier commands are NOT propose units → never routed to proposeToChat.
    for (const c of ['plan', 'execute', 'audit-fix', 'gap-scan', 'code-review', 'verify-work']) {
      expect(PROPOSE_COMMANDS.has(c)).toBe(false)
    }
  })

  test('flag-OFF dormancy: STUB_SEAMS.proposeToChat sends nothing', async () => {
    const prev = process.env.REMO_ORCHESTRATOR_ENABLED
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    const { STUB_SEAMS } = await import('../src/orchestrator/wave-runner.ts?p28stub')
    await STUB_SEAMS.proposeToChat(unit('ship'), ctx)
    expect(emailCalls.length).toBe(0)
    expect(telegramCalls.length).toBe(0)
    if (prev !== undefined) process.env.REMO_ORCHESTRATOR_ENABLED = prev
  })
})
