import type { ServerWebSocket } from 'bun'
import type { HubToSupervisor } from './supervisor-protocol'
import { broadcastToUser } from './registry'
import { setSupervisorState, touchSupervisor, listSupervisorsForUser } from '../db/supervisor-dal'

/**
 * Bug A (2026-05-28) — supervisor's live runner set, pushed every ~10s via
 * the `session_inventory` agent-protocol message. Memory-only by design;
 * cleared on supervisor disconnect. `GET /api/sessions` folds this into each
 * row's `active` flag so the UI list shows sessions the supervisor is
 * actually hosting, independent of the per-bridge `sessions.status` column.
 */
export interface SessionInventoryEntry {
  session_id: string
  cli_kind: 'claude' | 'codex'
  project_dir: string
  pid: number | null
  started_at: string
  last_activity_at: string | null
  status: 'spawning' | 'running' | 'idle' | 'stopping'
}

interface SupervisorEntry {
  ws: ServerWebSocket<any>
  supervisorId: string
  userId: string
  apiKeyId: string
  state: string
  roots: string[]
  /** Phase 08 §15 — needed by the `supervisor.repo_inventory` handler when
   * upserting `pending_local_repos(user_id, hostname, project_dir)` rows. */
  hostname: string
  /** Bug A — most recent session_inventory push. Empty when supervisor
   *  hasn't sent one yet (pre-0.5.7 supervisor). */
  sessionInventory: SessionInventoryEntry[]
  sessionInventoryAt: string | null
  pendingReqs: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>
}

const supervisors = new Map<string, SupervisorEntry>() // supervisorId -> entry
const supervisorsByApiKey = new Map<string, string>()   // apiKeyId -> supervisorId

// ── Phase 08 §15/§16 — per-user inventory cache ────────────────────────────
// The most recent SupervisorRepoInventory the supervisor has uploaded, keyed
// by userId. Plan 005 reads this to resolve a session's canonical local_path
// at launch time and to suggest `clone-here` targets. Memory-only by design
// (matches §6 in-memory job state). Lost on hub restart → supervisor re-emits
// inventory on next connect.
export interface InventoryRepoEntry {
  local_path: string
  is_git_repo: boolean
  is_worktree: boolean
  worktree_parent_path: string | null
  git_remote: string | null
  git_origin_github: { owner: string; repo: string } | null
  /** Current branch on disk (null when detached / unknown / pre-0.5 supervisor). */
  branch?: string | null
  canonical?: boolean
}

/** One known local working tree for a given repo_key. */
export interface KnownLocalPath {
  local_path: string
  branch: string | null
  is_worktree: boolean
  canonical: boolean
}
export interface UserInventory {
  scanned_at: string
  supervisor_id: string
  repos: InventoryRepoEntry[]
  roots: string[]
}
const inventoryByUser = new Map<string, UserInventory>()

export function setUserInventory(userId: string, inv: UserInventory) {
  inventoryByUser.set(userId, inv)
}
export function getUserInventory(userId: string): UserInventory | undefined {
  return inventoryByUser.get(userId)
}
/**
 * Look up the canonical local path the supervisor has reported for a given
 * `repo_key` (`github://owner/repo`). Returns null when the supervisor hasn't
 * reported the repo OR has reported it but the entry was never marked
 * canonical (worktree-only with no parent on disk).
 */
export function resolveLocalPathForRepoKey(userId: string, repoKey: string): string | null {
  const inv = inventoryByUser.get(userId)
  if (!inv) return null
  const target = repoKey.toLowerCase()
  // Prefer entries explicitly flagged canonical; fall back to first matching.
  const matches = inv.repos.filter((r) => {
    if (!r.git_origin_github) return false
    const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
    return k === target
  })
  if (matches.length === 0) return null
  const canonical = matches.find((m) => m.canonical)
  return (canonical ?? matches[0]).local_path
}

/**
 * Return every known local working tree for a repo_key — used to populate the
 * Sidebar Launch dropdown so the user picks WHICH worktree/branch to run.
 *
 * Capped at MAX_KNOWN_LOCAL_PATHS to keep the UI bounded; the canonical entry
 * is always first when present.
 */
