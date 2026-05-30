/**
 * P1 — unit tests for the supervisor OAuth usage parser
 * (supervisor/src/usage/oauth-poll.ts).
 *
 * Covers: window parsing incl. optional Opus / oauth-apps, missing-Opus
 * pass-through, malformed windows, expired/missing token handling, and a
 * full pollUsage() round-trip with an injected fetch. The OAuth token is
 * never returned by any of these functions — only parsed windows.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseWindow,
  parseUsageResponse,
  readAccessToken,
  pollUsage,
  OAUTH_USAGE_URL,
  OAUTH_USAGE_HEADERS,
} from '../src/usage/oauth-poll'

function tmpCredFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'remo-oauth-test-'))
  const path = join(dir, '.credentials.json')
  writeFileSync(path, contents, 'utf-8')
  return path
}

describe('parseWindow', () => {
  test('parses a valid window', () => {
    expect(parseWindow({ utilization: 42.5, resets_at: '2026-05-30T12:00:00Z' })).toEqual({
      utilization: 42.5,
      resets_at: '2026-05-30T12:00:00Z',
    })
  })
  test('returns null for missing / malformed input', () => {
    expect(parseWindow(null)).toBeNull()
    expect(parseWindow(undefined)).toBeNull()
    expect(parseWindow({})).toBeNull()
    expect(parseWindow({ utilization: 'x', resets_at: 'a' })).toBeNull()
    expect(parseWindow({ utilization: 50 })).toBeNull() // no resets_at
    expect(parseWindow({ resets_at: 'a' })).toBeNull() // no utilization
    expect(parseWindow({ utilization: NaN, resets_at: 'a' })).toBeNull()
  })
})

describe('parseUsageResponse', () => {
  const five = { utilization: 10, resets_at: '2026-05-30T05:00:00Z' }
  const seven = { utilization: 20, resets_at: '2026-06-05T00:00:00Z' }
  const opus = { utilization: 30, resets_at: '2026-06-05T00:00:00Z' }
  const oauthApps = { utilization: 40, resets_at: '2026-06-05T00:00:00Z' }

  test('parses all four windows when present', () => {
    const out = parseUsageResponse({
      five_hour: five,
      seven_day: seven,
      seven_day_opus: opus,
      seven_day_oauth_apps: oauthApps,
    })
    expect(out).toEqual({
      five_hour: five,
      seven_day: seven,
      seven_day_opus: opus,
      seven_day_oauth_apps: oauthApps,
    })
  })

  test('omits Opus + oauth-apps when absent (Pro / non-Max accounts)', () => {
    const out = parseUsageResponse({ five_hour: five, seven_day: seven })
    expect(out).toEqual({ five_hour: five, seven_day: seven })
    expect(out!.seven_day_opus).toBeUndefined()
    expect(out!.seven_day_oauth_apps).toBeUndefined()
  })

  test('includes only the optional windows that are present', () => {
    const out = parseUsageResponse({ five_hour: five, seven_day: seven, seven_day_opus: opus })
    expect(out!.seven_day_opus).toEqual(opus)
    expect(out!.seven_day_oauth_apps).toBeUndefined()
  })

  test('drops malformed optional windows', () => {
    const out = parseUsageResponse({
      five_hour: five,
      seven_day: seven,
      seven_day_opus: { utilization: 'bad' },
    })
    expect(out!.seven_day_opus).toBeUndefined()
  })

  test('returns null when five_hour is missing', () => {
    expect(parseUsageResponse({ seven_day: seven })).toBeNull()
    expect(parseUsageResponse({})).toBeNull()
    expect(parseUsageResponse(null)).toBeNull()
  })

  test('falls back seven_day to five_hour reset when seven_day absent', () => {
    const out = parseUsageResponse({ five_hour: five })
    expect(out!.seven_day).toEqual({ utilization: 0, resets_at: five.resets_at })
  })
})

describe('readAccessToken', () => {
  test('reads a valid, unexpired token', () => {
    const path = tmpCredFile(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc', expiresAt: 9_999_999_999_999 } }),
    )
    try {
      const r = readAccessToken(1_000, path)
      expect(r).toEqual({ token: 'tok-abc' })
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('flags an expired token (expiresAt in ms < now)', () => {
    const path = tmpCredFile(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc', expiresAt: 1_000 } }),
    )
    try {
      const r = readAccessToken(2_000, path)
      expect(r.token).toBeNull()
      expect((r as any).reason).toBe('token_expired_run_claude_setup_token')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('accepts a token with no expiresAt field', () => {
    const path = tmpCredFile(JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } }))
    try {
      expect(readAccessToken(2_000, path)).toEqual({ token: 'tok-abc' })
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('missing file → reason credentials_file_not_found', () => {
    const r = readAccessToken(1_000, join(tmpdir(), 'definitely-absent-remo-creds.json'))
    expect(r.token).toBeNull()
    expect((r as any).reason).toBe('credentials_file_not_found')
  })

  test('malformed JSON → parse error reason', () => {
    const path = tmpCredFile('{not json')
    try {
      const r = readAccessToken(1_000, path)
      expect(r.token).toBeNull()
      expect((r as any).reason).toContain('credentials_parse_error')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('no access token in file → reason no_access_token', () => {
    const path = tmpCredFile(JSON.stringify({ claudeAiOauth: {} }))
    try {
      const r = readAccessToken(1_000, path)
      expect(r.token).toBeNull()
      expect((r as any).reason).toBe('no_access_token')
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('pollUsage', () => {
  const validCred = JSON.stringify({
    claudeAiOauth: { accessToken: 'tok-secret', expiresAt: 9_999_999_999_999 },
  })

  test('sends correct endpoint + headers and never leaks the token in the result', async () => {
    const path = tmpCredFile(validCred)
    let seenUrl = ''
    let seenHeaders: any = {}
    const fakeFetch = (async (url: any, init: any) => {
      seenUrl = String(url)
      seenHeaders = init.headers
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 11, resets_at: '2026-05-30T05:00:00Z' },
          seven_day: { utilization: 22, resets_at: '2026-06-05T00:00:00Z' },
          seven_day_opus: { utilization: 33, resets_at: '2026-06-05T00:00:00Z' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const r = await pollUsage({ fetchImpl: fakeFetch, credentialsPathOverride: path })
      expect(r.ok).toBe(true)
      expect(seenUrl).toBe(OAUTH_USAGE_URL)
      expect(seenHeaders['anthropic-beta']).toBe(OAUTH_USAGE_HEADERS['anthropic-beta'])
      expect(seenHeaders['User-Agent']).toBe(OAUTH_USAGE_HEADERS['User-Agent'])
      expect(seenHeaders.Authorization).toBe('Bearer tok-secret')
      if (r.ok) {
        expect(r.usage.five_hour.utilization).toBe(11)
        expect(r.usage.seven_day_opus).toEqual({ utilization: 33, resets_at: '2026-06-05T00:00:00Z' })
        // token must not appear anywhere in the serialized result
        expect(JSON.stringify(r.usage)).not.toContain('tok-secret')
      }
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('returns ok:false without calling fetch when token expired', async () => {
    const path = tmpCredFile(
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 1 } }),
    )
    let called = false
    const fakeFetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const r = await pollUsage({ now: 2, fetchImpl: fakeFetch, credentialsPathOverride: path })
      expect(r.ok).toBe(false)
      expect(called).toBe(false)
      if (!r.ok) expect(r.reason).toBe('token_expired_run_claude_setup_token')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('maps 401 to an unauthorized reason', async () => {
    const path = tmpCredFile(validCred)
    const fakeFetch = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    try {
      const r = await pollUsage({ fetchImpl: fakeFetch, credentialsPathOverride: path })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('unauthorized_401_token_invalid')
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('maps a network throw to network_error', async () => {
    const path = tmpCredFile(validCred)
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    try {
      const r = await pollUsage({ fetchImpl: fakeFetch, credentialsPathOverride: path })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('network_error')
    } finally {
      rmSync(path, { force: true })
    }
  })
})
