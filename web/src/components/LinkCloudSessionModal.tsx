import { useState } from 'react'

interface Props {
  onLink: (cloudSessionId: string, name?: string) => Promise<{ ok: boolean; session_id?: string; error?: string }>
  onLinked: (sessionId: string) => void
  onClose: () => void
}

/**
 * Link a claude.ai cloud session (cse_… id or claude.ai/code URL) so remo can
 * chat with it while it keeps running in the cloud. Replies need the remo Stop
 * hook installed in that repo — see docs/cloud-sessions.md.
 */
export function LinkCloudSessionModal({ onLink, onLinked, onClose }: Props) {
  const [cloudId, setCloudId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cloudId.trim() || busy) return
    setBusy(true)
    setError(null)
    const r = await onLink(cloudId.trim(), name.trim() || undefined)
    setBusy(false)
    if (r.ok && r.session_id) {
      onLinked(r.session_id)
      onClose()
    } else {
      setError(r.error === 'invalid_cloud_session_id'
        ? 'That is not a cloud session id or claude.ai/code link.'
        : `Could not link (${r.error ?? 'unknown'}).`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <form
        onSubmit={submit}
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl ring-1 ring-white/5 max-w-lg w-full p-6 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-[var(--text-primary)]">Link cloud session</h2>
          <button type="button" onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
        </div>
        <p className="text-[var(--text-muted)] text-sm">
          Paste a claude.ai cloud session link or id. Messages you send here are queued into that session; its
          replies show up here once the remo Stop hook is installed in the repo.
        </p>
        <label className="block text-sm text-[var(--text-secondary)]">
          Session link or id
          <input
            autoFocus
            value={cloudId}
            onChange={(e) => setCloudId(e.target.value)}
            placeholder="https://claude.ai/code/session_… or cse_…"
            className="mt-1 w-full rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] px-3 py-2 text-sm text-[var(--text-primary)] font-mono"
          />
        </label>
        <label className="block text-sm text-[var(--text-secondary)]">
          Name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="mt-1 w-full rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !cloudId.trim()}
            className="px-3 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {busy ? 'Linking…' : 'Link'}
          </button>
        </div>
      </form>
    </div>
  )
}