const MAX_KNOWN_LOCAL_PATHS = 20
export function getKnownLocalPathsForRepoKey(userId: string, repoKey: string): KnownLocalPath[] {
  const inv = inventoryByUser.get(userId)
  if (!inv) return []
  const target = repoKey.toLowerCase()
  const matches = inv.repos.filter((r) => {
    if (!r.git_origin_github) return false
    const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
    return k === target
  })
  if (matches.length === 0) return []
  const sorted = [...matches].sort((a, b) => {
    // canonical first, then non-worktree, then shorter path.
    const ac = a.canonical ? 0 : 1
    const bc = b.canonical ? 0 : 1
    if (ac !== bc) return ac - bc
    const aw = a.is_worktree ? 1 : 0
    const bw = b.is_worktree ? 1 : 0
    if (aw !== bw) return aw - bw
    return a.local_path.length - b.local_path.length
  })
  return sorted.slice(0, MAX_KNOWN_LOCAL_PATHS).map((r) => ({
    local_path: r.local_path,
    branch: r.branch ?? null,
    is_worktree: r.is_worktree,
    canonical: !!r.canonical,
  }))
}

export function registerSupervisor(args: {
  ws: ServerWebSocket<any>
  supervisorId: string
  userId: string
  apiKeyId: string
  roots: string[]
  hostname?: string
}): SupervisorEntry {
  // Replace any existing
  const existing = supervisorsByApiKey.get(args.apiKeyId)
  if (existing) {
    const e = supervisors.get(existing)
    if (e && e.ws !== args.ws) {
      // Drain pending requests BEFORE closing the old socket so callers see a
      // structured rejection instead of an unresolved timeout. Each pending
      // entry owns its own setTimeout that must be cleared first.
      for (const [, p] of e.pendingReqs) {
        clearTimeout(p.timer)
        p.reject(new Error('supervisor_replaced'))
      }
      e.pendingReqs.clear()
      try { e.ws.close(4003, 'replaced') } catch {}
    }
  }
  const entry: SupervisorEntry = {
    ws: args.ws,
    supervisorId: args.supervisorId,
    userId: args.userId,
    apiKeyId: args.apiKeyId,
    state: 'idle',
    roots: args.roots,
    hostname: args.hostname ?? '',
    sessionInventory: [],
    sessionInventoryAt: null,
    pendingReqs: new Map(),
  }
  supervisors.set(args.supervisorId, entry)
  supervisorsByApiKey.set(args.apiKeyId, args.supervisorId)
  return entry
}

export function unregisterSupervisor(supervisorId: string, ws?: ServerWebSocket<any>) {
  const entry = supervisors.get(supervisorId)
  if (!entry) return
  // Reconnect-race guard: when a supervisor reconnects, `registerSupervisor`
  // closes the prior socket. That close fires `handleAgentClose` →
  // `unregisterSupervisor` AFTER the new entry has already replaced the old
  // one in the map. If we unconditionally deleted by supervisorId, the stale
  // close would wipe the live entry, leaving the supervisor invisible to the
  // in-memory registry (`isSupervisorOnline` → false) even though the new WS
  // is fully connected and serving traffic. Compare ws identity so only the
  // *current* socket's close clears the entry.
  if (ws && entry.ws !== ws) return
  for (const [, p] of entry.pendingReqs) {
    clearTimeout(p.timer)
    p.reject(new Error('supervisor disconnected'))
  }
  supervisors.delete(supervisorId)
  supervisorsByApiKey.delete(entry.apiKeyId)
  setSupervisorState(supervisorId, 'offline').catch(() => {})
  broadcastToUser(entry.userId, { type: 'supervisor_update', supervisor_id: supervisorId, state: 'offline' })
}

export function getSupervisor(supervisorId: string) {
  return supervisors.get(supervisorId)
}

export function getSupervisorByApiKey(apiKeyId: string) {
  const id = supervisorsByApiKey.get(apiKeyId)
  return id ? supervisors.get(id) : undefined
}

export function isSupervisorOnline(supervisorId: string) {
  return supervisors.has(supervisorId)
}

export function listOnlineSupervisorIdsForUser(userId: string): string[] {
  const out: string[] = []
  for (const [id, e] of supervisors) if (e.userId === userId) out.push(id)
  return out
}

/**
 * v0.5.4 — push a rotated API key to every supervisor socket owned by this
 * user. Ownership is verified via the in-memory entry's `userId`, which is
 * written from the authenticated `auth` payload — only sockets that proved
 * ownership of `userId` at connect time receive the new plaintext. Returns
 * the number of sockets the message was delivered to. Best-effort: per-socket
 * send errors are swallowed (offline / closing supervisors will reconnect
 * with the old key and silently fail auth → user re-pastes through the UI).
 */
export function pushKeyRotatedToUser(userId: string, newApiKey: string, keyId: string): number {
  let delivered = 0
  for (const [, e] of supervisors) {
    if (e.userId !== userId) continue
    try {
      e.ws.send(JSON.stringify({ type: 'key_rotated', new_api_key: newApiKey, key_id: keyId }))
      delivered++
    } catch {}
  }
  return delivered
}

let reqCounter = 0
function nextReqId() { return `req_${Date.now()}_${++reqCounter}` }

