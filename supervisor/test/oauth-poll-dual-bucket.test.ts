/**
 * Phase 18 (R-PTY-17) — the dual-bucket poll.
 *
 * Asserts the supervisor poll surfaces the SECOND bucket (the Agent-SDK
 * programmatic dollar credit) alongside the four subscription windows, that the
 * bucket is a dollar shape (not a util% window), and — CRITICALLY (T-18-01) —
 * that the OAuth access token NEVER appears on the returned payload or its JSON.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseProgrammaticCredit,
  parseUsageResponse,
  pollUsage,
} from '../src/usage/oauth-poll'

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-must-never-leak-1234567890'

function tmpCredFile(token: string = FAKE_TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), 'remo-oauth-dual-'))
  const path = join(dir, '.credentials.json')
  writeFileSync(
    path,
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3_600_000 } }),
    'utf-8',
  )
  return path
}

function loadFixture(name: string): any {
  return JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'),
  )
}

describe('parseProgrammaticCredit', () => {
  test('parses the post-claim dollar bucket', () => {
    const body = loadFixture('oauth-usage-with-credit.json')
    expect(parseProgrammaticCredit(body)).toEqual({
      used_usd: 12.34,
      limit_usd: 100.0,
      resets_at: '2026-07-01T00:00:00Z',
      claimed: true,
    })
  })

  test('accepts sibling key names (agent_sdk_credit / credit_pool)', () => {
    expect(parseProgrammaticCredit({ agent_sdk_credit: { used_usd: 5, limit_usd: 20, resets_at: 'x' } }))
      .toEqual({ used_usd: 5, limit_usd: 20, resets_at: 'x', claimed: true })
    expect(parseProgrammaticCredit({ credit_pool: { used: 1, limit: 200, resets_at: 'y', claimed: false } }))
      .toEqual({ used_usd: 1, limit_usd: 200, resets_at: 'y', claimed: false })
  })

  test('NEVER fabricates a number — unrecognised / missing bodies => null', () => {
    expect(parseProgrammaticCredit(null)).toBeNull()
    expect(parseProgrammaticCredit({})).toBeNull()
    expect(parseProgrammaticCredit({ programmatic_credit: {} })).toBeNull() // no finite numbers
    expect(parseProgrammaticCredit({ programmatic_credit: { used_usd: 'x', limit_usd: 1 } })).toBeNull()
    expect(parseProgrammaticCredit({ programmatic_credit: { limit_usd: 100 } })).toBeNull() // no used
  })
})

describe('parseUsageResponse with credit', () => {
  test('with-credit fixture => four windows + programmatic bucket', () => {
    const out = parseUsageResponse(loadFixture('oauth-usage-with-credit.json'))
    expect(out).not.toBeNull()
    expect(out!.five_hour.utilization).toBe(12.5)
    expect(out!.programmatic_credit).toEqual({
      used_usd: 12.34,
      limit_usd: 100.0,
      resets_at: '2026-07-01T00:00:00Z',
      claimed: true,
    })
  })
})

describe('pollUsage dual-bucket round-trip', () => {
  test('returns both buckets and NEVER leaks the token', async () => {
    const credPath = tmpCredFile()
    const fixture = loadFixture('oauth-usage-with-credit.json')
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch

    const res = await pollUsage({ fetchImpl, credentialsPathOverride: credPath })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.usage.programmatic_credit?.used_usd).toBe(12.34)

    // T-18-01: the token must not appear anywhere on the payload or its JSON.
    const serialized = JSON.stringify(res.usage)
    expect(serialized).not.toContain(FAKE_TOKEN)
    expect(serialized.toLowerCase()).not.toContain('accesstoken')
    expect(serialized).not.toContain('Bearer')
  })
})
