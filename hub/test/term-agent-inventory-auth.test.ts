/**
 * Phase 16 (H3 / R-PTY-30 + NH-1 / R-PTY-35) — /ws/agent-side inventory authz
 * for term.* with DB host-ownership cross-validation.
 *
 * Drives the REAL handleAgentMessage with a supervisor socket. Cases:
 *   - a term.data for a session NOT in this supervisor's advertised inventory is
 *     DROPPED (cross-host injection),
 *   - a term.data for an inventory session whose DB hostname matches this
 *     supervisor's hostname is FORWARDED,
 *   - SPOOFED INVENTORY (NH-1): a supervisor advertises a session_id it does not
 *     own per the DB (DB hostname != supervisor hostname) — DROPPED even though
 *     it appears in the self-asserted inventory,
 *   - a term.input on /ws/agent is rejected (direction allowlist, output-only).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

const SUP_ID = 'sup1'
const SUP_HOST = 'hostX'
const OWNED_SESSION = 'sess_owned'     // in inventory, DB hostname=hostX
const FOREIGN_SESSION = 'sess_foreign' // NOT in inventory
const SPOOFED_SESSION = 'sess_spoof'   // in inventory, but DB hostname=hostY (owned by another host)

const fwd: string[] = []

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getSessionHostname: async (sessionId: string) => {
    if (sessionId === OWNED_SESSION) return SUP_HOST
    if (sessionId === SPOOFED_SESSION) return 'hostY' // owned by a DIFFERENT host
    return null
  },
  listSessions: async () => [],
}))

const realSupReg = await import(`../src/ws/supervisor-registry.ts?real=${Date.now()}`)
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realSupReg,
  getSupervisor: (supId: string) => {
    if (supId !== SUP_ID) return undefined
    return {
      supervisorId: SUP_ID,
      hostname: SUP_HOST,
      // The supervisor self-asserts OWNED + SPOOFED in its inventory.
      sessionInventory: [
        { session_id: OWNED_SESSION },
        { session_id: SPOOFED_SESSION },
      ],
    }
  },
}))

const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  broadcastToSubscribers: (_sid: string, frame: any) => { fwd.push(JSON.stringify(frame)) },
  broadcastToUser: () => {},
}))

let handleAgentMessage: any
beforeEach(async () => {
  fwd.length = 0
  handleAgentMessage = (await import(`../src/ws/agent.ts?rt=${Date.now()}`)).handleAgentMessage
})

function supervisorSocket() {
  return {
    data: {
      authenticated: true,
      role: 'supervisor',
      sessionId: null,
      supervisorId: SUP_ID,
      userId: 'u',
      apiKeyId: 'k',
      authTimer: null,
      heartbeatTimer: null,
      messageCount: 0,
      windowStart: Date.now(),
    },
    send: () => {},
    close: () => {},
  }
}

function termData(sessionId: string) {
  return JSON.stringify({ type: 'term.data', session_id: sessionId, bytes: btoa('output') })
}

describe('Phase 16 — /ws/agent inventory authz + DB host cross-validation', () => {
  test('term.data for an inventory session owned by this host is FORWARDED', async () => {
    await handleAgentMessage(supervisorSocket() as any, termData(OWNED_SESSION))
    expect(fwd.length).toBe(1)
    expect(JSON.parse(fwd[0]).session_id).toBe(OWNED_SESSION)
  })

  test('term.data for a session NOT in the supervisor inventory is DROPPED (cross-host injection, H3)', async () => {
    await handleAgentMessage(supervisorSocket() as any, termData(FOREIGN_SESSION))
    expect(fwd.length).toBe(0)
  })

  test('SPOOFED inventory: a session the host does NOT own per the DB is DROPPED (NH-1)', async () => {
    await handleAgentMessage(supervisorSocket() as any, termData(SPOOFED_SESSION))
    expect(fwd.length).toBe(0)
  })

  test('term.input on /ws/agent is rejected (direction allowlist, output-only)', async () => {
    await handleAgentMessage(
      supervisorSocket() as any,
      JSON.stringify({ type: 'term.input', session_id: OWNED_SESSION, bytes: btoa('x') }),
    )
    expect(fwd.length).toBe(0)
  })
})
