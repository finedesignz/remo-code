// Regression: supervisor reconnect race. When a supervisor's WS reconnects,
// `registerSupervisor` closes the prior socket; that close event fires
// `handleAgentClose` → `unregisterSupervisor` AFTER the new entry has already
// replaced the old one in the map. If unregister deletes by id alone, the
// stale close wipes the LIVE entry — `isSupervisorOnline` returns false even
// though the new WS is connected and serving traffic. The fix scopes the
// delete to the closing ws identity.

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// Stub only the DB dep before importing the module under test. We leave
// ../src/ws/registry intact (broadcastToUser is a no-op when the user has no
// connected clients) so other test files that import named exports from it
// (e.g. subscribeClient) don't get a partial mock.
mock.module('../src/db/supervisor-dal', () => ({
  setSupervisorState: async () => {},
  touchSupervisor: async () => {},
  listSupervisorsForUser: async () => [],
}))

const {
  registerSupervisor,
  unregisterSupervisor,
  isSupervisorOnline,
  getSupervisor,
} = await import('../src/ws/supervisor-registry')

function makeWs() {
  // Minimal stub — only `close` is exercised by registerSupervisor.
  return { close: () => {}, send: () => {} } as any
}

const SUP = 'sup_test_1'
const USER = 'user_test_1'
const KEY = 'key_test_1'

describe('supervisor-registry reconnect race', () => {
  beforeEach(() => {
    // Ensure clean slate between tests.
    unregisterSupervisor(SUP)
  })
  afterEach(() => {
    unregisterSupervisor(SUP)
  })

  test('new register replaces old entry; isSupervisorOnline true', () => {
    const wsA = makeWs()
    registerSupervisor({ ws: wsA, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })
    expect(isSupervisorOnline(SUP)).toBe(true)

    const wsB = makeWs()
    registerSupervisor({ ws: wsB, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })
    expect(isSupervisorOnline(SUP)).toBe(true)
    expect(getSupervisor(SUP)?.ws).toBe(wsB)
  })

  test('stale close from replaced socket does NOT wipe live entry', () => {
    const wsA = makeWs()
    registerSupervisor({ ws: wsA, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })

    const wsB = makeWs()
    registerSupervisor({ ws: wsB, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })

    // Simulate the old socket's close handler firing AFTER the new entry took over.
    unregisterSupervisor(SUP, wsA)

    // BUG (pre-fix): would be false here because the stale close deleted by id.
    expect(isSupervisorOnline(SUP)).toBe(true)
    expect(getSupervisor(SUP)?.ws).toBe(wsB)
  })

  test('current socket close removes the entry', () => {
    const wsA = makeWs()
    registerSupervisor({ ws: wsA, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })
    unregisterSupervisor(SUP, wsA)
    expect(isSupervisorOnline(SUP)).toBe(false)
  })

  test('legacy call without ws still removes (back-compat)', () => {
    const wsA = makeWs()
    registerSupervisor({ ws: wsA, supervisorId: SUP, userId: USER, apiKeyId: KEY, roots: [] })
    unregisterSupervisor(SUP)
    expect(isSupervisorOnline(SUP)).toBe(false)
  })
})
