/**
 * Guard against the silent crash-capture footgun: the supervisor.hello B6 seed
 * MUST call `findOrCreateRootlessSession` with the correct 5-arg shape
 * (userId, hostname, cliKind, tokenHashIfCreating, nameIfCreating) and MUST NOT
 * call `ensureSupervisorProject` with an undefined session id.
 *
 * History: a regression called `findOrCreateRootlessSession(userId, 'claude')`
 * (2 args). That bound `hostname='claude'`, `cliKind=undefined`, and returned a
 * row whose `id` was undefined. That undefined then flowed into the NOT-NULL
 * `error_projects.session_id` INSERT, making postgres.js throw
 * `UNDEFINED_VALUE`. The error was swallowed by a try/catch, so supervisor
 * crash capture was silently non-functional in prod — the hello_ack shipped
 * WITHOUT sentry creds.
 *
 * Uses dependency injection (NOT `mock.module`) so it can't pollute sibling
 * test files — see hub/test mock-pollution hygiene. No DB needed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/placeholder'

import { describe, test, expect } from 'bun:test'
import { seedSupervisorSelfCaptureProject } from '../src/ws/agent.ts'

// A faithful stand-in for findOrCreateRootlessSession: only yields a row with a
// defined id when called with the correct 5-arg shape (valid hostname + a
// 'claude'|'codex' cliKind). A 2-arg buggy call lands cliKind=undefined → row
// with undefined id, exactly the UNDEFINED_VALUE source.
function makeRootlessSpy() {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]) => {
    calls.push(args)
    const [, hostname, cliKind] = args
    if (cliKind !== 'claude' && cliKind !== 'codex') {
      return Promise.resolve({ id: undefined, created: true } as any)
    }
    return Promise.resolve({ id: `sess_root_${String(hostname)}`, created: true } as any)
  }
  return { calls, fn: fn as any }
}

function makeEnsureSpy() {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]) => {
    calls.push(args)
    const [, , sessionId] = args
    // Mirror the NOT-NULL bind: postgres.js throws on undefined/null session_id.
    if (sessionId === undefined || sessionId === null) {
      return Promise.reject(new Error('UNDEFINED_VALUE: Undefined values are not allowed'))
    }
    return Promise.resolve({ id: 'proj_1', sentry_key: 'sup_host_abc123', session_id: sessionId } as any)
  }
  return { calls, fn: fn as any }
}

describe('supervisor.hello B6 self-capture seed — arity guard', () => {
  test('calls findOrCreateRootlessSession with the 5-arg shape (userId, hostname, "claude", tokenHash, name)', async () => {
    const rootless = makeRootlessSpy()
    const ensure = makeEnsureSpy()

    await seedSupervisorSelfCaptureProject(
      { userId: 'user_A', hostname: 'WORKSTATION-1', supervisorId: 'sup_1' },
      { findOrCreateRootlessSession: rootless.fn, ensureSupervisorProject: ensure.fn },
    )

    expect(rootless.calls).toHaveLength(1)
    const args = rootless.calls[0]
    // Exactly 5 args — the buggy call passed only 2.
    expect(args).toHaveLength(5)
    expect(args[0]).toBe('user_A')          // userId
    expect(args[1]).toBe('WORKSTATION-1')   // hostname (NOT 'claude')
    expect(args[2]).toBe('claude')          // cliKind
    expect(typeof args[3]).toBe('string')   // tokenHashIfCreating
    expect((args[3] as string).length).toBeGreaterThan(0)
    expect(typeof args[4]).toBe('string')   // nameIfCreating
  })

  test('ensureSupervisorProject is called with a defined session id (never undefined) + hello_ack carries sentry creds', async () => {
    const rootless = makeRootlessSpy()
    const ensure = makeEnsureSpy()

    const ack = await seedSupervisorSelfCaptureProject(
      { userId: 'user_A', hostname: 'WORKSTATION-1', supervisorId: 'sup_1' },
      { findOrCreateRootlessSession: rootless.fn, ensureSupervisorProject: ensure.fn },
    )

    expect(ensure.calls).toHaveLength(1)
    const sessionId = ensure.calls[0][2]
    expect(sessionId).toBeDefined()
    expect(sessionId).not.toBeNull()
    expect(sessionId).toBe('sess_root_WORKSTATION-1')

    // hello_ack carries the sentry creds — crash capture is functional.
    expect(ack).not.toBeNull()
    expect(ack!.type).toBe('supervisor.hello_ack')
    expect(ack!.sentry_key).toBe('sup_host_abc123')
    expect(ack!.sentry_project_id).toBe('proj_1')
    expect(ack!.supervisor_id).toBe('sup_1')
  })

  test('the OLD 2-arg call shape would have produced an undefined session id (regression proof)', async () => {
    // Demonstrate the exact prod failure: simulate the buggy call by feeding the
    // spy the 2-arg shape (userId, 'claude'). cliKind lands undefined → no id.
    const rootless = makeRootlessSpy()
    const buggyRow = await rootless.fn('user_A', 'claude')
    expect(buggyRow.id).toBeUndefined()

    // And feeding that undefined into the ensure spy reproduces UNDEFINED_VALUE.
    const ensure = makeEnsureSpy()
    await expect(ensure.fn('user_A', 'claude', buggyRow.id)).rejects.toThrow(/UNDEFINED_VALUE/)
  })

  test('skips ensureSupervisorProject and returns null when rootless id is missing (guard)', async () => {
    const ensure = makeEnsureSpy()
    const rootlessAlwaysUndefined = (..._args: unknown[]) => Promise.resolve({ id: undefined, created: true } as any)

    const ack = await seedSupervisorSelfCaptureProject(
      { userId: 'user_A', hostname: 'WORKSTATION-1', supervisorId: 'sup_1' },
      { findOrCreateRootlessSession: rootlessAlwaysUndefined as any, ensureSupervisorProject: ensure.fn },
    )

    // Guard fires: no poisoned INSERT, no throw, just a skip.
    expect(ack).toBeNull()
    expect(ensure.calls).toHaveLength(0)
  })
})
