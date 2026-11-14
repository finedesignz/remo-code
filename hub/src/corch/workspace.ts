// hub/src/corch/workspace.ts
//
// CORCH-09 (R3.8, R4.4, R4.5): the REAL Workspace and PrLookup behind the CORCH-01 seams, plus the item-terminal
// release. Everything external is injected (WorkspaceDeps) so tests run with a fake slot supervisor and a fake
// memlog; `realWorkspaceDeps()` binds the real ones by dynamic import (no top-level DB/WS import, LD-2).
//
// Order of one resolve (all before any prompt can be sent):
//   1. pick + record the quota account (idempotent: a run keeps its account) and the slot supervisor advertising it
//   2. memlog claim (R3.8): conflict => wait `memlog_conflict`, unreachable => wait `memlog_unavailable` + ONE ticket
//   3. haltBeforeMachineSend, then `corch.worktree_ensure` on that supervisor (deterministic path + branch)
//   4. create or reuse the `sessions` row for the path (hostname = the slot supervisor)
// A throw (worktree command failure) is a bounded failure with an attempt in the dispatcher; a returned
// `{ ok: false }` is a no-attempt wait.
//
// No token, env value or credential is read or sent here: the hub only ever names repo, branch and path.

import type { CorchProject, CorchWorkItem, CorchRun } from './store.ts'
import type { PrLookup, PrLookupResult, Workspace, WorkspaceResult } from './dispatcher.ts'
import type { QuotaProvider } from './quota-provider.ts'
import { DEFAULT_MEMLOG, memlogSessionFor, type MemlogClient } from './memlog.ts'

export type CorchCommand = 'corch.worktree_ensure' | 'corch.worktree_remove' | 'corch.pr_lookup'

export interface CommandResult {
  exit_code: number
  snippet?: string
  error?: string
}

