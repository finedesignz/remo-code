import { describe, expect, test } from 'bun:test'
import { reportTicket } from '../src/corch/gsdc-boot.ts'

// AAF is unconfigured in the test env (no AGENTAUTOFIX_* vars): the reporter must send nothing and never throw.
describe('CORCH-04 ticket adapter', () => {
  test('unconfigured AgentAutofix: no network call, no throw', async () => {
    const real = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response('{}')
    }) as any
    try {
      expect(await reportTicket('http_5xx')).toBe(false)
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = real
    }
  })
})
