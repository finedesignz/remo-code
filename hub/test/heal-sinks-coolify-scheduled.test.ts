/**
 * PTYCAP-07-07 Task 1 -- shared send helper, coolify sink, scheduled-task sink, sink map.
 * DB-free: every collaborator is injected (no module mocking), so nothing here is process-global.
 */
import { describe, test, expect } from 'bun:test'
import { sendUserMessage } from '../src/heal/sinks/shared.ts'
import { buildCoolifySink } from '../src/heal/sinks/coolify.ts'
import { buildScheduledTaskSink } from '../src/heal/sinks/scheduled-task.ts'
import { sinkFor } from '../src/heal/sinks/index.ts'
import type { HealEvent } from '../src/heal/types.ts'
import type { DispatchRequest } from '../src/dispatch/pipeline.ts'

const REQ: DispatchRequest = { userId: 'u1', sessionId: 's1', token: 'heal:ev1', prompt: 'PROMPT' }

const TRIAGE_JSON = JSON.stringify({
  error_type: 'BuildError',
  severity: 'low',
  root_cause: 'missing dep',
  suggested_fix: 'add it',
  confidence: 0.5,
})

const coolifyEvent = {
  source: 'coolify_deploy',
  user_id: 'u1',
  repo_ident: 'github://o/r',
  prompt: 'PROMPT',
  stored_content: '[triage: deploy]\n\nPROMPT',
  metadata_run_id: 'meta-1',
  trigger_run_id: 'meta-1',
  dedupe_key: 'coolify:app:dep',
  ctx: { application_uuid: 'app', deployment_uuid: 'dep', log_snippet: 'x' },
} as unknown as HealEvent

const taskEvent = {
  source: 'scheduled_task',
  user_id: 'u1',
  repo_ident: 'github://o/r',
  prompt: 'PROMPT',
  stored_content: '[task failed]\n\nPROMPT',
  metadata_run_id: null,
  trigger_run_id: 'run-9',
  dedupe_key: 'task:t1:sig',
  bound_session_id: 's1',
  ctx: { task_id: 't1', task_name: 'nightly', error_signature: 'sig' },
} as unknown as HealEvent

function fakeSend(online = true) {
  const out = { inserted: [] as any[], broadcasts: [] as any[], frames: [] as any[] }
  return {
    out,
    deps: {
      getChannel: () => (online ? { ws: { send: (f: string) => out.frames.push(JSON.parse(f)) } } : null),
      insertMessage: async (sid: string, role: string, content: string) => {
        out.inserted.push({ sid, role, content })
        return { id: 'msg-1', created_at: 'T0' }
      },
      broadcastToSubscribers: (sid: string, m: any) => out.broadcasts.push({ sid, m }),
    },
  }
}

function fakeCoolify() {
  const calls = {
    inserted: [] as any[],
    tracked: [] as any[],
    started: [] as any[],
    finalized: [] as any[],
    removed: [] as string[],
  }
  const send = fakeSend()
  const deps = {
    ensureInternalTriageTask: async () => 'task-int',
    insertRun: async (i: any) => {
      calls.inserted.push(i)
      return { id: 'child-1' }
    },
    trackRun: (c: any) => calls.tracked.push(c),
    broadcastRunStarted: (u: string, p: any) => calls.started.push({ u, p }),
    finalizeRun: async (id: string, status: string, error: any, fields: any) => {
      calls.finalized.push({ id, status, error, fields })
    },
    removeRunContext: (id: string) => calls.removed.push(id),
    send: send.deps,
    now: () => 1_000,
  }
  return { calls, deps, send }
}

