// hub/test/e2e/orchestrator-tokencap.e2e.test.ts
// fix/stop-the-bleed — PROVES the daily TOKEN cap actually FIRES and BLOCKS.
//
// WHY THIS EXISTS. On 2026-07-11 a wedged orchestrator tick loop burned ~1.4
// BILLION tokens/day against a REMO_ORCHESTRATOR_DAILY_TOKEN_CAP default of
// 50,000,000 — 28x the ceiling — and killed the owner's subscription. The cap
// was CONSULTED but never fired, because `getTodayTokenTotal` summed only
// input+output while the burn was almost entirely CACHE-READ tokens (#335).
// #342 fixed the counting; nobody had proven the gate BLOCKS. This does.
//
// Design mirrors orchestrator-costcap.e2e.test.ts: drive the REAL
// `injectOrchestratorPrompt` → REAL `dispatch()` → REAL gate list
// `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]`
// → REAL `getTokenCapStatus` → REAL `getTodayTokenTotal` reading `token_usage`
// in the user's tz. The only seams are inject.ts's documented `InjectDeps`
// (fake online channel + the real dispatch). No cap bypass exists.
//
// What is proven:
//   1. CACHE-READ ALONE trips the cap. The incident's exact shape: zero
//      input/output, billions of cache_read tokens → the gate BLOCKS and the
//      prompt is NEVER sent (no ws frame, no persisted message row).
//   2. UNDER cap (control): the same real path dispatches and sends.
//   3. The pre-#342 accounting (input+output only) would NOT have fired on the
//      incident's usage — pinned so the cache-read blindness can never return.
//
// Skips cleanly without REMO_E2E_DB_URL.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('fix/stop-the-bleed e2e — the daily TOKEN cap fires on the real inject path', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let injectMod: typeof import('../../src/orchestrator/inject.ts')
  let pipelineMod: typeof import('../../src/dispatch/pipeline.ts')
  let tokenDal: typeof import('../../src/db/token-usage-dal.ts')
  let h: import('./orchestrator-harness.ts').Harness

  const CAP = 50_000_000 // the shipped default, asserted below

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    // Use the SHIPPED default cap — do not weaken it for the test.
    delete process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP
    // Keep the inject-rate ceiling out of the way: this test is about the TOKEN
    // cap, and the rate gate runs AFTER it (a block here must be the token cap).
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '0' // disabled (fail-open)
    harness = await import('./orchestrator-harness.ts')
    injectMod = await import('../../src/orchestrator/inject.ts')
    pipelineMod = await import('../../src/dispatch/pipeline.ts')
    tokenDal = await import('../../src/db/token-usage-dal.ts')
    h = await harness.setupHarness()
    // Cost cap must NOT be what blocks — raise it out of the way (the token cap
    // is what we are proving; the cost gate runs first and would mask it).
    await h.sql`UPDATE users SET daily_cost_cap_usd = 100000.0000 WHERE id = ${h.userId}`
  })

  afterAll(async () => {
    delete process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR
    if (h) await harness.teardownHarness(h)
  })

  /** Seed one token_usage row for "today" with an explicit 4-bucket split. */
  async function seedTokens(b: {
    input?: number; output?: number; cacheCreation?: number; cacheRead?: number
  }): Promise<void> {
    await h.sql`
      INSERT INTO token_usage (
        user_id, session_id, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, cost_source, created_at
      ) VALUES (
        ${h.userId}, ${h.sessionId}, 'claude-test',
        ${b.input ?? 0}, ${b.output ?? 0},
        ${b.cacheCreation ?? 0}, ${b.cacheRead ?? 0},
        0, 'sdk', now()
      )
    `
  }

  async function clearTokens(): Promise<void> {
    await h.sql`DELETE FROM token_usage WHERE user_id = ${h.userId}`
  }

  function fakeChannel() {
    const sent: string[] = []
    return {
      channel: { ws: { send: (frame: string) => { sent.push(frame) } }, userId: h.userId, sessionId: h.sessionId },
      sent,
    }
  }

  function injectDeps(channel: unknown): import('../../src/orchestrator/inject.ts').InjectDeps {
    return {
      dispatch: pipelineMod.dispatch, // REAL dispatch → REAL gate list
      getChannel: ((sid: string) => (sid === h.sessionId ? channel : undefined)) as any,
      isSessionLive: (async (sid: string) => sid === h.sessionId) as any,
    }
  }

  async function messageCount(): Promise<number> {
    const rows = await h.sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM messages WHERE session_id = ${h.sessionId}
    `
    return Number(rows[0]?.n ?? 0)
  }

  test('OVER cap on CACHE-READ ALONE: the gate BLOCKS and nothing is sent', async () => {
    pipelineMod._reset()
    await clearTokens()

    // The 2026-07 incident's exact shape: no input/output to speak of, a mountain
    // of cache-read. 1.4B > the 50M default cap by 28x.
    await seedTokens({ input: 1_000, output: 1_000, cacheRead: 1_400_000_000 })

    // The counter must SEE the cache-read (the #335 blindness that let the burn run).
    const total = await tokenDal.getTodayTokenTotal(h.userId, 'UTC')
    expect(total).toBeGreaterThanOrEqual(1_400_000_000)
    expect(total).toBeGreaterThan(CAP)

    const before = await messageCount()
    const { channel, sent } = fakeChannel()

    const outcome = await injectMod.injectOrchestratorPrompt(
      {
        userId: h.userId,
        sessionId: h.sessionId,
        token: `orch:${h.sessionId}:over-token-cap:${Date.now()}`,
        prompt: 'stop-the-bleed over-token-cap probe — must be refused',
      },
      injectDeps(channel),
    )

    expect(outcome.kind).toBe('refused')
    if (outcome.kind === 'refused') {
      expect(outcome.reason.startsWith('over_daily_token_cap:')).toBe(true)
      expect(outcome.reason).toContain(`>=${CAP}`)
    }
    // The hard ceiling held: send NEVER fired.
    expect(sent.length).toBe(0)
    expect(await messageCount()).toBe(before)
  })

  test('UNDER cap (control): the same real path dispatches and sends', async () => {
    pipelineMod._reset()
    await clearTokens()
    await seedTokens({ input: 10_000, output: 5_000, cacheRead: 1_000_000 }) // ~1M << 50M

    const before = await messageCount()
    const { channel, sent } = fakeChannel()

    const outcome = await injectMod.injectOrchestratorPrompt(
      {
        userId: h.userId,
        sessionId: h.sessionId,
        token: `orch:${h.sessionId}:under-token-cap:${Date.now()}`,
        prompt: 'stop-the-bleed under-token-cap probe — must dispatch',
      },
      injectDeps(channel),
    )

    expect(outcome.kind).toBe('dispatched')
    expect(sent.length).toBe(1)
    expect(await messageCount()).toBe(before + 1)
  })

  test('the pre-#342 accounting (input+output only) would NOT have fired — regression pin', async () => {
    await clearTokens()
    await seedTokens({ input: 1_000, output: 1_000, cacheRead: 1_400_000_000 })

    // What #335 counted: input+output = 2,000 — three orders of magnitude under
    // the cap while 1.4B tokens/day burned. This is why the cap never fired.
    const rows = await h.sql<{ io: string; all4: string }[]>`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS io,
             COALESCE(SUM(input_tokens + output_tokens
                          + cache_creation_input_tokens
                          + cache_read_input_tokens), 0)::text AS all4
      FROM token_usage WHERE user_id = ${h.userId}
    `
    expect(Number(rows[0].io)).toBeLessThan(CAP)   // old sum: cap never trips
    expect(Number(rows[0].all4)).toBeGreaterThan(CAP) // fixed sum: cap trips
    // And the live DAL uses the fixed sum.
    expect(await tokenDal.getTodayTokenTotal(h.userId, 'UTC')).toBe(Number(rows[0].all4))
  })
})
