import { useEffect, useState } from 'react'
import type { ErrorProject, ErrorProjectCreateInput } from '../hooks/useErrorProjects'
import { useSessions } from '../hooks/useSessions'
import { HubFetchError } from '../lib/api'

interface Props {
  token: string
  existing: ErrorProject | null
  onClose: () => void
  onSave: (data: ErrorProjectCreateInput, id?: string) => Promise<ErrorProject>
}

export function ErrorProjectEditor({ token, existing, onClose, onSave }: Props) {
  const { sessions } = useSessions(token)
  const [name, setName] = useState(existing?.name ?? '')
  const [sessionId, setSessionId] = useState<string>(existing?.session_id ?? '')
  const [dedupeWindow, setDedupeWindow] = useState<number>(existing?.dedupe_window_seconds ?? 60)
  const [rateLimit, setRateLimit] = useState<number>(existing?.rate_limit_per_hour ?? 20)
  const [dailyCap, setDailyCap] = useState<number>(existing?.daily_dispatch_cap ?? 50)
  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedProject, setSavedProject] = useState<ErrorProject | null>(existing)

  // Auto-pick first session for new projects when sessions load.
  useEffect(() => {
    if (!existing && !sessionId && sessions.length > 0) {
      setSessionId(sessions[0].id)
    }
  }, [existing, sessionId, sessions])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    if (!name.trim() || !sessionId) {
      setError('Name and a target session are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const p = await onSave({
        name: name.trim(),
        session_id: sessionId,
        dedupe_window_seconds: dedupeWindow,
        rate_limit_per_hour: rateLimit,
        daily_dispatch_cap: dailyCap,
        enabled,
      }, existing?.id)
      setSavedProject(p)
      // On create, keep the modal open so the user can copy the DSN.
      if (!existing) {
        // leave open
      } else {
        onClose()
      }
    } catch (e: any) {
      setError(e instanceof HubFetchError ? e.message : (e?.message || 'save failed'))
    } finally {
      setSaving(false)
    }
  }

  const dsn = savedProject?.dsn ?? null
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!dsn) return
    try {
      await navigator.clipboard.writeText(dsn)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg bg-[var(--bg-secondary)] rounded-xl ring-1 ring-[var(--border-color)] shadow-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[var(--border-color)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {existing ? 'Edit project' : 'New error-capture project'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-app frontend"
              className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">Target session</label>
            <select
              value={sessionId}
              onChange={e => setSessionId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
            >
              <option value="">— Select a session —</option>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}{s.project_dir ? ` — ${s.project_dir}` : ''}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Captured errors are dispatched into this session as user messages.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Dedupe window (s)</label>
              <input
                type="number"
                min={0}
                value={dedupeWindow}
                onChange={e => setDedupeWindow(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Rate / hour</label>
              <input
                type="number"
                min={0}
                value={rateLimit}
                onChange={e => setRateLimit(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1.5">Daily cap</label>
              <input
                type="number"
                min={0}
                value={dailyCap}
                onChange={e => setDailyCap(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="rounded border-[var(--border-color)] bg-[var(--bg-tertiary)] text-indigo-600 focus:ring-indigo-500/40"
            />
            Enabled
          </label>

          {dsn && (
            <div className="rounded-lg bg-[var(--bg-primary)] p-3">
              <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">DSN</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2 py-1.5 text-xs rounded bg-[var(--code-bg)] text-[var(--text-primary)] font-mono break-all">
                  {dsn}
                </code>
                <button
                  onClick={copy}
                  className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] font-medium transition-colors shrink-0"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                Use this as the <code>dsn</code> in your Sentry SDK init.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-900/30 ring-1 ring-red-500/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]/60 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors"
          >
            {savedProject && !existing ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-[var(--text-on-accent)] font-medium transition-colors"
          >
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}
