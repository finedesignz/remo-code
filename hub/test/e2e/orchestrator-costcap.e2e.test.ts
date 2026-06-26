// hub/test/e2e/orchestrator-costcap.e2e.test.ts
// Milestone OEE (Orchestrator E2E Prove-Out) — Phase OEE-06.
//
// PROVES the cross-cutting invariant "cost cap is non-bypassable" HOLDS on the
// REAL orchestrator inject/dispatch path, e2e against real Postgres.
//
// CRITICAL design note (from OEE-05): the scripted sink (orchestrator-harness.ts
// createScriptedSink) OVERRIDES `inject`, so it does NOT exercise the real cap.
// To prove the cap we drive the REAL `injectOrchestratorPrompt` (NOT the sink's
// inject override). That function calls the REAL `dispatch()` with the REAL gate
// list `[thresholdGate, dailyCostCapGate]` (inject.ts IR-1), so the turn flows
// through the REAL `dailyCostCapGate` → `getCostCapStatus` → `getTodayTokenCostUsd`
// reading `token_usage` for the user's tz "today".
//
// The ONLY seams we use are inject.ts's own `InjectDeps` (a documented test seam):
//   - `getChannel` → a fake online channel (ws.send no-op) so the session is
//     considered ONLINE without a live supervisor socket. NO cap bypass: the cap
//     gate runs BEFORE send (pipeline step 1), independent of the channel.
//   - `dispatch`  → the REAL `dispatch` (we pass it through unchanged).
// Nothing in hub/src is modified or monkeypatched.
//
// What is proven:
//   1. OVER cap: seed token_usage so today's cost >= daily_cost_cap_usd, then a
//      real inject returns {kind:'refused_cost_cap'} and NEVER sends (ws.send
//      not called, no `messages` row inserted for the prompt).
//   2. UNDER cap (control): same path, cost < cap → {kind:'dispatched'}, send
//      fires (ws.send called, prompt persisted).
//
// No test-only cap bypass exists. Skips cleanly without REMO_E2E_DB_URL.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('OEE-06 e2e — daily cost cap holds on the real orchestrator inject path', () => {
  // The hub's shared `sql` (hub/src/db/postgres.ts) binds to DATABASE_URL at
  // import time, and the REAL dailyCostCapGate reads through that `sql`. So
  // DATABASE_URL must point at REMO_E2E_DB_URL BEFORE we import inject.ts /
  // dispatch.ts / the harness. Lazy-import inside beforeAll so the describe.skip
  // branch never triggers the import in CI without a test DB.
  let harness: typeof import('./orchestrator-harness.ts')
  let injectMod: typeof import('../../src/orchestrator/inject.ts')
  let pipelineMod: typeof import('../../src/dispatch/pipeline.ts')
  let h: import('./orchestrator-harness.ts').Harness

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    injectMod = await import('../../src/orchestrator/inject.ts')
    pipelineMod = await import('../../src/dispatch/pipeline.ts')
    h = await harness.setupHarness()
  })

  afterAll(async () => {
    if (h) await harness.teardownHarness(h)
  })

  // Seed N rows of token_usage for "today" summing to `costUsd` total cost.
  async function seedTodayCost(costUsd: number): Promise<void> {
    await h.sql`
      INSERT INTO token_usage (
        user_id, session_id, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, cost_source, created_at
      ) VALUES (
        ${h.userId}, ${h.sessionId}, 'claude-test',
        1000, 1000, 0, 0,
        ${costUsd}, 'sdk', now()
      )
    `
  }

  // Build a fake "online" agent channel that records ws.send calls but performs
  // no network I/O. This makes getChannel(sessionId) non-null (session ONLINE)
  // without a live supervisor. It does NOT touch the cap — the cap gate runs
  // first in the pipeline, before any send.
  function fakeChannel() {
    const sent: string[] = []
    const channel = {
      ws: { send: (frame: string) => { sent.push(frame) } },
      userId: h.userId,
      sessionId: h.sessionId,
    }
    return { channel, sent }
  }

  function injectDeps(channel: unknown): import('../../src/orchestrator/inject.ts').InjectDeps {
    return {
      // REAL dispatch → REAL gate list (threshold → dailyCostCapGate).
      dispatch: pipelineMod.dispatch,
      // Fake online channel so the orchestrator's getChannel-online check passes.
      getChannel: ((sid: string) => (sid === h.sessionId ? channel : undefined)) as any,
    }
  }

  // Count messages rows for this session (the prompt persists ONLY on a real send).
  async function messageCount(): Promise<number> {
    const rows = await h.sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM messages WHERE session_id = ${h.sessionId}
    `
    return Number(rows[0]?.n ?? 0)
  }

  test('OVER cap: real inject is refused by dailyCostCapGate and never sends', async () => {
    pipelineMod._reset() // clear module queue between cases

    // Cap = $5; seed today's accumulated cost to $7.50 (>= cap).
    await h.sql`UPDATE users SET daily_cost_cap_usd = 5.0000 WHERE id = ${h.userId}`
    await seedTodayCost(7.5)

    const before = await messageCount()
    const { channel, sent } = fakeChannel()

    const outcome = await injectMod.injectOrchestratorPrompt(
      {
        userId: h.userId,
        sessionId: h.sessionId,
        token: `orch:${h.sessionId}:over-cap:${Date.now()}`,
        prompt: 'OEE-06 over-cap probe — must be refused',
      },
      injectDeps(channel),
    )

    // Blocked by the cost cap, surfaced as refused_cost_cap with the typed reason.
    expect(outcome.kind).toBe('refused_cost_cap')
    if (outcome.kind === 'refused_cost_cap') {
      expect(outcome.reason.startsWith('over_daily_cost_cap:')).toBe(true)
    }
    // IR-1: send was NEVER called → no ws frame, no persisted prompt row.
    expect(sent.length).toBe(0)
    expect(await messageCount()).toBe(before)
  })

  test('UNDER cap (control): same real path dispatches and sends', async () => {
    pipelineMod._reset() // independent of the over-cap case

    // Raise the cap well above today's seeded $7.50 so the same accumulated cost
    // is now UNDER the cap. (We do not delete the seeded rows — proving the gate
    // is a comparison against the cap, not against zero.)
    await h.sql`UPDATE users SET daily_cost_cap_usd = 100.0000 WHERE id = ${h.userId}`

    const before = await messageCount()
    const { channel, sent } = fakeChannel()

    const outcome = await injectMod.injectOrchestratorPrompt(
      {
        userId: h.userId,
        sessionId: h.sessionId,
        token: `orch:${h.sessionId}:under-cap:${Date.now()}`,
        prompt: 'OEE-06 under-cap probe — must dispatch',
      },
      injectDeps(channel),
    )

    expect(outcome.kind).toBe('dispatched')
    // Real send fired exactly once → ws frame emitted + prompt persisted.
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0]).type).toBe('user_message')
    expect(await messageCount()).toBe(before + 1)
  })
})