describe('sendUserMessage', () => {
  test('persists, optionally broadcasts, and writes the frame with images and run_id only when supplied', async () => {
    const s = fakeSend()
    await sendUserMessage(REQ, { storedContent: 'STORED', broadcast: true, runId: 'r1', images: [{ media_type: 'image/png', data: 'AA' }] }, s.deps)
    expect(s.out.inserted).toEqual([{ sid: 's1', role: 'user', content: 'STORED' }])
    expect(s.out.broadcasts).toEqual([
      { sid: 's1', m: { type: 'message', session_id: 's1', message: { id: 'msg-1', created_at: 'T0' }, run_id: 'r1' } },
    ])
    expect(s.out.frames).toEqual([
      { type: 'user_message', id: 'msg-1', content: 'PROMPT', ts: 'T0', run_id: 'r1', images: [{ media_type: 'image/png', data: 'AA' }] },
    ])

    const plain = fakeSend()
    await sendUserMessage(REQ, { storedContent: 'STORED' }, plain.deps)
    expect(plain.out.broadcasts).toEqual([])
    expect(plain.out.frames).toEqual([{ type: 'user_message', id: 'msg-1', content: 'PROMPT', ts: 'T0' }])
  })

  test('throws session_offline (or the supplied code) when the channel is gone and persists nothing', async () => {
    const s = fakeSend(false)
    await expect(sendUserMessage(REQ, { storedContent: 'S' }, s.deps)).rejects.toThrow('session_offline')
    await expect(sendUserMessage(REQ, { storedContent: 'S', offlineError: 'agent_socket_missing' }, s.deps)).rejects.toThrow(
      'agent_socket_missing',
    )
    expect(s.out.inserted).toEqual([])
  })
})

describe('coolify sink', () => {
  test('open inserts a child run under the internal triage task with triggered_by_run_id = the metadata run', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    const id = await sink.open!(REQ)
    expect(id).toBe('child-1')
    expect(f.calls.inserted).toHaveLength(1)
    expect(f.calls.inserted[0]).toMatchObject({
      task_id: 'task-int',
      user_id: 'u1',
      status: 'pending',
      target_kind: 'session',
      target_id: null,
      triggered_by_run_id: 'meta-1',
    })
    // same run context the legacy fireTask registered
    expect(f.calls.tracked[0]).toMatchObject({
      runId: 'child-1',
      taskId: 'task-int',
      userId: 'u1',
      target: { kind: 'session', sessionId: null, online: true },
      chainDepth: 0,
      triggeredByRunId: 'meta-1',
    })
    expect(f.calls.started).toHaveLength(1)
  })

  test('onFinalize parses the triage result, finalizes the child and mirrors success onto the metadata run', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.open!(REQ)
    await sink.onFinalize('child-1', TRIAGE_JSON)
    expect(f.calls.finalized).toHaveLength(2)
    expect(f.calls.finalized[0]).toMatchObject({ id: 'child-1', status: 'success', error: null })
    expect(f.calls.finalized[0].fields.only_if_active).toBe(true)
    expect(JSON.parse(f.calls.finalized[0].fields.output_snippet).error_type).toBe('BuildError')
    expect(f.calls.finalized[1]).toMatchObject({ id: 'meta-1', status: 'success' })
    expect(f.calls.finalized[1].fields.only_if_active).toBe(true)
    expect(f.calls.removed).toContain('child-1')
  })

  test('onFinalize with unparseable output fails the pair with triage_parse_error and a 4000 char snippet', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.open!(REQ)
    await sink.onFinalize('child-1', 'x'.repeat(5000))
    expect(f.calls.finalized[0]).toMatchObject({ id: 'child-1', status: 'failed', error: 'triage_parse_error' })
    expect(f.calls.finalized[0].fields.output_snippet).toHaveLength(4000)
    expect(f.calls.finalized[1]).toMatchObject({ id: 'meta-1', status: 'failed', error: 'triage_parse_error' })
  })

  test('markSkipped before open finalizes only the metadata run; quota reason maps to skipped_quota', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.markSkipped('heal:ev1', 'quota_threshold_reached: 5h')
    expect(f.calls.finalized).toHaveLength(1)
    expect(f.calls.finalized[0]).toMatchObject({ id: 'meta-1', status: 'skipped_quota', error: 'quota_threshold_reached: 5h' })
    const g = fakeCoolify()
    const s2 = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, g.deps)
    await s2.markSkipped('heal:ev1', 'daily_cost_cap')
    expect(g.calls.finalized[0]).toMatchObject({ status: 'skipped', error: 'daily_cost_cap' })
  })

  test('markFailed prefixes agent_send_failed on both rows', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.open!(REQ)
    await sink.markFailed('child-1', 'boom')
    expect(f.calls.finalized.map((c: any) => [c.id, c.status, c.error])).toEqual([
      ['child-1', 'failed', 'agent_send_failed: boom'],
      ['meta-1', 'failed', 'agent_send_failed: boom'],
    ])
  })

  test('finalizeTerminal: no_routable_session text exactly, failed for failed, and a second call writes nothing', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.finalizeTerminal({ kind: 'no_routable_session', reason: 'whatever', notified: false })
    await sink.finalizeTerminal({ kind: 'no_routable_session', reason: 'whatever', notified: false })
    expect(f.calls.finalized).toHaveLength(1)
    expect(f.calls.finalized[0]).toMatchObject({ id: 'meta-1', status: 'skipped', error: 'no_routable_session' })
    expect(f.calls.finalized[0].fields.only_if_active).toBe(true)

    const g = fakeCoolify()
    const s2 = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, g.deps)
    await s2.finalizeTerminal({ kind: 'failed', reason: 'heal_guard_error' })
    expect(g.calls.finalized[0]).toMatchObject({ status: 'failed', error: 'heal_guard_error' })
    const h = fakeCoolify()
    await buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, h.deps).finalizeTerminal({ kind: 'refused', reason: 'session_busy' })
    expect(h.calls.finalized[0]).toMatchObject({ status: 'skipped', error: 'session_busy' })
  })

  test('a gate-time markSkipped then the route finalizeTerminal performs exactly one metadata write', async () => {
    const f = fakeCoolify()
    const sink = buildCoolifySink(coolifyEvent, { eventId: 'ev1' }, f.deps)
    await sink.markSkipped('heal:ev1', 'automation_kill_switch')
    await sink.finalizeTerminal({ kind: 'refused', reason: 'automation_kill_switch' })
    expect(f.calls.finalized).toHaveLength(1)
  })

  test('a null metadata run never reaches finalizeRun; send carries the run id and broadcasts', async () => {
    const f = fakeCoolify()
    const ev = { ...coolifyEvent, metadata_run_id: null } as unknown as HealEvent
    const sink = buildCoolifySink(ev, { eventId: 'ev1' }, f.deps)
    await sink.finalizeTerminal({ kind: 'deduped' })
    expect(f.calls.finalized).toEqual([])
    await sink.open!(REQ)
    await sink.send(REQ)
    expect(f.send.out.inserted[0].content).toBe('[triage: deploy]\n\nPROMPT')
    expect(f.send.out.frames[0].run_id).toBe('child-1')
    expect(f.send.out.broadcasts).toHaveLength(1)
  })
})

