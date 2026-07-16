/**
 * fix/ui-session-nav — Play button auto-navigates to the started session.
 *
 * Covers the two halves of the flow:
 *  - the `#/?session=<id>` hash param (parse + strip)
 *  - `waitForRunSessionId`, which bridges start (`run_id` only) → session id.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// A real base URL matters: the default `about:blank` has an empty pathname, so
// the `replaceState(pathname + search + hash)` pattern these helpers use (same
// as the existing writeTabParam) resolves back to `about:blank` and drops the
// hash — an artifact of the blank base, not of the helpers.
GlobalRegistrator.register({ url: 'http://localhost/' })

import { waitForRunSessionId, type RunSessionBinding } from '../src/lib/session-nav'
import { readSessionParam, clearSessionParam, navigateToSession } from '../src/lib/ui/nav'

const noSleep = async () => {}

describe('session hash param', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  test('reads the session id out of the hash', () => {
    expect(readSessionParam('#/?session=abc-123')).toBe('abc-123')
    expect(readSessionParam('#/?tab=grid&session=abc-123')).toBe('abc-123')
    expect(readSessionParam('#/')).toBeNull()
    expect(readSessionParam('#/?tab=grid')).toBeNull()
  })

  test('navigateToSession writes a home hash carrying the id', () => {
    navigateToSession('abc-123')
    expect(readSessionParam(window.location.hash)).toBe('abc-123')
    // Must resolve to the home route, not a sub-page.
    expect(window.location.hash.startsWith('#/?')).toBe(true)
  })

  test('clearSessionParam strips only the session param, preserving others', () => {
    window.location.hash = '#/?tab=grid&session=abc-123'
    clearSessionParam()
    expect(readSessionParam(window.location.hash)).toBeNull()
    expect(window.location.hash).toContain('tab=grid')
  })

  test('clearSessionParam leaves a param-free hash untouched', () => {
    window.location.hash = '#/?tab=grid'
    clearSessionParam()
    expect(window.location.hash).toBe('#/?tab=grid')
  })
})

describe('waitForRunSessionId', () => {
  test('resolves once the run binds a session id', async () => {
    const frames: RunSessionBinding[][] = [
      [{ id: 'run-1', session_id: null }],
      [{ id: 'run-1', session_id: null }],
      [{ id: 'run-1', session_id: 'sess-9' }],
    ]
    let calls = 0
    const got = await waitForRunSessionId(
      async () => frames[calls++] ?? [],
      'run-1',
      { sleep: noSleep },
    )
    expect(got).toBe('sess-9')
    expect(calls).toBe(3)
  })

  test('returns null on timeout — caller must not navigate', async () => {
    let t = 0
    const got = await waitForRunSessionId(
      async () => [{ id: 'run-1', session_id: null }],
      'run-1',
      { sleep: noSleep, timeoutMs: 30_000, now: () => (t += 1000) },
    )
    expect(got).toBeNull()
  })

  test('returns null when the run vanishes from the active list', async () => {
    const got = await waitForRunSessionId(
      async () => [{ id: 'other-run', session_id: 'sess-x' }],
      'run-1',
      { sleep: noSleep },
    )
    expect(got).toBeNull()
  })

  test('an aborted wait resolves null and stops polling', async () => {
    const ctl = new AbortController()
    let calls = 0
    const got = await waitForRunSessionId(
      async () => {
        calls++
        ctl.abort()
        return [{ id: 'run-1', session_id: null }]
      },
      'run-1',
      { sleep: noSleep, signal: ctl.signal },
    )
    expect(got).toBeNull()
    expect(calls).toBe(1)
  })

  test('survives transient fetch failures and still resolves', async () => {
    let calls = 0
    const got = await waitForRunSessionId(
      async () => {
        calls++
        if (calls === 1) throw new Error('network')
        return [{ id: 'run-1', session_id: 'sess-2' }]
      },
      'run-1',
      { sleep: noSleep },
    )
    expect(got).toBe('sess-2')
  })
})
