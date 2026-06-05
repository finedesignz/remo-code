/**
 * Groups manager — CRUD + reorder (up/down buttons) + bulk membership.
 * Rendered in a Drawer (full-screen on mobile, right panel on desktop) so the
 * same surface works for touch + pointer. Opened from the Connections toolbar
 * "Groups" button. Accent = blue; icon-only row actions with title tooltips.
 */
import { useState } from 'react'
import { Drawer, Button } from '../ui'
import type { UseRepoGroups } from '../../hooks/useRepoGroups'

interface RepoChoice {
  ident: string
  label: string
}

export function GroupsManager({
  open,
  onClose,
  groupsApi,
  /** All groupable repos in the current Connections view (for bulk membership). */
  repoChoices,
}: {
  open: boolean
  onClose: () => void
  groupsApi: UseRepoGroups
  repoChoices: RepoChoice[]
}) {
  const { groups, createGroup, renameGroup, deleteGroup, moveGroup, replaceMembers } = groupsApi
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [membershipFor, setMembershipFor] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e: any) {
      setErr(e?.message ?? 'action failed')
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    await run(async () => {
      await createGroup(name)
      setNewName('')
    })
  }

  return (
    <Drawer open={open} onClose={onClose} title="Groups" width="420px">
      <div className="space-y-3">
        {err && <div className="px-3 py-2 bg-red-900/30 rounded-lg text-xs text-red-200">{err}</div>}

        {/* New group */}
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate() }}
            placeholder="New group name…"
            maxLength={64}
            className="flex-1 min-w-0 px-3 py-1.5 text-sm bg-[var(--bg-tertiary)]/40 rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          <Button variant="primary" size="sm" disabled={busy || !newName.trim()} onClick={() => void handleCreate()}>
            Add
          </Button>
        </div>

        {/* Group list */}
        {groups.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)] py-6 text-center">
            No groups yet. Create one to start organizing repos.
          </p>
        ) : (
          <ul className="space-y-1">
            {groups.map((g, i) => {
              const editing = editingId === g.id
              const confirming = confirmDeleteId === g.id
              return (
                <li key={g.id} className="rounded-lg bg-[var(--bg-tertiary)]/30">
                  <div className="flex items-center gap-1.5 px-2 py-1.5">
                    {/* Reorder */}
                    <div className="flex flex-col">
                      <button
                        type="button"
                        disabled={i === 0 || busy}
                        onClick={() => void run(() => moveGroup(g.id, -1))}
                        title="Move up"
                        aria-label={`Move ${g.name} up`}
                        className="text-[var(--text-muted)] hover:text-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
                      </button>
                      <button
                        type="button"
                        disabled={i === groups.length - 1 || busy}
                        onClick={() => void run(() => moveGroup(g.id, 1))}
                        title="Move down"
                        aria-label={`Move ${g.name} down`}
                        className="text-[var(--text-muted)] hover:text-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                      </button>
                    </div>

                    {/* Name (click to rename) */}
                    {editing ? (
                      <input
                        autoFocus
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void run(async () => { await renameGroup(g.id, editName.trim()); setEditingId(null) })
                          } else if (e.key === 'Escape') setEditingId(null)
                        }}
                        onBlur={() => {
                          const name = editName.trim()
                          if (name && name !== g.name) void run(async () => { await renameGroup(g.id, name); setEditingId(null) })
                          else setEditingId(null)
                        }}
                        maxLength={64}
                        className="flex-1 min-w-0 px-2 py-1 text-sm bg-[var(--bg-primary)]/60 rounded text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingId(g.id); setEditName(g.name) }}
                        title="Rename"
                        className="flex-1 min-w-0 text-left text-sm text-[var(--text-primary)] truncate hover:text-blue-300"
                      >
                        {g.name}
                        <span className="ml-1.5 text-[10px] text-[var(--text-muted)] tabular-nums">{g.members.length}</span>
                      </button>
                    )}

                    {/* Edit membership */}
                    <button
                      type="button"
                      onClick={() => setMembershipFor(membershipFor === g.id ? null : g.id)}
                      title="Edit which repos are in this group"
                      aria-label={`Edit repos in ${g.name}`}
                      className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-blue-300 hover:bg-blue-500/10"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2 11.5V14h2.5l7-7L9 4.5z" /><path d="M9 4.5L11.5 7" /></svg>
                    </button>

                    {/* Delete */}
                    {confirming ? (
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void run(async () => { await deleteGroup(g.id); setConfirmDeleteId(null) })}
                          className="px-1.5 py-1 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 rounded"
                        >
                          Delete
                        </button>
                        <button type="button" onClick={() => setConfirmDeleteId(null)} className="px-1.5 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(g.id)}
                        title="Delete group"
                        aria-label={`Delete ${g.name}`}
                        className="p-1.5 rounded-md text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4" /></svg>
                      </button>
                    )}
                  </div>

                  {/* Bulk membership checklist */}
                  {membershipFor === g.id && (
                    <MembershipEditor
                      group={g}
                      repoChoices={repoChoices}
                      busy={busy}
                      onReplace={(idents) => run(() => replaceMembers(g.id, idents))}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Drawer>
  )
}

function MembershipEditor({
  group,
  repoChoices,
  busy,
  onReplace,
}: {
  group: { members: { repo_ident: string }[] }
  repoChoices: RepoChoice[]
  busy: boolean
  onReplace: (idents: string[]) => Promise<void> | void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(group.members.map((m) => m.repo_ident)))
  const [q, setQ] = useState('')
  const filtered = q.trim()
    ? repoChoices.filter((r) => r.label.toLowerCase().includes(q.toLowerCase()))
    : repoChoices

  const toggle = (ident: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(ident)) next.delete(ident)
      else next.add(ident)
      return next
    })

  return (
    <div className="border-t border-[var(--border-color)]/40 px-2 py-2 space-y-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter repos…"
        className="w-full px-2 py-1 text-xs bg-[var(--bg-primary)]/60 rounded text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
      />
      <div className="max-h-44 overflow-y-auto space-y-0.5">
        {filtered.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)] py-2 text-center">No repos.</p>
        ) : (
          filtered.map((r) => (
            <label key={r.ident} className="flex items-center gap-2 px-1.5 py-1 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(r.ident)}
                onChange={() => toggle(r.ident)}
                className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
              />
              <span className="truncate" title={r.label}>{r.label}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void onReplace(Array.from(selected))}>
          Save members
        </Button>
      </div>
    </div>
  )
}
