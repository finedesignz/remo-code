/**
 * PTYCAP-07-07 Task 2 -- error-capture + feedback heal sinks, and the four-source sink map.
 *
 * The error-capture sink delegates to the extracted legacy store, which imports the error-capture
 * DAL / ws registry / notify directly, so those are module-mocked (the same shape as
 * error-capture-dispatch.test.ts). Bun mock.module is process-global: real modules are
 * cache-busted and spread, and afterAll(mock.restore) undoes it.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
const realEcDal = await import(`../src/db/error-capture-dal.ts?bust=${Date.now()}`)

const state = {
  runs: [] as any[],
  dispatchStatus: [] as Array<[string, string, string | undefined]>,
  broadcasts: [] as any[],
  notified: [] as any[],
}
let runSeq = 0

mock.module('../src/db/postgres.ts', () => ({ sql: async () => [] }))
mock.module('../src/db/error-capture-dal.ts', () => ({
  ...realEcDal,
  insertErrorRun: async (errorId: string, projectId: string, sessionId: string) => {
    const run = { id: `erun-${++runSeq}`, error_id: errorId, project_id: projectId, session_id: sessionId, status: 'pending' }
    state.runs.push(run)
    return run
  },
  updateErrorRunStatus: async (runId: string, fields: any) => {
    const run = state.runs.find((r) => r.id === runId)
    if (run) Object.assign(run, fields)
    return run ?? null
  },
  updateErrorDispatchStatus: async (id: string, status: string, reason?: string) => {
    state.dispatchStatus.push([id, status, reason])
  },
}))
mock.module('../src/db/dal.ts', () => ({ ...realDal, insertMessage: async () => ({ id: 'msg-1', created_at: 'T0' }) }))
mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => null,
  broadcastErrorEvent: (_u: string, e: any) => state.broadcasts.push(e),
  broadcastToSubscribers: () => {},
}))
mock.module('../src/error-capture/notify.ts', () => ({
  notifyThrottled: async (...a: any[]) => {
    state.notified.push(a[0])
  },
}))

afterAll(() => {
  mock.restore()
})

const { buildErrorCaptureSink } = await import('../src/heal/sinks/error-capture.ts')
const { buildFeedbackSink } = await import('../src/heal/sinks/feedback.ts')
const { sinkFor } = await import('../src/heal/sinks/index.ts')
const { buildErrorCaptureRunStore } = await import('../src/error-capture/dispatcher.ts')

const REQ = { userId: 'u1', sessionId: 's1', token: 'heal:ev1', prompt: 'PROMPT' }
const PROJECT = {
  id: 'proj-1', user_id: 'u1', name: 'demo', sentry_key: 'k', session_id: 's1',
  dedupe_window_seconds: 60, rate_limit_per_hour: 20, daily_dispatch_cap: 50, enabled: true,
  created_at: 'x', updated_at: 'x',
} as any

const ecEvent = {
  source: 'error_capture', user_id: 'u1', repo_ident: 'github://o/r', prompt: 'PROMPT',
  stored_content: '[error: demo]\n\nPROMPT', metadata_run_id: null, trigger_run_id: null,
  dedupe_key: 'err:e1', bound_session_id: 's1', ctx: { error_id: 'err-1', project_id: 'proj-1' },
} as any
const fbEvent = {
  source: 'feedback', user_id: 'u1', repo_ident: null, prompt: 'PROMPT',
  stored_content: '[feedback]\n\nPROMPT', metadata_run_id: null, trigger_run_id: null,
  dedupe_key: 'fb:f1', bound_session_id: 's1', ctx: { submission_id: 'sub-1' },
} as any

function fakeSend() {
  const out = { inserted: [] as any[], broadcasts: [] as any[], frames: [] as any[] }
  return {
    out,
    deps: {
      getChannel: () => ({ ws: { send: (f: string) => out.frames.push(JSON.parse(f)) } }),
      insertMessage: async (sid: string, role: string, content: string) => {
        out.inserted.push({ sid, role, content })
        return { id: 'msg-1', created_at: 'T0' }
      },
      broadcastToSubscribers: (sid: string, m: any) => out.broadcasts.push({ sid, m }),
    },
  }
}

async function ecSink(send = fakeSend()) {
  const sink = await buildErrorCaptureSink(ecEvent, { eventId: 'ev1' }, {
    load: async () => ({ project: PROJECT, error: { error_type: 'TypeError', error_value: 'boom' } }),
    send: send.deps,
  })
  return { sink, send }
}

beforeEach(() => {
  state.runs.length = 0
  state.dispatchStatus.length = 0
  state.broadcasts.length = 0
  state.notified.length = 0
})

describe('extracted legacy store', () => {
  test('buildErrorCaptureRunStore is exported and opens an in_flight error run', async () => {
    const store = buildErrorCaptureRunStore({
      errorId: 'err-1', project: PROJECT, sessionId: 's1', userId: 'u1', notifyCtx: { error_type: 'T', error_value: 'v' },
    })
    const id = await store.open!(REQ as any)
    expect(id).toBe(state.runs[0].id)
    expect(state.runs[0].status).toBe('in_flight')
  })
})

describe('error-capture sink', () => {
  test('open/markDispatched/onFinalize reproduce the legacy lifecycle', async () => {
    const { sink } = await ecSink()
    const id = await sink.open!(REQ as any)
    await sink.markDispatched!(id!)
    expect(state.dispatchStatus).toEqual([['err-1', 'dispatched', undefined]])
    expect(state.broadcasts[0]).toMatchObject({ type: 'error_dispatched', error_id: 'err-1', project_id: 'proj-1', run_id: id })
    await sink.onFinalize(id!, 'all fixed')
    expect(state.runs[0]).toMatchObject({ status: 'success', output_snippet: 'all fixed' })
    expect(state.broadcasts[1]).toMatchObject({ type: 'error_run_finished', run_id: id, status: 'success' })
  })

  test('markSkipped(session_busy) sends NO legacy notification (routeHeal owns it) and a later finalizeTerminal writes nothing', async () => {
    const { sink } = await ecSink()
    await sink.markSkipped('heal:ev1', 'session_busy')
    await sink.finalizeTerminal({ kind: 'refused', reason: 'session_busy' })
    expect(state.dispatchStatus).toEqual([['err-1', 'skipped', 'session_busy']])
    expect(state.notified).toEqual([]) // QC r1 (codex #4): the unified sink never runs the legacy notifier
    expect(state.broadcasts.filter((b) => b.type === 'error_skipped')).toHaveLength(1)
  })

  test('finalizeTerminal maps no_routable_session and refused to skipped, failed to failed, idempotently', async () => {
    const a = (await ecSink()).sink
    await a.finalizeTerminal({ kind: 'no_routable_session', reason: 'no_live_session', notified: false })
    await a.finalizeTerminal({ kind: 'no_routable_session', reason: 'no_live_session', notified: false })
    expect(state.dispatchStatus).toEqual([['err-1', 'skipped', 'no_live_session']])
    expect(state.broadcasts).toHaveLength(1)
    expect(state.broadcasts[0]).toMatchObject({ type: 'error_skipped', skip_reason: 'no_live_session', dispatch_status: 'skipped' })

    state.dispatchStatus.length = 0
    await (await ecSink()).sink.finalizeTerminal({ kind: 'refused', reason: 'daily_cost_cap' })
    expect(state.dispatchStatus).toEqual([['err-1', 'skipped', 'daily_cost_cap']])

    state.dispatchStatus.length = 0
    await (await ecSink()).sink.finalizeTerminal({ kind: 'failed', reason: 'heal_guard_error' })
    expect(state.dispatchStatus).toEqual([['err-1', 'failed', 'heal_guard_error']])
  })

  test('markFailed (send failure) is not overwritten by the route finalizeTerminal', async () => {
    const { sink } = await ecSink()
    const id = await sink.open!(REQ as any)
    await sink.markFailed(id!, 'socket gone')
    await sink.finalizeTerminal({ kind: 'failed', reason: 'socket gone' })
    expect(state.dispatchStatus).toEqual([['err-1', 'failed', 'agent_send: socket gone']])
  })

  test('markFailed (send failure) sends NO legacy notification either (QC r1 codex #4)', async () => {
    const { sink } = await ecSink()
    const id = await sink.open!(REQ as any)
    await sink.markFailed(id!, 'socket gone')
    expect(state.notified).toEqual([])
  })

  test('the LEGACY store (flag OFF dispatcher, notify default) still sends both throttled notices; notify:false silences both', async () => {
    const args = { errorId: 'err-1', project: PROJECT, sessionId: 's1', userId: 'u1', notifyCtx: { error_type: 'T', error_value: 'v' } }
    const legacy = buildErrorCaptureRunStore(args)
    await legacy.markSkipped('t', 'session_busy')
    await legacy.markFailed('erun-x', 'boom')
    expect(state.notified).toEqual(['dispatch_failed', 'dispatch_failed'])
    state.notified.length = 0
    const quiet = buildErrorCaptureRunStore({ ...args, notify: false })
    await quiet.markSkipped('t', 'session_busy')
    await quiet.markFailed('erun-x', 'boom')
    expect(state.notified).toEqual([])
  })

  test('onParkExpire writes skipped target_offline_expired exactly as the legacy hook', async () => {
    const { sink } = await ecSink()
    await sink.onParkExpire(REQ as any)
    expect(state.dispatchStatus).toEqual([['err-1', 'skipped', 'target_offline_expired']])
  })

  test('send persists the stored content and writes the frame without a broadcast', async () => {
    const { sink, send } = await ecSink()
    await sink.send(REQ as any)
    expect(send.out.inserted[0].content).toBe('[error: demo]\n\nPROMPT')
    expect(send.out.broadcasts).toEqual([])
    expect(send.out.frames).toEqual([{ type: 'user_message', id: 'msg-1', content: 'PROMPT', ts: 'T0' }])
  })

  test('a project owned by another user is refused by the default loader contract', async () => {
    await expect(
      buildErrorCaptureSink(ecEvent, { eventId: 'ev1' }, {
        load: async () => ({ project: { ...PROJECT, user_id: 'someone-else' }, error: { error_type: 't', error_value: 'v' } }),
      }),
    ).rejects.toThrow('error_project_owner_mismatch')
  })
})

describe('feedback sink', () => {
  test('keeps no run table: callbacks are no-ops, send carries the images', async () => {
    const send = fakeSend()
    const sink = buildFeedbackSink(fbEvent, { eventId: 'ev1' }, { send: send.deps })
    expect(await sink.open!(REQ as any)).toBe('heal:ev1')
    await sink.markSkipped('heal:ev1', 'x')
    await sink.markFailed('heal:ev1', 'x')
    await sink.finalizeTerminal({ kind: 'failed', reason: 'x' })
    await sink.send({ ...REQ, images: [{ media_type: 'image/png', data: 'AA' }] } as any)
    expect(send.out.frames[0].images).toEqual([{ media_type: 'image/png', data: 'AA' }])
    expect(send.out.inserted[0].content).toBe('[feedback]\n\nPROMPT')
    expect(state.dispatchStatus).toEqual([])
  })
})

describe('sinkFor covers all four sources', () => {
  test('each source returns an object implementing every HealSink method', async () => {
    const coolify = {
      source: 'coolify_deploy', user_id: 'u1', repo_ident: null, prompt: 'p', stored_content: 'p',
      metadata_run_id: 'm1', trigger_run_id: 'm1', dedupe_key: 'coolify:a:b',
      ctx: { application_uuid: 'a', deployment_uuid: 'b', log_snippet: '' },
    } as any
    const task = { ...fbEvent, source: 'scheduled_task', dedupe_key: 'task:t:s', ctx: { task_id: 't', task_name: 'n', error_signature: 's' } }
    const methods = ['open', 'markSkipped', 'markDispatched', 'onFinalize', 'markFailed', 'send', 'finalizeTerminal', 'onParkExpire']
    const deps = {
      coolify: { ensureInternalTriageTask: async () => 't', insertRun: async () => ({ id: 'c' }), trackRun() {}, finalizeRun: async () => {}, removeRunContext() {}, now: () => 0 },
      errorCapture: { load: async () => ({ project: PROJECT, error: { error_type: 't', error_value: 'v' } }) },
      ledger: {},
    }
    for (const ev of [coolify, task, ecEvent, fbEvent]) {
      const sink: any = await sinkFor(ev, { eventId: 'ev1' }, deps)
      for (const m of methods) {
        // markDispatched is optional on RunStore; the heal sinks that surface it must be callable
        if (m === 'markDispatched' && ev.source !== 'error_capture') continue
        expect(typeof sink[m]).toBe('function')
      }
    }
  })
})
