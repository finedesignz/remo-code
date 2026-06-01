/**
 * Phase 18 (R-PTY-17, T-18-02) — explicit empty state for the programmatic
 * credit bucket.
 *
 * A pre-claim / no-credit-field body MUST yield NO programmatic bucket (an
 * explicit empty state), with the four windows still parsed — and NEVER a
 * fabricated dollar number.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseUsageResponse, pollUsage } from '../src/usage/oauth-poll'

const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-absent-case-0987654321'

function tmpCredFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remo-oauth-absent-'))
  const path = join(dir, '.credentials.json')
  writeFileSync(
    path,
    JSON.stringify({ claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: Date.now() + 3_600_000 } }),
    'utf-8',
  )
  return path
}

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8'))
}

describe('programmatic credit empty state', () => {
  test('no-credit fixture => four windows parse, NO programmatic bucket', () => {
    const out = parseUsageResponse(loadFixture('oauth-usage-no-credit.json'))
    expect(out).not.toBeNull()
    expect(out!.five_hour.utilization).toBe(8.0)
    expect(out!.seven_day.utilization).toBe(19.0)
    // Explicit empty state — bucket omitted, NOT a fabricated $0 balance.
    expect(out!.programmatic_credit ?? null).toBeNull()
  })

  test('pollUsage on a no-credit body omits the bucket, still ok, no token leak', async () => {
    const credPath = tmpCredFile()
    const fixture = loadFixture('oauth-usage-no-credit.json')
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch

    const res = await pollUsage({ fetchImpl, credentialsPathOverride: credPath })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.usage.programmatic_credit ?? null).toBeNull()
    const serialized = JSON.stringify(res.usage)
    expect(serialized).not.toContain(FAKE_TOKEN)
    // And no fabricated dollar figure sneaks in.
    expect(serialized).not.toContain('used_usd')
  })
})
