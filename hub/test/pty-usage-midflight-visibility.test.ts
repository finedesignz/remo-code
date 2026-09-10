// hub/test/pty-usage-midflight-visibility.test.ts
// PTYCAP Phase 1, plan 03 — proves SC-3: a long-running TUI turn that crosses a
// ceiling MID-FLIGHT is detectable, because `getTodayTokenTotal()` climbs with
// every incremental PTY-tagged ledger write — no session-close, exit, kill, or
// finalize event anywhere in this suite. This is the precondition Phase 2's PTY
// pre-flight gate needs: a number that moves DURING a turn, not only after it.
//
// RECORD/OBSERVE ONLY. This suite reads `getTodayTokenTotal()`; it does not
// import, call, or extend `dailyTokenCapGate` or any other gate in the hub's
// dispatch gate chain — gating is Phase 2's job, not this phase's.
//
// Skips cleanly without REMO_E2E_DB_URL (this repo's only sanctioned kind of
// skip — see tools/regression-baseline.json's _skip_note_* convention).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('PTY mid-flight token visibility (SC-3)', () => {
  let harness: typeof import('./e2e/orchestrator-harness.ts')
  let tokenDal: typeof import('../src/db/token-usage-dal.ts')
  let h: import('./e2e/orchestrator-harness.ts').Harness

  beforeAll(async () => {
    // The hub's shared `sql` binds DATABASE_URL at IMPORT time — repoint it at
    // the disposable DB BEFORE any DAL import (mirrors orchestrator-tokencap.e2e.test.ts).
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./e2e/orchestrator-harness.ts')
    tokenDal = await import('../src/db/token-usage-dal.ts')
    h = await harness.setupHarness()
  })

  afterAll(async () => {
    if (h) await harness.teardownHarness(h)
  })

  test('baseline total for a freshly seeded user is 0', async () => {
    const total = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    expect(total).toBe(0)
  })

  test('the total climbs strictly monotonically with each incremental PTY write, no session-close anywhere, and a ceiling crossing is observable at the expected index', async () => {
    // Illustrative ceiling — NOT the real production cap. Chosen so each record
    // individually is well below it, but the running sum crosses it partway
    // through the sequence.
    const CEILING = 1_000
    const perRecordTotals = [100, 150, 200, 250, 300, 350] // sums to 1350; crosses 1000 at index 4 (cumulative 1000) → strictly at index 5 (1350 > 1000)
    let cumulative = 0
    const observed: number[] = []
    let crossingIndex = -1

    for (let i = 0; i < perRecordTotals.length; i++) {
      const n = perRecordTotals[i]
      // Split each record's total evenly across all four buckets so this case
      // also exercises a multi-bucket write (the cache-read-only case below is
      // its own dedicated test).
      const quarter = Math.floor(n / 4)
      await tokenDal.recordTokenUsage({
        userId: h.userId,
        sessionId: h.sessionId,
        model: 'claude-sonnet-5',
        inputTokens: quarter,
        outputTokens: quarter,
        cacheCreationInputTokens: quarter,
        cacheReadInputTokens: n - quarter * 3, // remainder, so the four buckets sum to n exactly
        costUsd: 0,
        costSource: 'estimated',
        runnerType: 'pty-interactive',
      })
      cumulative += n
      const total = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
      observed.push(total)
      if (crossingIndex === -1 && total >= CEILING) crossingIndex = i
    }

    // Strictly monotonically increasing — no plateau, no session-close needed.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThan(observed[i - 1])
    }
    // Final reading equals the exact arithmetic sum across every written row.
    expect(observed[observed.length - 1]).toBe(cumulative)
    // The crossing is observable at the expected point: cumulative after index 3
    // (100+150+200+250=700) is still under 1000; after index 4 (+300=1000) it
    // reaches exactly the ceiling.
    expect(crossingIndex).toBe(4)
    expect(observed[3]).toBeLessThan(CEILING)
    expect(observed[4]).toBeGreaterThanOrEqual(CEILING)
  })

  test('a stream-json row for the same user adds to the SAME total — no second aggregation path', async () => {
    const before = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    await tokenDal.recordTokenUsage({
      userId: h.userId,
      sessionId: h.sessionId,
      model: 'claude-sonnet-5',
      inputTokens: 50, outputTokens: 10,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.001, costSource: 'sdk',
      runnerType: 'stream-json',
    })
    const after = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    expect(after).toBe(before + 60)
  })

  test('a record whose ONLY non-zero bucket is cache_read_input_tokens still increases the total (the 2026-07 incident shape)', async () => {
    const before = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    await tokenDal.recordTokenUsage({
      userId: h.userId,
      sessionId: h.sessionId,
      model: 'claude-sonnet-5',
      inputTokens: 0, outputTokens: 0,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 999_999,
      costUsd: 0, costSource: 'estimated',
      runnerType: 'pty-interactive',
    })
    const after = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    expect(after).toBe(before + 999_999) // an I/O-only sum would have read `before` unchanged
  })
})