export interface WorkspaceDeps {
  quota: QuotaProvider
  memlog: MemlogClient
  store: {
    latestRunForItem(userId: string, itemId: string): Promise<(CorchRun & { repo_ident: string }) | null>
    runContext(runId: string): Promise<{ run: CorchRun } | null>
  }
  /** The allowlisted hub->supervisor RPC (hub/src/ext/supervisor-read.ts). Never throws. */
  runCommand(supervisorId: string, userId: string, command: CorchCommand, args: string[]): Promise<CommandResult>
  /** haltBeforeMachineSend: called immediately before EVERY corch.* frame. */
  halt(userId: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** The supervisor's advertised hostname and first scan root, or null when it is not connected. */
  supervisor(supervisorId: string): { hostname: string; root: string | null } | null
  /** Find or create the `sessions` row of a worktree path on a host; returns its id. */
  ensureSession(a: { userId: string; worktreePath: string; hostname: string; name: string }): Promise<string>
  /** One ticket per distinct signature per process (the caller dedupes). Never throws. */
  ticket(fingerprint: string, text: string): void
}

const REPO_IDENT_RE = /^github:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

/** `github://owner/name` -> `{owner, name}` or null. */
export function parseRepoIdent(repoIdent: string): { owner: string; name: string } | null {
  const m = REPO_IDENT_RE.exec(repoIdent)
  return m ? { owner: m[1]!, name: m[2]! } : null
}

function log(msg: string): void {
  console.error(`[corch] ${msg}`)
}

/** The worktree path the supervisor will derive: `<root>/corch/<name>-<id>` (mirrors supervisor corch-worktree.ts). */
export function expectedWorktreePath(root: string, name: string, itemId: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}corch${sep}${name}-${itemId}`
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

function parseSnippet<T>(r: CommandResult): T | null {
  if (r.exit_code !== 0 || !r.snippet) return null
  try {
    return JSON.parse(r.snippet) as T
  } catch {
    return null
  }
}

export interface CorchWorkspace extends Workspace {
  release(a: { userId: string; itemId: string; status: 'done' | 'blocked' | 'cancelled' | 'requeued' }): Promise<void>
  heartbeat(a: { itemId: string; repoIdent: string }): Promise<void>
}

export function createWorkspace(deps: WorkspaceDeps): CorchWorkspace {
  const ticketed = new Set<string>()
  const ticketOnce = (fingerprint: string, text: string): void => {
    if (ticketed.has(fingerprint)) return
    ticketed.add(fingerprint)
    try {
      deps.ticket(fingerprint, text)
    } catch (err) {
      log(`ticket failed ${fingerprint}: ${(err as Error)?.message ?? err}`)
    }
  }

  async function send(userId: string, supervisorId: string, command: CorchCommand, args: string[]): Promise<CommandResult | { refused: string }> {
    const h = await deps.halt(userId) // fresh read immediately before the frame
    if (!h.ok) return { refused: h.reason }
    return deps.runCommand(supervisorId, userId, command, args)
  }

  async function releaseClaim(repo: string, itemId: string, note: string): Promise<void> {
    try {
      await deps.memlog.release({ repo, session: memlogSessionFor(itemId), status: 'DONE', note })
    } catch (err) {
      log(`memlog release failed item=${itemId}: ${(err as Error)?.message ?? err}`)
    }
  }

  return {
    async resolve(a: { userId: string; item: CorchWorkItem; project: CorchProject; runId: string }): Promise<WorkspaceResult> {
      const { userId, item, project, runId } = a
      const ident = parseRepoIdent(project.repo_ident)
      if (!ident) return { ok: false, reason: 'workspace_invalid_repo_ident' }

      // 1. Account + slot supervisor. snapshotFor records the account on the run (idempotent for a run that holds one).
      const snap = await deps.quota.snapshotFor({ userId, projectId: project.id, workItemId: item.id, runId })
      if (!snap.ok) return { ok: false, reason: snap.reason }
      const supervisorId =
        snap.supervisor_id ?? (snap.account_slot && deps.quota.supervisorFor ? await deps.quota.supervisorFor(userId, snap.account_slot) : null)
      if (!supervisorId) return { ok: false, reason: 'quota:supervisor_unbound' }
      const sup = deps.supervisor(supervisorId)
      if (!sup || !sup.root) return { ok: false, reason: 'supervisor_offline' }
      const expected = expectedWorktreePath(sup.root, ident.name, item.id)

      // 2. memlog claim BEFORE the worktree exists (R3.8). Without a claim nothing dispatches.
      let claim: Awaited<ReturnType<MemlogClient['claim']>>
      try {
        claim = await deps.memlog.claim({
          repo: ident.name,
          session: memlogSessionFor(item.id),
          branch: item.branch,
          worktree: expected,
          scope: `corch work item ${item.id}`,
        })
      } catch {
        claim = { ok: false, reason: 'memlog_unavailable' }
      }
      if (!claim.ok) {
        if (claim.reason === 'memlog_unavailable') {
          ticketOnce(
            'corch.memlog_unavailable',
            'CORCH memlog claim could not be taken (hub->memlog transport unavailable); work items wait memlog_unavailable and nothing dispatches without a claim.',
          )
        }
        return { ok: false, reason: claim.reason }
      }

      // From here a claim is held: ANY throw or rejection unwinds it (an RPC timeout excepted: the command may still be
      // mutating the worktree, so the claim is NOT released and simply lapses/re-claims on the next attempt).
      try {
        // 3. worktree on the slot supervisor.
        const r = await send(userId, supervisorId, 'corch.worktree_ensure', [project.repo_ident, item.id])
        if ('refused' in r) {
          await releaseClaim(ident.name, item.id, 'corch: halted before worktree')
          return { ok: false, reason: r.refused }
        }
        const wt = parseSnippet<{ path?: string; branch?: string }>(r)
        if (!wt || typeof wt.path !== 'string') throw new Error(`worktree_ensure_failed:${r.error ?? 'no_reply'}`)
        if (wt.branch !== item.branch || normPath(wt.path) !== normPath(expected)) throw new Error('worktree_layout_mismatch')

        // 4. the session row for the path, hosted by the slot supervisor.
        let sessionId: string
        try {
          sessionId = await deps.ensureSession({ userId, worktreePath: wt.path, hostname: sup.hostname, name: `corch ${ident.name} ${item.id.slice(0, 8)}` })
        } catch (err) {
          throw new Error(`session_error:${(err as Error)?.message ?? 'unknown'}`)
        }
        return { ok: true, sessionId, worktreePath: wt.path }
      } catch (err) {
        if (!/supervisor_timeout/.test((err as Error)?.message ?? '')) await releaseClaim(ident.name, item.id, `corch: ${(err as Error)?.message ?? 'error'}`.slice(0, 200))
        throw err
      }
    },

    /** Item reached done, blocked or cancelled: remove the worktree (done/cancelled only) and release the claim. */
    async release(a) {
      let run: Awaited<ReturnType<WorkspaceDeps['store']['latestRunForItem']>> = null
      try {
        run = await deps.store.latestRunForItem(a.userId, a.itemId)
      } catch (err) {
        log(`release lookup failed item=${a.itemId}: ${(err as Error)?.message ?? err}`)
      }
      if (!run) return
      const ident = parseRepoIdent(run.repo_ident)
      if ((a.status === 'done' || a.status === 'cancelled') && run.supervisor_id && run.worktree_path) {
        try {
          const r = await send(a.userId, run.supervisor_id, 'corch.worktree_remove', [run.repo_ident, a.itemId])
          if ('refused' in r || r.exit_code !== 0) log(`worktree remove not done item=${a.itemId}: ${'refused' in r ? r.refused : (r.error ?? 'error')}`)
        } catch (err) {
          log(`worktree remove threw item=${a.itemId}: ${(err as Error)?.message ?? err}`)
        }
      }
      if (ident) await releaseClaim(ident.name, a.itemId, `corch: item ${a.status}`)
    },

    async heartbeat(a) {
      const ident = parseRepoIdent(a.repoIdent)
      if (!ident) return
      try {
        if (!(await deps.memlog.heartbeat({ repo: ident.name, session: memlogSessionFor(a.itemId) }))) log(`memlog heartbeat not recorded item=${a.itemId}`)
      } catch (err) {
        log(`memlog heartbeat failed item=${a.itemId}: ${(err as Error)?.message ?? err}`)
      }
    },
  }
}

/** Real PrLookup (R4.5): `corch.pr_lookup` on the run's own slot supervisor, which runs gh with the worker credential. */
export function createPrLookup(deps: Pick<WorkspaceDeps, 'store' | 'runCommand' | 'halt'>): PrLookup {
  return {
    async lookup(a): Promise<PrLookupResult> {
      if (!a.runId) return { kind: 'unavailable' }
      const ctx = await deps.store.runContext(a.runId)
      const run = ctx?.run
      if (!run || !run.supervisor_id || !run.worktree_path) return { kind: 'unavailable' }
      const h = await deps.halt(a.userId)
      if (!h.ok) return { kind: 'unavailable' }
      const r = await deps.runCommand(run.supervisor_id, a.userId, 'corch.pr_lookup', [run.worktree_path, a.branch])
      const out = parseSnippet<{ pr_url?: string | null }>(r)
      if (!out) return { kind: 'unavailable' }
      return typeof out.pr_url === 'string' && out.pr_url.length > 0 ? { kind: 'open', url: out.pr_url } : { kind: 'none' }
    },
  }
}

/** The real bindings (dynamic imports: no top-level DB/WS import). The memlog client is the refusing default. */
export async function realWorkspaceDeps(quota: QuotaProvider, memlog: MemlogClient = DEFAULT_MEMLOG): Promise<WorkspaceDeps> {
  const { corchStore } = await import('./store.ts')
  const { runSupervisorReadCommand } = await import('../ext/supervisor-read.ts')
  const { haltBeforeMachineSend } = await import('../dispatch/automation-controls.ts')
  const registry = await import('../ws/supervisor-registry.ts')
  const { createHash, randomBytes } = await import('node:crypto')
  return {
    quota,
    memlog,
    store: corchStore,
    runCommand: (supervisorId, userId, command, args) => runSupervisorReadCommand(supervisorId, userId, command, args, 600_000),
    halt: async (userId) => {
      const h = await haltBeforeMachineSend({ userId })
      return h.ok ? { ok: true } : { ok: false, reason: h.reason }
    },
    supervisor: (id) => {
      const e = registry.getSupervisor(id)
      if (!e) return null
      return { hostname: e.hostname, root: e.roots?.[0] ?? null }
    },
    ensureSession: async ({ userId, worktreePath, hostname, name }) => {
      const dal = await import('../db/dal.ts')
      const existing = (await dal.findSessionByProjectDir(userId, worktreePath)) as { id: string } | null
      if (existing) return existing.id
      const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex')
      const row = (await dal.createSession(userId, name, worktreePath, tokenHash, 'claude', false, hostname)) as { id: string }
      return row.id
    },
    ticket: (fingerprint, text) => {
      void import('../agentautofix/reporter.ts')
        .then((m) => m.reportSelfErrorToAgentautofix({ fingerprint, errorType: 'CorchMemlogUnavailable', errorValue: text, source: 'corch' }))
        .catch(() => {})
    },
  }
}
