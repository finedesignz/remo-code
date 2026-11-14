// CORCH-09 (R3.8, R4.4, R4.5): the real Workspace + PrLookup with a fake memlog and a fake slot supervisor. No DB.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { createWorkspace, createPrLookup, expectedWorktreePath, parseRepoIdent, type CommandResult, type CorchCommand, type WorkspaceDeps } from '../src/corch/workspace.ts'
import { DEFAULT_MEMLOG, type MemlogClient, type MemlogClaimResult } from '../src/corch/memlog.ts'
import { DEFAULT_WORKSPACE, DEFAULT_PR_LOOKUP, refusalSchedule } from '../src/corch/dispatcher.ts'

const ROOT = '/data/repos'
const item: any = { id: 'item-1', branch: 'corch/item-1', title: 'secret title' }
const project: any = { id: 'proj-1', repo_ident: 'github://acme/app' }

function world(o: { claim?: MemlogClaimResult; halted?: string | null; ensure?: CommandResult; prUrl?: string | null | 'fail'; quota?: any; run?: any; hosts?: string[] } = {}) {
  const log: string[] = []
  const frames: Array<{ command: CorchCommand; args: string[]; supervisorId: string }> = []
  const tickets: string[] = []
  const memlog: MemlogClient = {
    claim: async (i) => (log.push(`claim:${i.session}:${i.branch}:${i.worktree}`), o.claim ?? { ok: true }),
    heartbeat: async (i) => (log.push(`heartbeat:${i.session}`), true),
    release: async (i) => (log.push(`release:${i.session}:${i.status}:${i.note}`), true),
  }
  const deps: WorkspaceDeps = {
    quota: o.quota ?? { snapshotFor: async () => ({ ok: true, account_slot: 'acct-1', supervisor_id: 'sup-1' }), supervisorFor: async () => 'sup-1' },
    memlog,
    store: {
      latestRunForItem: async () => o.run ?? { supervisor_id: 'sup-1', worktree_path: `${ROOT}/corch/app-item-1`, repo_ident: 'github://acme/app' } as any,
      workspaceHostsForItem: async () => o.hosts ?? (((o.run ?? { supervisor_id: 'sup-1' }) as any).supervisor_id ? [((o.run ?? { supervisor_id: 'sup-1' }) as any).supervisor_id] : []),
      recordRunSupervisor: async (runId: string, sup: string) => (log.push(`record:${runId}:${sup}`), true),
      runContext: async () => ({ run: o.run ?? { supervisor_id: 'sup-1', worktree_path: `${ROOT}/corch/app-item-1` } } as any),
    },
    runCommand: async (supervisorId, _u, command, args) => {
      log.push(`frame:${command}`)
      frames.push({ command, args, supervisorId })
      if (command === 'corch.worktree_ensure') return o.ensure ?? { exit_code: 0, snippet: JSON.stringify({ path: `${ROOT}/corch/app-item-1`, branch: 'corch/item-1' }) }
      if (command === 'corch.pr_lookup') return o.prUrl === 'fail' ? { exit_code: 1, error: 'gh_pr_list_failed' } : { exit_code: 0, snippet: JSON.stringify({ pr_url: o.prUrl ?? null }) }
      return { exit_code: 0, snippet: JSON.stringify({ removed: true }) }
    },
    halt: async () => {
      log.push('halt')
      return o.halted ? { ok: false, reason: o.halted } : { ok: true }
    },
    supervisor: () => ({ hostname: 'slot-host', root: ROOT }),
    ensureSession: async (a) => (log.push(`session:${a.hostname}:${a.worktreePath}`), 'sess-1'),
    ticket: (fp) => void tickets.push(fp),
  }
  return { log, frames, tickets, deps, ws: createWorkspace(deps) }
}

const resolve = (w: ReturnType<typeof world>) => w.ws.resolve({ userId: 'u1', item, project, runId: 'run-1' })