describe('scheduled-task sink', () => {
  test('performs zero run-row writes: open returns the heal token and every callback only records detail', async () => {
    const details: Array<[string | null, string]> = []
    const s = fakeSend()
    const sink = buildScheduledTaskSink(taskEvent, { eventId: 'ev1' }, {
      send: s.deps,
      recordDetail: (id, d) => void details.push([id, d]),
    })
    expect(await sink.open!(REQ)).toBe('heal:ev1')
    await sink.markSkipped('heal:ev1', 'daily_cost_cap')
    await sink.onFinalize('heal:ev1', 'done')
    await sink.markFailed('heal:ev1', 'boom')
    await sink.finalizeTerminal({ kind: 'failed', reason: 'x' })
    await sink.onParkExpire(REQ)
    expect(details.map((d) => d[1])).toEqual(['skipped:daily_cost_cap', 'finalized', 'failed:boom', 'park_expired'])
    await sink.send(REQ)
    expect(s.out.inserted[0].content).toBe('[task failed]\n\nPROMPT')
    expect(s.out.broadcasts).toEqual([])
  })
})

describe('sinkFor', () => {
  test('selects the coolify and scheduled-task sinks and throws for an unknown source', async () => {
    const f = fakeCoolify()
    const c = await sinkFor(coolifyEvent, { eventId: 'ev1' }, { coolify: f.deps })
    expect(await c.open!(REQ)).toBe('child-1')
    const t = await sinkFor(taskEvent, { eventId: 'ev1' }, { ledger: {} })
    expect(await t.open!(REQ)).toBe('heal:ev1')
    await expect(sinkFor({ ...taskEvent, source: 'nope' } as unknown as HealEvent, { eventId: null })).rejects.toThrow(
      'unknown_heal_source',
    )
  })
})
