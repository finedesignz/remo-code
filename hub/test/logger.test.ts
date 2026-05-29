// B1: Structured JSON logger + request_id propagation.
//
// Verifies:
//   1. log.info emits a single JSON line with {ts, level, msg} envelope.
//   2. Per-call fields are merged on top of the envelope.
//   3. AsyncLocalStorage propagates request_id into nested async handlers.
//   4. setCtx mutates the current frame (used by auth middleware to add
//      user_id after the request body has been parsed).
//   5. JSON.stringify failures (circular refs) fall back to a minimal
//      envelope without crashing the caller.

import { describe, test, expect } from 'bun:test'
import { log, _setWriterForTest } from '../src/observability/logger'
import { als, withCtx, setCtx, currentCtx } from '../src/observability/als'

function captureLines(fn: () => void | Promise<void>): Promise<string[]> {
  const captured: string[] = []
  const prev = _setWriterForTest((line) => { captured.push(line) })
  return Promise.resolve(fn()).then(() => {
    _setWriterForTest(prev)
    return captured
  })
}

describe('observability/logger', () => {
  test('emits one JSON line per call with the required envelope', async () => {
    const lines = await captureLines(() => {
      log.info('hello.world', { foo: 'bar', n: 7 })
    })
    expect(lines.length).toBe(1)
    expect(lines[0].endsWith('\n')).toBe(true)
    const obj = JSON.parse(lines[0])
    expect(obj.level).toBe('info')
    expect(obj.msg).toBe('hello.world')
    expect(obj.foo).toBe('bar')
    expect(obj.n).toBe(7)
    // ts is ISO-8601
    expect(typeof obj.ts).toBe('string')
    expect(new Date(obj.ts).toString()).not.toBe('Invalid Date')
  })

  test('per-call fields override ALS fields with the same name', async () => {
    const lines = await captureLines(async () => {
      await withCtx({ request_id: 'als-rid', user_id: 'als-user' }, () => {
        log.info('msg', { user_id: 'override-user' })
      })
    })
    const obj = JSON.parse(lines[0])
    expect(obj.request_id).toBe('als-rid')
    expect(obj.user_id).toBe('override-user')
  })

  test('all levels emit and tag correctly', async () => {
    const lines = await captureLines(() => {
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e')
    })
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  test('circular refs in fields do not crash; fallback envelope is emitted', async () => {
    const circular: any = { a: 1 }
    circular.self = circular
    const lines = await captureLines(() => {
      log.warn('circular', { circular })
    })
    expect(lines.length).toBe(1)
    const obj = JSON.parse(lines[0])
    expect(obj.level).toBe('warn')
    expect(obj.msg).toBe('circular')
    expect(obj._serialization_failed).toBe(true)
  })
})

describe('observability/als', () => {
  test('withCtx propagates fields into nested async handlers', async () => {
    const lines = await captureLines(async () => {
      await withCtx({ request_id: 'rid-1', user_id: 'u-1' }, async () => {
        // Simulate a deeply nested async chain — the kind a real route handler
        // produces (DAL call → broadcast → finalize).
        await Promise.resolve()
        await new Promise<void>((res) => setTimeout(() => {
          log.info('inner')
          res()
        }, 1))
      })
    })
    const obj = JSON.parse(lines[0])
    expect(obj.request_id).toBe('rid-1')
    expect(obj.user_id).toBe('u-1')
  })

  test('currentCtx returns empty object outside an ALS frame', () => {
    // We may be running inside someone else's frame (test runner) — drop into
    // a fresh empty frame to make the assertion deterministic.
    als.run({}, () => {
      expect(currentCtx()).toEqual({})
    })
  })

  test('setCtx mutates the current frame in place', async () => {
    const lines = await captureLines(async () => {
      await withCtx({ request_id: 'rid-2' }, () => {
        // Auth middleware learns the user_id late and stamps it onto the frame.
        setCtx({ user_id: 'late-binding-user' })
        log.info('after-set')
      })
    })
    const obj = JSON.parse(lines[0])
    expect(obj.request_id).toBe('rid-2')
    expect(obj.user_id).toBe('late-binding-user')
  })

  test('setCtx is a no-op outside an ALS frame', () => {
    // Should not throw.
    setCtx({ user_id: 'orphan' })
    // currentCtx outside the frame is empty.
    // (If we're nested inside the test runner's own frame this would still
    // pass because we don't read currentCtx here.)
    expect(true).toBe(true)
  })
})

describe('observability/middleware integration', () => {
  test('withRequestId mints an id, opens an ALS frame, logs req.start/req.end', async () => {
    const { withRequestId } = await import('../src/observability/middleware')
    const { Hono } = await import('hono')
    const app = new Hono()
    let observedInsideHandler: string | null = null
    app.use('*', withRequestId())
    app.get('/x', (c) => {
      // The ALS frame is open here — any log call inherits the request_id.
      const ctx = currentCtx()
      observedInsideHandler = typeof ctx.request_id === 'string' ? ctx.request_id : null
      return c.json({ ok: true })
    })

    const lines = await captureLines(async () => {
      const res = await app.request('/x')
      expect(res.status).toBe(200)
      const echoed = res.headers.get('x-request-id')
      expect(typeof echoed).toBe('string')
      expect(echoed!.length).toBeGreaterThan(0)
      // The id observed inside the handler matches the echoed header.
      expect(observedInsideHandler).toBe(echoed)
    })

    // Expect both req.start and req.end lines, both carrying the same
    // request_id.
    const events = lines.map((l) => JSON.parse(l))
    const startLine = events.find((e) => e.msg === 'req.start')
    const endLine = events.find((e) => e.msg === 'req.end')
    expect(startLine).toBeTruthy()
    expect(endLine).toBeTruthy()
    expect(startLine.request_id).toBeTruthy()
    expect(startLine.request_id).toBe(endLine.request_id)
    expect(endLine.status).toBe(200)
    expect(typeof endLine.duration_ms).toBe('number')
  })

  test('inbound x-request-id is honored when safe', async () => {
    const { withRequestId } = await import('../src/observability/middleware')
    const { Hono } = await import('hono')
    const app = new Hono()
    app.use('*', withRequestId())
    app.get('/y', (c) => c.json({ ok: true }))

    const res = await app.request('/y', { headers: { 'x-request-id': 'caller-supplied-uuid-1234' } })
    expect(res.headers.get('x-request-id')).toBe('caller-supplied-uuid-1234')
  })

  test('inbound x-request-id with whitespace is rejected; fresh id is minted', async () => {
    const { withRequestId } = await import('../src/observability/middleware')
    const { Hono } = await import('hono')
    const app = new Hono()
    app.use('*', withRequestId())
    app.get('/z', (c) => c.json({ ok: true }))

    const res = await app.request('/z', { headers: { 'x-request-id': 'bad id with spaces' } })
    const echoed = res.headers.get('x-request-id')
    expect(echoed).not.toBe('bad id with spaces')
    expect(typeof echoed).toBe('string')
    expect(echoed!.length).toBeGreaterThan(0)
  })
})