describe('defaults stay fail closed', () => {
  test('DEFAULT_WORKSPACE / DEFAULT_PR_LOOKUP / DEFAULT_MEMLOG all refuse', async () => {
    expect(await DEFAULT_WORKSPACE.resolve({} as any)).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(await DEFAULT_PR_LOOKUP.lookup({} as any)).toEqual({ kind: 'unavailable' })
    expect(await DEFAULT_MEMLOG.claim({} as any)).toEqual({ ok: false, reason: 'memlog_unavailable' })
  })
})

describe('R3.8 memlog claim', () => {
  test('claim precedes the first corch.* frame; claim carries session corch:<id>, branch and worktree', async () => {
    const w = world()
    const r = await resolve(w)
    expect(r).toEqual({ ok: true, sessionId: 'sess-1', worktreePath: `${ROOT}/corch/app-item-1` })
    const claimAt = w.log.findIndex((l) => l.startsWith('claim:'))
    const frameAt = w.log.findIndex((l) => l.startsWith('frame:'))
    expect(claimAt).toBeGreaterThanOrEqual(0)
    expect(claimAt).toBeLessThan(frameAt)
    expect(w.log[claimAt]).toBe(`claim:corch:item-1:corch/item-1:${ROOT}/corch/app-item-1`)
    expect(w.frames[0]).toEqual({ command: 'corch.worktree_ensure', args: ['github://acme/app', 'item-1'], supervisorId: 'sup-1' })
    expect(w.log).toContain('session:slot-host:' + ROOT + '/corch/app-item-1')
  })

  test('conflict => wait memlog_conflict, no frame, no session', async () => {
    const w = world({ claim: { ok: false, reason: 'memlog_conflict' } })
    expect(await resolve(w)).toEqual({ ok: false, reason: 'memlog_conflict' })
    expect(w.frames.length).toBe(0)
    expect(w.log.some((l) => l.startsWith('session:'))).toBe(false)
    expect(w.tickets).toEqual([])
  })

  test('unreachable => wait memlog_unavailable + exactly ONE ticket across repeats; no dispatch without a claim', async () => {
    const w = world({ claim: { ok: false, reason: 'memlog_unavailable' } })
    for (let i = 0; i < 3; i++) expect(await resolve(w)).toEqual({ ok: false, reason: 'memlog_unavailable' })
    expect(w.tickets).toEqual(['corch.memlog_unavailable'])
    expect(w.frames.length).toBe(0)
  })

  test('a throwing memlog client is unavailable, never a claim', async () => {
    const w = world()
    ;(w.deps.memlog as any).claim = async () => { throw new Error('boom') }
    expect(await createWorkspace(w.deps).resolve({ userId: 'u1', item, project, runId: 'r' })).toEqual({ ok: false, reason: 'memlog_unavailable' })
    expect(w.frames.length).toBe(0)
  })

  test('memlog wait reasons schedule a bounded re-evaluation, not an event-less hang', () => {
    for (const reason of ['memlog_conflict', 'memlog_unavailable']) {
      expect(refusalSchedule(reason)).toEqual({ endReason: reason, waitReason: reason, notBefore: 'plus_lease' })
    }
  })

  test('release on done/cancelled removes the worktree then releases; blocked keeps the worktree', async () => {
    for (const status of ['done', 'cancelled'] as const) {
      const w = world()
      await w.ws.release({ userId: 'u1', itemId: 'item-1', status })
      expect(w.frames.map((f) => f.command)).toEqual(['corch.worktree_remove'])
      expect(w.log.at(-1)).toBe(`release:corch:item-1:DONE:corch: item ${status}`)
    }
    const b = world()
    await b.ws.release({ userId: 'u1', itemId: 'item-1', status: 'blocked' })
    expect(b.frames.length).toBe(0)
    expect(b.log.at(-1)).toBe('release:corch:item-1:DONE:corch: item blocked')
  })

  test('QC4: the host is recorded BEFORE worktree_ensure; release never guesses a host for a run that recorded none', async () => {
    const r = world()
    await r.ws.resolve({ userId: 'u1', item: { id: 'item-1', branch: 'corch/item-1' } as any, project: { id: 'p1', repo_ident: 'github://acme/app' } as any, runId: 'run-1' })
    expect(r.log.indexOf('record:run-1:sup-1')).toBeGreaterThan(-1)
    expect(r.log.indexOf('record:run-1:sup-1')).toBeLessThan(r.log.indexOf('frame:corch.worktree_ensure'))
    // account rebound to another supervisor after the worktree was made: remove targets only the recorded host
    const w = world({ quota: { snapshotFor: async () => ({ ok: true, account_slot: 'acct-1', supervisor_id: 'sup-1' }), supervisorFor: async () => 'sup-B' } as any, run: { supervisor_id: 'sup-A', worktree_path: null, account_slot: 'acct-1', repo_ident: 'github://acme/app' } })
    await w.ws.release({ userId: 'u1', itemId: 'item-1', status: 'cancelled' })
    expect(w.frames).toEqual([{ command: 'corch.worktree_remove', args: ['github://acme/app', 'item-1'], supervisorId: 'sup-A' }])
    // no recorded host: no frame at all (left for reconcile), claim still released
    const none = world({ run: { supervisor_id: null, worktree_path: null, account_slot: 'acct-1', repo_ident: 'github://acme/app' } })
    await none.ws.release({ userId: 'u1', itemId: 'item-1', status: 'cancelled' })
    expect(none.frames.length).toBe(0)
    expect(none.log.some((l) => l.startsWith('release:'))).toBe(true)
    // QC5: an older run's host and a newer run's host are both reached
    const two = world({ hosts: ['sup-A', 'sup-B'], run: { supervisor_id: 'sup-B', worktree_path: null, repo_ident: 'github://acme/app' } })
    await two.ws.release({ userId: 'u1', itemId: 'item-1', status: 'done' })
    expect(two.frames.map((f) => f.supervisorId).sort()).toEqual(['sup-A', 'sup-B'])
  })

  test('heartbeat reaches memlog for the item session; never throws', async () => {
    const w = world()
    await w.ws.heartbeat({ itemId: 'item-1', repoIdent: 'github://acme/app' })
    expect(w.log).toContain('heartbeat:corch:item-1')
    ;(w.deps.memlog as any).heartbeat = async () => { throw new Error('x') }
    await createWorkspace(w.deps).heartbeat({ itemId: 'item-1', repoIdent: 'github://acme/app' })
  })
})

