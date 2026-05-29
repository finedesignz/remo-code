/**
 * B3 observability: error-reporter unit tests.
 *
 *   1. throttle drops the 6th send in a rolling minute
 *   2. envelope payload shape matches the hub intake parser's expectations
 *      (envelope header + item header + event payload with exception.values[0])
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test'

// Stub Vite env BEFORE importing the module so PROJECT_ID resolves truthy.
;(globalThis as any).import_meta_env = { VITE_WEB_ERROR_PROJECT_ID: 'test-project-id', VITE_HUB_URL: 'http://hub.test' }

// Bun test runs `import.meta.env` natively — set on the import.meta object.
// The reporter reads at module-load via `import.meta.env.VITE_*` which Vite
// inlines at build time; in tests `import.meta.env` is the live object.
const env = (import.meta as any).env ?? ((import.meta as any).env = {})
env.VITE_WEB_ERROR_PROJECT_ID = 'test-project-id'
env.VITE_HUB_URL = 'http://hub.test'
env.VITE_RELEASE = 'web@test'

import { reportError, _internal } from './error-reporter'

describe('error-reporter throttle', () => {
  beforeEach(() => {
    _internal.resetThrottle()
    // Replace fetch with a counter.
    ;(globalThis as any).fetch = mock(async () => new Response(null, { status: 202 }))
  })

  it('allows up to 5 sends in a rolling minute', async () => {
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      results.push(await reportError({ message: `e${i}` }))
    }
    expect(results.every(Boolean)).toBe(true)
    expect((globalThis as any).fetch.mock.calls.length).toBe(5)
  })

  it('silently drops the 6th send (returns false, no fetch)', async () => {
    for (let i = 0; i < 5; i++) await reportError({ message: `e${i}` })
    const dropped = await reportError({ message: 'sixth' })
    expect(dropped).toBe(false)
    expect((globalThis as any).fetch.mock.calls.length).toBe(5)
  })
})

describe('error-reporter envelope shape', () => {
  it('builds a 3-line envelope: header / item-header / event', () => {
    const envStr = _internal.buildEnvelope({
      message: 'TypeError: x is not a function',
      stack: 'Error: x is not a function\n    at foo (https://app.test/main.js:10:5)',
      url: 'https://app.test/#/home',
      ua: 'test-ua',
      release: 'web@1.0.0',
    })
    const lines = envStr.split('\n').filter(l => l.length > 0)
    expect(lines.length).toBe(3)
    const envHeader = JSON.parse(lines[0])
    const itemHeader = JSON.parse(lines[1])
    const event = JSON.parse(lines[2])
    expect(typeof envHeader.event_id).toBe('string')
    expect(itemHeader.type).toBe('event')
    expect(event.platform).toBe('javascript')
    expect(event.release).toBe('web@1.0.0')
    expect(event.exception.values[0].type).toBe('TypeError')
    expect(event.exception.values[0].value).toBe('TypeError: x is not a function')
    expect(Array.isArray(event.exception.values[0].stacktrace.frames)).toBe(true)
  })

  it('parses V8 stack frames into top-first then reverses for Sentry layout', () => {
    const frames = _internal.parseStackFrames(
      'Error: boom\n    at top (https://a.test/x.js:1:2)\n    at bottom (https://a.test/y.js:3:4)',
    )
    // parseStackFrames returns top-first; we expect both frames.
    expect(frames.length).toBe(2)
    expect(frames[0].function).toBe('top')
    expect(frames[1].function).toBe('bottom')
  })
})
