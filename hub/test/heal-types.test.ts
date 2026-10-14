/**
 * PTYCAP-07-01 -- closed HealEvent union + HealOutcome vocabulary (SH-02, AM-F2-4).
 */
import { describe, test, expect } from 'bun:test'
import { parseHealEvent, outcomeToString, type HealOutcome } from '../src/heal/types.ts'

const base = { user_id: 'u1', repo_ident: 'github://acme/app', prompt: 'fix it', metadata_run_id: null, trigger_run_id: null }

const coolify = {
  ...base,
  source: 'coolify_deploy',
  dedupe_key: 'coolify:app-1',
  ctx: { application_uuid: 'app-1', deployment_uuid: 'dep-1', log_snippet: 'boom' },
}
const task = {
  ...base,
  source: 'scheduled_task',
  dedupe_key: 'task:t1',
  bound_session_id: 's1',
  ctx: { task_id: 't1', task_name: 'nightly', error_signature: 'sig' },
}
const err = {
  ...base,
  source: 'error_capture',
  dedupe_key: 'err:e1',
  bound_session_id: 's1',
  ctx: { error_id: 'e1', project_id: 'p1' },
}
const fb = {
  ...base,
  source: 'feedback',
  dedupe_key: 'fb:f1',
  bound_session_id: 's1',
  ctx: { submission_id: 'f1' },
}

function ok(v: unknown): boolean {
  try {
    parseHealEvent(v)
    return true
  } catch {
    return false
  }
}

describe('parseHealEvent', () => {
  test('accepts a valid event for each of the four sources', () => {
    for (const e of [coolify, task, err, fb]) {
      const out = parseHealEvent(e)
      expect(out.source).toBe(e.source as never)
    }
  })
  test('stored_content defaults to prompt', () => {
    expect(parseHealEvent(coolify).stored_content).toBe('fix it')
    expect(parseHealEvent({ ...coolify, stored_content: 'x' }).stored_content).toBe('x')
  })
  test('rejects unknown source', () => {
    expect(ok({ ...coolify, source: 'other' })).toBe(false)
  })
  test('rejects empty user_id or prompt', () => {
    expect(ok({ ...coolify, user_id: '' })).toBe(false)
    expect(ok({ ...coolify, prompt: '' })).toBe(false)
  })
  test('rejects dedupe_key lacking its source prefix', () => {
    expect(ok({ ...coolify, dedupe_key: 'app-1' })).toBe(false)
    expect(ok({ ...task, dedupe_key: 'coolify:t1' })).toBe(false)
    expect(ok({ ...err, dedupe_key: 'e1' })).toBe(false)
    expect(ok({ ...fb, dedupe_key: 'err:f1' })).toBe(false)
  })
  test('a coolify_deploy event with bound_session_id fails parsing', () => {
    expect(ok({ ...coolify, bound_session_id: 's1' })).toBe(false)
  })
  test('an error_capture event without bound_session_id fails parsing', () => {
    const { bound_session_id: _b, ...rest } = err
    expect(ok(rest)).toBe(false)
    expect(ok({ ...err, bound_session_id: '' })).toBe(false)
  })
  test('scheduled_task and feedback also require bound_session_id', () => {
    const { bound_session_id: _a, ...t } = task
    const { bound_session_id: _c, ...f } = fb
    expect(ok(t)).toBe(false)
    expect(ok(f)).toBe(false)
  })
  test('notify_summary capped at 500 chars', () => {
    expect(ok({ ...coolify, notify_summary: 'a'.repeat(500) })).toBe(true)
    expect(ok({ ...coolify, notify_summary: 'a'.repeat(501) })).toBe(false)
  })
})

describe('outcomeToString', () => {
  const cases: Array<[HealOutcome, string]> = [
    [{ kind: 'dispatched_live' }, 'dispatched_live'],
    [{ kind: 'autospawn_launched' }, 'autospawn_launched'],
    [{ kind: 'autospawn_parked' }, 'autospawn_parked'],
    [{ kind: 'no_routable_session', reason: 'no_session', notified: true }, 'no_routable_session'],
    [{ kind: 'deduped' }, 'deduped'],
    [{ kind: 'refused', reason: 'cost_cap' }, 'refused:cost_cap'],
    [{ kind: 'failed', reason: 'spawn_timeout' }, 'failed:spawn_timeout'],
  ]
  for (const [o, s] of cases) {
    test(`${o.kind} -> ${s}`, () => {
      expect(outcomeToString(o)).toBe(s)
    })
  }
})