describe('QC hardening: claim unwinding', () => {
  test('requeued releases the claim only (no worktree frame)', async () => {
    const w = world()
    await w.ws.release({ userId: 'u1', itemId: 'item-1', status: 'requeued' })
    expect(w.frames.length).toBe(0)
    expect(w.log.at(-1)).toBe('release:corch:item-1:DONE:corch: item requeued')
  })

  test('a rejected RPC or session error after the claim unwinds the claim and rethrows', async () => {
    const a = world()
    ;(a.deps as any).runCommand = async () => { throw new Error('socket exploded') }
    await expect(createWorkspace(a.deps).resolve({ userId: 'u1', item, project, runId: 'r' })).rejects.toThrow('socket exploded')
    expect(a.log.some((l) => l.startsWith('release:corch:item-1:DONE'))).toBe(true)

    const b = world()
    ;(b.deps as any).ensureSession = async () => { throw new Error('db down') }
    await expect(createWorkspace(b.deps).resolve({ userId: 'u1', item, project, runId: 'r' })).rejects.toThrow('session_error:db down')
    expect(b.log.some((l) => l.startsWith('release:corch:item-1:DONE'))).toBe(true)
  })

  test('an RPC TIMEOUT does NOT release the claim (the command may still be mutating the worktree)', async () => {
    const w = world({ ensure: { exit_code: 1, error: 'supervisor_timeout' } })
    await expect(resolve(w)).rejects.toThrow('supervisor_timeout')
    expect(w.log.some((l) => l.startsWith('release:'))).toBe(false)
  })
})