// Send a request and wait for matching op_result (by req_id).
export function sendRequest<T = any>(supervisorId: string, msg: Omit<HubToSupervisor, 'req_id'> & { req_id?: string }, timeoutMs = 30_000): Promise<T> {
  const entry = supervisors.get(supervisorId)
  if (!entry) return Promise.reject(new Error('supervisor offline'))
  const req_id = msg.req_id || nextReqId()
  const full = { ...msg, req_id }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pendingReqs.delete(req_id)
      reject(new Error('supervisor request timed out'))
    }, timeoutMs)
    entry.pendingReqs.set(req_id, { resolve, reject, timer })
    try {
      entry.ws.send(JSON.stringify(full))
    } catch (err) {
      clearTimeout(timer)
      entry.pendingReqs.delete(req_id)
      reject(err)
    }
  })
}

// Send fire-and-forget (no response expected)
export function sendToSupervisor(supervisorId: string, msg: HubToSupervisor) {
  const entry = supervisors.get(supervisorId)
  if (!entry) throw new Error('supervisor offline')
  entry.ws.send(JSON.stringify(msg))
}

// Resolve a pending request when supervisor sends a matching response
export function resolveRequest(supervisorId: string, reqId: string, payload: any) {
  const entry = supervisors.get(supervisorId)
  if (!entry) return false
  const p = entry.pendingReqs.get(reqId)
  if (!p) return false
  clearTimeout(p.timer)
  entry.pendingReqs.delete(reqId)
  p.resolve(payload)
  return true
}

export function rejectRequest(supervisorId: string, reqId: string, error: string) {
  const entry = supervisors.get(supervisorId)
  if (!entry) return false
  const p = entry.pendingReqs.get(reqId)
  if (!p) return false
  clearTimeout(p.timer)
  entry.pendingReqs.delete(reqId)
  p.reject(new Error(error))
  return true
}

// Update local state cache; persist to DB; push to user's browser clients.
export async function updateSupervisorState(supervisorId: string, state: string, currentRunId: string | null) {
  const entry = supervisors.get(supervisorId)
  if (entry) entry.state = state
  await setSupervisorState(supervisorId, state, currentRunId)
  if (entry) {
    broadcastToUser(entry.userId, {
      type: 'supervisor_update',
      supervisor_id: supervisorId,
      state,
      current_run_id: currentRunId,
    })
  }
}

export async function heartbeatSupervisor(supervisorId: string) {
  await touchSupervisor(supervisorId)
}

// ── Bug A (2026-05-28) — session_inventory storage + lookup ───────────────────

/**
 * Replace the cached session_inventory for a supervisor. Returns the set of
 * session_ids that changed (added, removed, or status-transitioned) vs. the
 * previous snapshot so callers can emit a targeted `session_inventory_changed`
 * broadcast instead of fanning every push at every subscriber.
 */
export function setSupervisorSessionInventory(
  supervisorId: string,
  sessions: SessionInventoryEntry[],
  scannedAt: string,
): { changedSessionIds: string[]; userId: string | null } {
  const entry = supervisors.get(supervisorId)
  if (!entry) return { changedSessionIds: [], userId: null }
  const prev = new Map(entry.sessionInventory.map((s) => [s.session_id, s] as const))
  const next = new Map(sessions.map((s) => [s.session_id, s] as const))
  const changed = new Set<string>()
  for (const [sid, s] of next) {
    const before = prev.get(sid)
    if (!before || before.status !== s.status || before.pid !== s.pid) changed.add(sid)
  }
  for (const sid of prev.keys()) {
    if (!next.has(sid)) changed.add(sid)
  }
  entry.sessionInventory = sessions
  entry.sessionInventoryAt = scannedAt
  return { changedSessionIds: Array.from(changed), userId: entry.userId }
}

/**
 * Set of session_ids currently reported as live by any of the user's online
 * supervisors. Used by `GET /api/sessions` to mark rows `active=true`.
 */
export function getActiveSessionIdsForUser(userId: string): Set<string> {
  const out = new Set<string>()
  for (const [, e] of supervisors) {
    if (e.userId !== userId) continue
    for (const s of e.sessionInventory) out.add(s.session_id)
  }
  return out
}

/**
 * Look up which supervisor (if any) is currently hosting a given session id.
 * Used by the idle-teardown path to route `session.stop`/`shutdown` to the
 * owning supervisor when subscriber count drops to zero.
 */
export function findSupervisorForSession(sessionId: string): { supervisorId: string; userId: string } | null {
  for (const [supId, e] of supervisors) {
    if (e.sessionInventory.some((s) => s.session_id === sessionId)) {
      return { supervisorId: supId, userId: e.userId }
    }
  }
  return null
}

export { listSupervisorsForUser }
