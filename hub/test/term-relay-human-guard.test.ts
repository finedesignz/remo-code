/**
 * Phase 16 (H1 / R-PTY-28 + T-16-10/11) — the human-only guard on the
 * term.input RELAY path, with a SERVER-INFERRED actor.
 *
 * The actor is inferred from the connection, never from the payload:
 *   - an authenticated /ws/client (opaque cookie) ⇒ `human` ⇒ allowed,
 *   - a frame carrying a client-asserted `source:"human"` on a NON-human channel
 *     is still rejected — because /ws/agent is output-only (direction allowlist),
 *     an agent CANNOT emit term.input at all (the only write path is the
 *     human-inferred /ws/client),
 *   - a genuine human-connection term.input is forwarded.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

const USER = 'userH'
const SESSION = 'sessH'
const fwdClient: string[] = []
const fwdAgent: string[] = []

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  canWriteTerminal: async (u: string, s: string) => u === USER && s === SESSION,
  getSession: async (s: string, u: string) => (u === USER && s === SESSION ? { id: SESSION } : null),
  getSessionRunnerType: async () => 'pty-interactive',
  getSessionHostname: async () => 'hostH',
  getUserLicenseFields: async () => ({ license_status: 'active' }),
  listSessions: async () => [],
}))

const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: () => ({ ws: { send: (raw: string) => { fwdClient.push(raw) } } }),
  broadcastToSubscribers: (_sid: string, frame: any) => { fwdAgent.push(JSON.stringify(frame)) },
  broadcastErrorEvent: () => {},
  countSubscribers: () => 1,
}))

let handleClientMessage: any
let handleAgentMessage: any

beforeEach(async () => {
  fwdClient.length = 0
  fwdAgent.length = 0
  handleClientMessage = (await import(`../src/ws/client.ts?rt=${Date.now()}`)).handleClientMessage
  handleAgentMessage = (await import(`../src/ws/agent.ts?rt=${Date.now()}`)).handleAgentMessage
})

function humanClient() {
  return {
    data: {
      authenticated: true,
      userId: USER,
      clientEntry: { subscriptions: new Set([SESSION]) },
      authTimer: null,
      msgCount: 0,
      msgWindowStart: Date.now(),
      authMethod: 'session_cookie',
      licenseStatus: 'active',
      licenseCheckedAt: Date.now(),
    },
    send: () => {},
    close: () => {},
  }
}

// A plain agent socket bound to SESSION (the only place term.* could originate
// from the agent side).
function agentSocket() {
  return {
    data: {
      authenticated: true,
      role: 'agent',
      sessionId: SESSION,
      supervisorId: null,
      userId: USER,
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

describe('Phase 16 — human-only guard on the relay (server-inferred actor, H1)', () => {
  test('a genuine human-connection term.input IS forwarded', async () => {
    await handleClientMessage(
      humanClient() as any,
      JSON.stringify({ type: 'term.input', session_id: SESSION, bytes: btoa('y\n') }),
    )
    expect(fwdClient.length).toBe(1)
  })

  test('a client-asserted source:"human" cannot make an AGENT a write actor — /ws/agent term.input is rejected', async () => {
    // Even with a spoofed source field, an agent socket cannot emit term.input:
    // the direction allowlist makes /ws/agent OUTPUT-ONLY. No write reaches a PTY.
    await handleAgentMessage(
      agentSocket() as any,
      JSON.stringify({ type: 'term.input', session_id: SESSION, source: 'human', bytes: btoa('rm -rf\n') }),
    )
    expect(fwdAgent.length).toBe(0) // rejected — never broadcast/forwarded
  })

  test('the agent side CAN emit term.data (output) for its own session', async () => {
    await handleAgentMessage(
      agentSocket() as any,
      JSON.stringify({ type: 'term.data', session_id: SESSION, bytes: btoa('out') }),
    )
    expect(fwdAgent.length).toBe(1)
  })
})
