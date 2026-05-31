/**
 * Shared session-list selector — the SINGLE source of truth for how the repo /
 * session list is derived across every surface (sidebar, grid Default tab,
 * settings Connections, session pickers/dropdowns).
 *
 * Two regressions this fixes, in one place so they can't drift per-surface:
 *
 *  1. Worktree collapse. remo-code only ever connects to the MAIN clone of a
 *     GitHub repo, never its git worktrees. `GET /api/sessions` returns one row
 *     per `repo_key` but ALSO carries every known `local_paths[]` (incl.
 *     worktrees) purely to feed the Launch path-picker. Surfaces must therefore
 *     key/dedupe by `repo_key` and never render a suffixed worktree dir
 *     (`…/<repo>-<slug>`) as its own entry. Sessions with a null `repo_key`
 *     (legacy/local-only) fall back to keying by session id.
 *
 *  2. Connected-first ordering. Online (online/thinking, or the supervisor
 *     `active` flag) sessions sort above offline ones, with a stable secondary
 *     sort by display label.
 *
 * Mirrors the hub's canonical-path intent in
 * `hub/src/ws/supervisor-registry.ts` (prefer `canonical && !is_worktree`,
 * never a worktree dir).
 */
import type { CodeSession } from '../hooks/useSessions'

/** A session is "connected"/online when the supervisor hosts it. */
export function isSessionOnline(s: Pick<CodeSession, 'status' | 'active'>): boolean {
  return s.status === 'online' || s.status === 'thinking' || s.active === true
}

/** True when a path looks like a git worktree dir (`…/<repo>-<slug>`), never the clone. */
function pathIsWorktree(s: CodeSession): boolean {
  if (!s.project_dir) return false
  const lp = (s.local_paths ?? []).find((p) => p.local_path === s.project_dir)
  if (lp) return lp.is_worktree && !lp.canonical
  return false
}

/** Prefer the session whose cwd is the canonical (non-worktree) checkout. */
function preferCanonical(a: CodeSession, b: CodeSession): CodeSession {
  const aw = pathIsWorktree(a)
  const bw = pathIsWorktree(b)
  if (aw !== bw) return aw ? b : a
  // Both same worktree-ness → keep the most-recently-active.
  const at = a.last_activity ? Date.parse(a.last_activity) : 0
  const bt = b.last_activity ? Date.parse(b.last_activity) : 0
  return bt > at ? b : a
}

/**
 * Collapse worktree/duplicate rows: one entry per `repo_key`, preferring the
 * canonical (non-worktree) session. Sessions with no `repo_key` are kept as-is,
 * keyed by id. Order of first appearance is otherwise preserved.
 */
export function collapseWorktrees(sessions: CodeSession[]): CodeSession[] {
  const list = Array.isArray(sessions) ? sessions : []
  const byKey = new Map<string, CodeSession>()
  const order: string[] = []
  for (const s of list) {
    const key = s.repo_key ? `repo:${s.repo_key}` : `id:${s.id}`
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, s)
      order.push(key)
    } else {
      byKey.set(key, preferCanonical(prev, s))
    }
  }
  return order.map((k) => byKey.get(k)!)
}

/** Display label for sort/title — owner/repo when GitHub-keyed, else folder/name. */
export function sessionDisplayLabel(s: CodeSession): string {
  if (s.github_owner && s.github_repo) return `${s.github_owner}/${s.github_repo}`
  if (s.project_dir) {
    const folder = s.project_dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (folder) return folder
  }
  return s.name
}

/** Online (connected) sessions first, then offline; stable secondary sort by label. */
export function sortConnectedFirst(sessions: CodeSession[]): CodeSession[] {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((a, b) => {
    const ao = isSessionOnline(a) ? 0 : 1
    const bo = isSessionOnline(b) ? 0 : 1
    if (ao !== bo) return ao - bo
    return sessionDisplayLabel(a).localeCompare(sessionDisplayLabel(b))
  })
}

/**
 * The canonical derived repo/session list every surface should render:
 * worktrees collapsed by repo_key, then connected-first + label-sorted, then
 * the orchestrator session (if any) pinned to the very top.
 */
export function repoSessionList(sessions: CodeSession[]): CodeSession[] {
  const collapsed = collapseWorktrees(sessions)
  const sorted = sortConnectedFirst(collapsed)
  const orchIdx = sorted.findIndex((s) => s.is_orchestrator)
  if (orchIdx <= 0) return sorted
  const orch = sorted[orchIdx]
  return [orch, ...sorted.filter((_, i) => i !== orchIdx)]
}
