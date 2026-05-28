import { useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'

type OrchestratorSnapshot = {
  enabled: boolean
  name: string
  custom_instructions: string | null
  session_id: string | null
  status: 'disabled' | 'enabled_idle' | 'running'
}

export function OrchestratorTab({ token }: { token: string }) {
  const [snap, setSnap] = useState<OrchestratorSnapshot | null>(null)
  const [name, setName] = useState('Orchestrator')
  const [instructions, setInstructions] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showEnableModal, setShowEnableModal] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  async function refresh() {
    try {
      const r = await hubFetch<OrchestratorSnapshot>(token, '/api/orchestrator')
      setSnap(r)
      setName(r.name)
      setInstructions(r.custom_instructions ?? '')
    } catch (e: any) {
      setErr(e?.message ?? 'load failed')
    }
  }

  useEffect(() => { void refresh() }, [])

  async function patch(body: Partial<{ enabled: boolean; name: string; custom_instructions: string | null }>) {
    setBusy(true); setErr(null)
    try {
      const r = await hubFetch<OrchestratorSnapshot>(token, '/api/orchestrator', { method: 'PUT', json: body })
      setSnap(r)
      setName(r.name)
      setInstructions(r.custom_instructions ?? '')
      setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200)
    } catch (e: any) {
      setErr(e?.message ?? 'save failed')
    } finally {
      setBusy(false)
    }
  }

  async function start() {
    setBusy(true); setErr(null)
    try {
      await hubFetch(token, '/api/orchestrator/start', { method: 'POST', json: {} })
      await refresh()
    } catch (e: any) {
      setErr(e?.message ?? 'start failed')
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true); setErr(null)
    try {
      await hubFetch(token, '/api/orchestrator/stop', { method: 'POST', json: {} })
      await refresh()
    } catch (e: any) {
      setErr(e?.message ?? 'stop failed')
    } finally {
      setBusy(false)
    }
  }

  if (!snap) {
    return <div className="text-sm text-[var(--text-muted)]">Loading…</div>
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="rounded-xl bg-[var(--bg-secondary)]/60 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Orchestrator session</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
              A pinned Claude session that runs in your repos parent folder and is taught how to read state from
              and coordinate your other Claude sessions via the hub API.
            </p>
          </div>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded font-semibold shrink-0 ${
            snap.status === 'running' ? 'bg-emerald-500/20 text-emerald-300'
            : snap.status === 'enabled_idle' ? 'bg-indigo-500/20 text-indigo-300'
            : 'bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]'
          }`}>{snap.status === 'running' ? 'Running' : snap.status === 'enabled_idle' ? 'Idle' : 'Disabled'}</span>
        </div>

        <div className="flex items-center gap-3">
          <button
            disabled={busy}
            onClick={() => {
              if (snap.enabled) void patch({ enabled: false })
              else setShowEnableModal(true)
            }}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
              snap.enabled
                ? 'bg-[var(--bg-tertiary)]/80 text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                : 'bg-indigo-600 text-white hover:bg-indigo-500'
            }`}
          >
            {snap.enabled ? 'Disable orchestrator' : 'Enable orchestrator'}
          </button>
          {snap.enabled && snap.status !== 'running' && (
            <button
              disabled={busy}
              onClick={start}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Start orchestrator session
            </button>
          )}
          {snap.status === 'running' && (
            <button
              disabled={busy}
              onClick={stop}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-red-600/80 text-white hover:bg-red-500 disabled:opacity-50"
            >
              Stop session
            </button>
          )}
          {savedFlash && <span className="text-[11px] text-emerald-400">Saved</span>}
        </div>

        {snap.enabled && (
          <div className="space-y-3 pt-2 border-t border-[var(--border-color)]">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (name.trim() && name !== snap.name) void patch({ name: name.trim() }) }}
                placeholder="Orchestrator"
                maxLength={64}
                className="w-full bg-[var(--bg-tertiary)]/60 text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Custom instructions (appended to the built-in seed)</label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onBlur={() => { if (instructions !== (snap.custom_instructions ?? '')) void patch({ custom_instructions: instructions || null }) }}
                rows={10}
                maxLength={8000}
                placeholder="e.g. Always summarize the state of all repos before suggesting next actions."
                className="w-full bg-[var(--bg-tertiary)]/60 text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>
          </div>
        )}

        {err && <div className="text-xs text-red-400">{err}</div>}
      </div>

      {showEnableModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowEnableModal(false)}>
          <div className="max-w-md w-full rounded-xl bg-[var(--bg-secondary)] ring-1 ring-red-500/40 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Enable orchestrator mode?</h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Orchestrator mode gives one Claude session full access to <strong>every repo</strong> under your supervisor's root folder,
              plus a full-power hub API key that can read messages, start sessions, and dispatch tasks for your account.
              Only enable if you trust the system prompt and your machine is secure.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowEnableModal(false)}
                className="px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/60"
              >Cancel</button>
              <button
                onClick={async () => { setShowEnableModal(false); await patch({ enabled: true }) }}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500"
              >Enable orchestrator</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
