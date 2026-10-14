/**
 * PTYCAP-08-07 Task 1 (TQC-05, SC4): the digest names every finding with a proposal and a
 * runnable command, names every applied fix with its rollback SQL, sends exactly one email
 * for a run with findings and none for a run without. No database is reachable from here.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import type { Finding, ProposalKind, TaskQcResult } from '../src/task-qc/types.ts'

const emails: any[] = []
let sendResult = true
mock.module('../src/lib/email.ts', () => ({
  sendEmail: async (input: any) => {
    emails.push(input)
    return sendResult
  },
}))
mock.module('../src/db/postgres.ts', () => ({
  sql: () => {
    throw new Error('digest must not touch the database')
  },
}))
afterAll(() => mock.restore())

const { buildDigest, sendDigest } = await import(`../src/task-qc/digest.ts?proposals=${Date.now()}`)

beforeEach(() => {
  emails.length = 0
  sendResult = true
})

const ID = 'task-abc_1'
export function finding(over: Partial<Finding> = {}): Finding {
  return {
    detector: 'FAILING',
    taskId: ID,
    taskName: 'Nightly sweep',
    taskType: 'dev',
    severity: 'high',
    evidence: { failedRuns: 5, lastError: 'boom' },
    proposal: { kind: 'propose_disable', params: { taskId: ID } },
    ...over,
  }
}
const result = (over: Partial<TaskQcResult> = {}): TaskQcResult => ({
  findings: [],
  applied: [],
  proposals: [],
  truncated: false,
  ...over,
})
const asciiOnly = (s: string) => [...s].every((c) => c.charCodeAt(0) === 10 || c.charCodeAt(0) === 9 || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126))

describe('digest content (TQC-05, SC4)', () => {
  test('zero findings builds no digest and sendDigest sends nothing', async () => {
    expect(buildDigest(result(), {})).toBeNull()
    const sent = await sendDigest(result(), { email: 'o@example.com' })
    expect(sent).toBe(false)
    expect(emails).toHaveLength(0)
  })

  test('a proposals-only run builds exactly one digest and sends exactly one email', async () => {
    const f1 = finding()
    const f2 = finding({ detector: 'OPTIMIZE', taskId: 'task-2', taskName: 'Heavy prompt', severity: 'info', evidence: { arm: 'prompt_cost', promptChars: 9000 }, proposal: { kind: 'review_prompt_size', params: { taskId: 'task-2' } } })
    const r = result({ findings: [f1, f2], proposals: [f1, f2] })
    const d = buildDigest(r, {})
    expect(d).not.toBeNull()
    expect(asciiOnly(d.subject)).toBe(true)
    expect(d.subject).toContain('2 finding')
    expect(d.subject).not.toContain('Nightly sweep')
    expect(d.text).not.toMatch(/applied automatically \(/i)
    const sent = await sendDigest(r, { email: 'owner@example.com' })
    expect(sent).toBe(true)
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toBe('owner@example.com')
  })

  test('the body names every finding exactly once with its evidence and proposal', () => {
    const fs = (['FAILING', 'SKIP_FOREVER', 'NEVER_FIRED'] as const).map((detector, i) =>
      finding({ detector, taskId: `t-${i}`, taskName: `Task number ${i}`, proposal: { kind: 'propose_disable', params: { taskId: `t-${i}` } } }),
    )
    const d = buildDigest(result({ findings: fs, proposals: fs }), {})
    for (let i = 0; i < 3; i++) {
      expect(d.text.split(`Task number ${i}`)).toHaveLength(2)
      expect(d.text).toContain(`PATCH /api/scheduled-tasks/t-${i}`)
    }
    expect(d.text).toContain('failedRuns: 5')
    expect(d.text).toContain('lastError: boom')
  })

  test('high severity is listed before warn before info', () => {
    const a = finding({ taskId: 'a', taskName: 'InfoTask', severity: 'info', proposal: { kind: 'review_cadence', params: { taskId: 'a' } } })
    const b = finding({ taskId: 'b', taskName: 'HighTask', severity: 'high' })
    const c = finding({ taskId: 'c', taskName: 'WarnTask', severity: 'warn' })
    const d = buildDigest(result({ findings: [a, b, c] }), {})
    const order = ['HighTask', 'WarnTask', 'InfoTask'].map((n) => d.text.indexOf(n))
    expect(order[0]).toBeGreaterThan(-1)
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
  })

  test('an applied fix appears with task, kind, before, after and its rollback SQL', () => {
    const f = finding({ detector: 'MISCONFIGURED', severity: 'warn', evidence: { reason: 'timezone_invalid' }, proposal: { kind: 'fix_timezone', params: { taskId: ID } }, fixCandidate: 'normalize_timezone' })
    const rollback = `UPDATE scheduled_tasks SET timezone = 'Mars/Base' WHERE id = '${ID}' AND timezone IS NOT DISTINCT FROM 'UTC'`
    const r = result({
      findings: [f],
      applied: [{ finding: f, fix: 'normalize_timezone', taskId: ID, before: { timezone: 'Mars/Base' }, after: { timezone: 'UTC' }, rollbackSql: rollback }],
    })
    const d = buildDigest(r, {})
    expect(d.text).toMatch(/APPLIED AUTOMATICALLY \(1\)/)
    expect(d.text).toContain('normalize_timezone')
    expect(d.text).toContain('Mars/Base')
    expect(d.text).toContain(rollback)
    // the applied finding is not repeated as an open finding
    expect(d.text.split(ID).length - 1).toBeLessThanOrEqual(3)
    expect(d.subject).toContain('1 applied')
    expect(d.html).toContain('Applied automatically')
  })

  test('an applied normalize_timezone says the job is re-armed only at restart or next edit (no silent no-op)', () => {
    const f = finding({ detector: 'MISCONFIGURED', severity: 'warn', evidence: { reason: 'timezone_invalid' }, proposal: { kind: 'fix_timezone', params: { taskId: ID } }, fixCandidate: 'normalize_timezone' })
    const mk = (fix: any) => result({ findings: [f], applied: [{ finding: f, fix, taskId: ID, before: {}, after: {}, rollbackSql: 'UPDATE x' }] })
    expect(buildDigest(mk('normalize_timezone'), {}).text).toMatch(/re-armed at the next hub restart/)
    expect(buildDigest(mk('rebind_dead_session'), {}).text).not.toMatch(/re-armed/)
  })

  test('truncated passes are flagged in the summary', () => {
    const d = buildDigest(result({ findings: [finding()], truncated: true }), {})
    expect(d.text).toMatch(/truncated/i)
  })

  test('sendDigest returns the helper boolean and calls it once', async () => {
    sendResult = false
    const sent = await sendDigest(result({ findings: [finding()] }), { email: 'owner@example.com' })
    expect(sent).toBe(false)
    expect(emails).toHaveLength(1)
  })
})

describe('fixed command templates per proposal kind', () => {
  const kinds: Array<[ProposalKind, Record<string, string | number | boolean>, RegExp]> = [
    ['propose_disable', {}, /PATCH \/api\/scheduled-tasks\/task-abc_1\n\s+body: \{"enabled":false\}/],
    ['reregister_job', {}, /PATCH \/api\/scheduled-tasks\/task-abc_1\n\s+body: \{"enabled":true\}/],
    ['fix_cron', {}, /PATCH \/api\/scheduled-tasks\/task-abc_1\n\s+body: \{"cron_expr":"REPLACE_WITH_CRON"\}/],
    ['review_cadence', {}, /PATCH \/api\/scheduled-tasks\/task-abc_1\n\s+body: \{"cron_expr":"REPLACE_WITH_CRON"\}/],
    ['fix_timezone', {}, /UPDATE scheduled_tasks SET timezone = 'REPLACE_WITH_IANA_TIMEZONE' WHERE id = 'task-abc_1'/],
    ['fix_payload', {}, /UPDATE scheduled_tasks SET payload = payload \|\| jsonb_build_object\('application_uuid', 'REPLACE_WITH_APPLICATION_UUID'::text\) WHERE id = 'task-abc_1'/],
    ['set_teab_repo', {}, /UPDATE scheduled_tasks SET teab_repo_ident = 'REPLACE_WITH_REPO_IDENT' WHERE id = 'task-abc_1'/],
    ['rebind_session', { staleSessionId: "sess'1" }, /UPDATE scheduled_tasks SET session_id = 'REPLACE_WITH_LIVE_SESSION_ID', target_id = 'REPLACE_WITH_LIVE_SESSION_ID' WHERE id = 'task-abc_1' AND session_id IS NOT DISTINCT FROM 'sess''1'/],
  ]
  for (const [kind, extra, re] of kinds) {
    test(`${kind} renders its fixed command`, () => {
      const f = finding({ proposal: { kind, params: { taskId: ID, ...extra } } })
      const d = buildDigest(result({ findings: [f] }), {})
      expect(d.text).toMatch(re)
    })
  }

  test('merge_duplicates renders one PATCH per non-anchor member, validated ids only', () => {
    const f = finding({
      detector: 'OPTIMIZE',
      severity: 'info',
      evidence: { arm: 'duplicate', memberIds: [ID, 'dup-2', 'dup-3', 'bad id; DROP'], memberCount: 4 },
      proposal: { kind: 'merge_duplicates', params: { taskId: ID } },
    })
    const d = buildDigest(result({ findings: [f] }), {})
    expect(d.text).toContain('PATCH /api/scheduled-tasks/dup-2')
    expect(d.text).toContain('PATCH /api/scheduled-tasks/dup-3')
    expect(d.text).not.toContain('PATCH /api/scheduled-tasks/task-abc_1')
    expect(d.text).not.toMatch(/PATCH [^\n]*bad/)
  })

  test('review_prompt_size is advisory text with no command', () => {
    const f = finding({ detector: 'OPTIMIZE', severity: 'info', evidence: { arm: 'prompt_cost', promptChars: 9000 }, proposal: { kind: 'review_prompt_size', params: { taskId: ID } } })
    const d = buildDigest(result({ findings: [f] }), {})
    expect(d.text).not.toMatch(/PATCH|UPDATE scheduled_tasks/)
    expect(d.text).toMatch(/advisory/i)
  })

  test('a would-fix proposal names the fix the auto-fixer would apply', () => {
    const f = finding({ detector: 'MISCONFIGURED', severity: 'warn', evidence: { reason: 'app_uuid_unresolvable', would_fix: 'backfill_payload_from_sibling' }, proposal: { kind: 'fix_payload', params: { taskId: ID, candidates: 2 } } })
    const d = buildDigest(result({ findings: [f] }), {})
    expect(d.text).toContain('would apply: backfill_payload_from_sibling')
    expect(d.text).toContain('2 candidates')
  })

  test('an unrecognized id renders a marker and no command', () => {
    for (const bad of ["x'; DROP TABLE scheduled_tasks; --", 'a'.repeat(65), '', 'has space', 'new\nline']) {
      const f = finding({ taskId: bad, proposal: { kind: 'propose_disable', params: { taskId: bad } } })
      const d = buildDigest(result({ findings: [f] }), {})
      expect(d.text).toContain('unrecognized task id')
      expect(d.text).not.toMatch(/PATCH \/api|UPDATE scheduled_tasks/)
    }
  })
})

describe('caps', () => {
  test('more than 200 findings render 200 plus a not-shown line', () => {
    const fs = Array.from({ length: 250 }, (_, i) => finding({ taskId: `t${i}`, taskName: `T${i}` }))
    const d = buildDigest(result({ findings: fs }), {})
    expect((d.text.match(/^#\d+ /gm) ?? []).length).toBe(200)
    expect(d.text).toContain('50 more finding')
  })

  test('the whole body is capped with a final truncation line', () => {
    const big = 'x'.repeat(100)
    const fs = Array.from({ length: 200 }, (_, i) =>
      finding({ taskId: `t${i}`, evidence: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`key${k}`, big])) }),
    )
    const d = buildDigest(result({ findings: fs }), {})
    expect(d.text.length).toBeLessThanOrEqual(100_500)
    expect(d.text.trimEnd().split('\n').pop()).toMatch(/digest truncated/)
    expect(d.html.length).toBeLessThanOrEqual(300_000)
  })
})