describe('R4.4 worktree frames', () => {
  test('haltBeforeMachineSend immediately precedes EVERY corch.* frame', async () => {
    const w = world()
    await resolve(w)
    await w.ws.release({ userId: 'u1', itemId: 'item-1', status: 'done' })
    await createPrLookup(w.deps).lookup({ userId: 'u1', repoIdent: 'github://acme/app', branch: 'corch/item-1', workItemId: 'item-1', runId: 'run-1' })
    const idx = w.log.map((l, i) => (l.startsWith('frame:') ? i : -1)).filter((i) => i >= 0)
    expect(idx.length).toBe(3)
    for (const i of idx) expect(w.log[i - 1]).toBe('halt')
  })

  test('a halted switch sends NO frame, releases the claim and waits with the halt reason', async () => {
    const w = world({ halted: 'automation_halted:global' })
    expect(await resolve(w)).toEqual({ ok: false, reason: 'automation_halted:global' })
    expect(w.frames.length).toBe(0)
    expect(w.log.some((l) => l.startsWith('release:'))).toBe(true)
    const lookup = await createPrLookup(w.deps).lookup({ userId: 'u1', repoIdent: 'github://acme/app', branch: 'corch/item-1', workItemId: 'item-1', runId: 'r' })
    expect(lookup).toEqual({ kind: 'unavailable' })
    expect(w.frames.length).toBe(0)
  })

  test('worktree command failure releases the claim and throws (bounded failure with an attempt)', async () => {
    const w = world({ ensure: { exit_code: 1, error: 'git_clone_failed' } })
    await expect(resolve(w)).rejects.toThrow('worktree_ensure_failed:git_clone_failed')
    expect(w.log.some((l) => l.startsWith('release:corch:item-1:DONE'))).toBe(true)
  })

  test('a supervisor returning a different path or branch than the layout is refused', async () => {
    const w = world({ ensure: { exit_code: 0, snippet: JSON.stringify({ path: '/etc/elsewhere', branch: 'corch/item-1' }) } })
    await expect(resolve(w)).rejects.toThrow('worktree_layout_mismatch')
  })

  test('quota refusal and an unbound/offline slot supervisor are no-attempt waits', async () => {
    const q = world({ quota: { snapshotFor: async () => ({ ok: false, reason: 'quota:no_eligible_account' }) } })
    expect(await resolve(q)).toEqual({ ok: false, reason: 'quota:no_eligible_account' })
    const u = world({ quota: { snapshotFor: async () => ({ ok: true, account_slot: 'a', supervisor_id: null }) } })
    expect(await resolve(u)).toEqual({ ok: false, reason: 'quota:supervisor_unbound' })
    expect(q.log.length + u.log.length).toBe(0)
  })

  test('deterministic path helpers', () => {
    expect(expectedWorktreePath('/data/repos/', 'app', 'i1')).toBe('/data/repos/corch/app-i1')
    expect(expectedWorktreePath('C:\\work', 'app', 'i1')).toBe('C:\\work\\corch\\app-i1')
    expect(parseRepoIdent('github://a/b')).toEqual({ owner: 'a', name: 'b' })
    expect(parseRepoIdent('path:///x')).toBeNull()
  })
})

describe('R4.5 PR lookup', () => {
  const lookup = (w: ReturnType<typeof world>) =>
    createPrLookup(w.deps).lookup({ userId: 'u1', repoIdent: 'github://acme/app', branch: 'corch/item-1', workItemId: 'item-1', runId: 'run-1' })

  test('open PR => open + url; none => none (requeue per R3.4); gh failure => unavailable', async () => {
    expect(await lookup(world({ prUrl: 'https://github.com/acme/app/pull/9' }))).toEqual({ kind: 'open', url: 'https://github.com/acme/app/pull/9' })
    expect(await lookup(world({ prUrl: null }))).toEqual({ kind: 'none' })
    expect(await lookup(world({ prUrl: 'fail' }))).toEqual({ kind: 'unavailable' })
  })

  test('targets the run\'s own supervisor + worktree path and sends only path and branch', async () => {
    const w = world({ prUrl: null })
    await lookup(w)
    expect(w.frames).toEqual([{ command: 'corch.pr_lookup', args: [`${ROOT}/corch/app-item-1`, 'corch/item-1', 'github://acme/app'], supervisorId: 'sup-1' }])
  })

  test('a run with no supervisor or worktree is unavailable without a frame', async () => {
    const w = world({ run: { supervisor_id: null, worktree_path: null } })
    expect(await lookup(w)).toEqual({ kind: 'unavailable' })
    expect(w.frames.length).toBe(0)
  })
})
