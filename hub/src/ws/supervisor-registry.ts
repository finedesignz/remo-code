import type { ServerWebSocket } from 'bun'
import type { HubToSupervisor } from './supervisor-protocol'
import { broadcastToUser } from './registry'
import { setSupervisorState, touchSupervisor, listSupervisorsForUser } from '../db/supervisor-dal'

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
  canonical?: boolean
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

export { listSupervisorsForUser }
