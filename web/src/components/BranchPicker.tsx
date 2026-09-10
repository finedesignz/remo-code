import { useEffect, useRef, useState } from 'react'
import { hubFetch } from '../lib/api'

/**
 * Repo→branch picker, mirroring the Connect/Start session launch flow
 * (SupervisorPage `StartDialog`): a branch dropdown sourced from the live repo
 * with a "Custom branch name…" escape hatch to a free-text input.
 *
 * Where the launch dialog keys branches off a (supervisor, repo_path) pair, this
 * variant keys off a session — the scheduled-task editor already picks the repo
 * by choosing a target session, so we fetch that session's branches from
 * `GET /api/sessions/:id/branches` (same `repo.list_branches` source). When the
 * session has no resolvable branches (offline supervisor / legacy session) the
 * control degrades to a plain free-text input so the form is never blocked.
 *
 * Accent is BLUE (matches the launch dialog + app accent guard).
 */
interface Props {
  token: string
  /** The repo-bound target session. Null → render a disabled placeholder. */
  sessionId: string | null
  value: string
  onChange: (branch: string) => void
}

export function BranchPicker({ token, sessionId, value, onChange }: Props) {
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [customBranch, setCustomBranch] = useState(false)
  // Don't clobber a value the user (or an edited task) already chose: only
  // auto-select a default branch when the current value is empty.
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!sessionId || !token) {
      setBranches([])
      return
    }
    let cancelled = false
    setLoading(true)
    hubFetch<{ branches?: string[]; current?: string | null }>(
      token,
      `/api/sessions/${sessionId}/branches`,
    )
      .then((d) => {
        if (cancelled) return
        const list = Array.isArray(d?.branches) ? d.branches : []
        setBranches(list)
        if (list.length > 0) {
          const cur = valueRef.current
          if (!cur || !list.includes(cur)) {
            const preferred = d?.current && list.includes(d.current) ? d.current : list[0]
            onChange(preferred)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setBranches([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sessionId])

  const inputCls =
    'w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500'

  if (!sessionId) {
    return (
      <div className="px-3 py-2 text-sm text-[var(--text-muted)] bg-[var(--bg-primary)]/40 rounded-lg">
        Choose a session first to pick its branch.
      </div>
    )
  }

  if (branches.length > 0 && !customBranch) {
    return (
      <select
        value={branches.includes(value) ? value : branches[0]}
        onChange={(e) => {
          if (e.target.value === '__custom__') {
            setCustomBranch(true)
            return
          }
          onChange(e.target.value)
        }}
        className={inputCls}
      >
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
        <option value="__custom__">Custom branch name…</option>
      </select>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={loading ? 'Loading branches…' : 'main'}
        className={inputCls + ' flex-1'}
      />
      {branches.length > 0 && (
        <button
          type="button"
          onClick={() => setCustomBranch(false)}
          className="px-2 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 whitespace-nowrap"
        >
          Pick from list
        </button>
      )}
    </div>
  )
}

export default BranchPicker
