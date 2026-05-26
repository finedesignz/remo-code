import { useEffect, useState } from 'react'

export interface CommandRow {
  id: string
  supervisor_id: string
  kind: 'command' | 'skill'
  name: string
  description: string | null
  source: string  // 'builtin' | 'user' | 'plugin:<name>'
  path: string
  synced_at: string
}

export interface CommandGroup {
  key: string
  label: string
  items: CommandRow[]
}

const hubUrl: string = (import.meta as any).env?.VITE_HUB_URL || ''

export function useCommands(token: string | null) {
  const [rows, setRows] = useState<CommandRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refetch = () => {
    if (!token) return
    setLoading(true)
    fetch(`${hubUrl}/api/commands`, { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { setRows(d.commands || []); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refetch() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token])

  return { rows, loading, error, refetch }
}

export function groupCommands(rows: CommandRow[]): CommandGroup[] {
  const builtins: CommandRow[] = []
  const skills: CommandRow[] = []
  const byPlugin = new Map<string, CommandRow[]>()
  const userCmds: CommandRow[] = []

  // De-dupe by kind+name+source (multiple supervisors may sync the same set)
  const seen = new Set<string>()
  for (const r of rows) {
    const key = `${r.kind}:${r.name}:${r.source}`
    if (seen.has(key)) continue
    seen.add(key)
    if (r.kind === 'skill') { skills.push(r); continue }
    if (r.source === 'builtin') { builtins.push(r); continue }
    if (r.source === 'user') { userCmds.push(r); continue }
    if (r.source.startsWith('plugin:')) {
      const p = r.source.slice('plugin:'.length)
      const arr = byPlugin.get(p) || []
      arr.push(r)
      byPlugin.set(p, arr)
      continue
    }
    userCmds.push(r)
  }

  const groups: CommandGroup[] = []
  if (builtins.length) groups.push({ key: 'builtin', label: 'Built-in', items: sortByName(builtins) })
  if (userCmds.length) groups.push({ key: 'user', label: 'User commands', items: sortByName(userCmds) })
  for (const [p, items] of [...byPlugin.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ key: `plugin:${p}`, label: `Plugin: ${p}`, items: sortByName(items) })
  }
  if (skills.length) groups.push({ key: 'skills', label: 'Skills', items: sortByName(skills) })
  return groups
}

function sortByName(arr: CommandRow[]): CommandRow[] {
  return [...arr].sort((a, b) => a.name.localeCompare(b.name))
}

export function filterCommands(rows: CommandRow[], q: string): CommandRow[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) =>
    r.name.toLowerCase().includes(needle) ||
    (r.description || '').toLowerCase().includes(needle) ||
    r.source.toLowerCase().includes(needle)
  )
}
