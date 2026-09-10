import { useMemo, useState } from 'react'
import { useSessions } from '../hooks/useSessions'
import { sessionRepoIdent, sessionDisplayLabel } from '../lib/session-list'

/**
 * Milestone TEAB — repo picker for a `teab` build task. Mirrors the Connect
 * repo→session flow: the selectable repos are exactly the user's connected
 * sessions (deduped by `repo_ident`), reusing `useSessions` + the shared
 * `session-list` repo helpers. The chosen value is the canonical `repo_ident`
 * string (`github://owner/repo` or `path://<abs>`) persisted as
 * `teab_repo_ident`. A custom-entry escape hatch covers a repo with no live
 * session (e.g. before its first Connect).
 */
const CUSTOM = '__custom__'

const selectCls =
  'w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-orange-500'
const inputCls =
  'w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-orange-500'

export function TeabRepoPicker({
  token,
  value,
  onChange,
}: {
  token: string
  value: string
  onChange: (v: string) => void
}) {
  const { sessions } = useSessions(token)

  const options = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of Array.isArray(sessions) ? sessions : []) {
      const ident = sessionRepoIdent(s)
      if (!ident) continue
      if (!map.has(ident)) map.set(ident, sessionDisplayLabel(s))
    }
    return [...map.entries()]
      .map(([ident, label]) => ({ ident, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }, [sessions])

  const knownIdent = options.some((o) => o.ident === value)
  // Start in custom mode when an existing value isn't one of the listed repos.
  const [mode, setMode] = useState<'select' | 'custom'>(
    value && !knownIdent ? 'custom' : 'select',
  )

  return (
    <div className="space-y-2">
      <select
        value={mode === 'custom' ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setMode('custom')
          } else {
            setMode('select')
            onChange(e.target.value)
          }
        }}
        className={selectCls}
      >
        <option value="">Choose a repo…</option>
        {options.map((o) => (
          <option key={o.ident} value={o.ident}>
            {o.label} — {o.ident}
          </option>
        ))}
        <option value={CUSTOM}>Other (enter repo path / ident)…</option>
      </select>
      {mode === 'custom' && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="github://owner/repo or path://C:\path\to\repo"
          className={inputCls}
        />
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Same repos as the Connect screen — TEAB runs <code>teab run --repo</code> on the
        supervisor host that owns this repo.
      </p>
    </div>
  )
}
