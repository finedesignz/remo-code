import { useState, useEffect } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useAdmin, type AdminUser } from '../hooks/useAdmin'

interface Props {
  session: Session
  onBack: () => void
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
    </div>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    free: 'bg-slate-600 text-slate-200',
    pro: 'bg-indigo-600/30 text-indigo-300 ring-1 ring-indigo-500/40',
    max: 'bg-amber-600/30 text-amber-300 ring-1 ring-amber-500/40',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colors[tier] || colors.free}`}>
      {tier}
    </span>
  )
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-purple-600/30 text-purple-300 ring-1 ring-purple-500/40',
    user: 'bg-slate-600/30 text-slate-300',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colors[role] || colors.user}`}>
      {role}
    </span>
  )
}

type SortKey = 'email' | 'role' | 'tier' | 'session_count' | 'created_at'

export function AdminDashboard({ session, onBack }: Props) {
  const { users, stats, loading, fetchAll, updateUser, deleteUser } = useAdmin(session)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('created_at')
  const [sortAsc, setSortAsc] = useState(false)
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editRole, setEditRole] = useState('')
  const [editTier, setEditTier] = useState('')
  const [deletingUser, setDeletingUser] = useState<string | null>(null)

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  const handleEdit = (user: AdminUser) => {
    setEditingUser(user.id)
    setEditRole(user.role)
    setEditTier(user.tier)
  }

  const handleSave = async (id: string) => {
    await updateUser(id, { role: editRole, tier: editTier })
    setEditingUser(null)
  }

  const handleDelete = async (id: string) => {
    await deleteUser(id)
    setDeletingUser(null)
  }

  const filteredUsers = users
    .filter((u) => {
      if (!search) return true
      const q = search.toLowerCase()
      return u.email.toLowerCase().includes(q) ||
        (u.display_name || '').toLowerCase().includes(q) ||
        u.role.includes(q) ||
        u.tier.includes(q)
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv))
      return sortAsc ? cmp : -cmp
    })

  const SortHeader = ({ label, field }: { label: string; field: SortKey }) => (
    <button
      onClick={() => handleSort(field)}
      className="flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
    >
      {label}
      {sortKey === field && (
        <span className="text-indigo-400">{sortAsc ? '\u2191' : '\u2193'}</span>
      )}
    </button>
  )

  return (
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/80 bg-slate-800/60 backdrop-blur-sm shrink-0">
        <button
          onClick={onBack}
          className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-700/50 transition-colors"
          aria-label="Back to chat"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold text-slate-200">Admin Dashboard</h2>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
          {loading ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : (
            <>
              {/* Stats */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
                  <StatCard label="Total Users" value={stats.total_users} />
                  <StatCard label="Total Sessions" value={stats.total_sessions} />
                  <StatCard label="Online Sessions" value={stats.online_sessions} color="text-emerald-400" />
                  <StatCard label="Total Messages" value={stats.total_messages} />
                  <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-2">Tier Distribution</p>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-slate-300">{stats.tiers.free} <span className="text-slate-500 text-xs">free</span></span>
                      <span className="text-indigo-300">{stats.tiers.pro} <span className="text-indigo-500 text-xs">pro</span></span>
                      <span className="text-amber-300">{stats.tiers.max} <span className="text-amber-500 text-xs">max</span></span>
                    </div>
                  </div>
                </div>
              )}

              {/* Search */}
              <div className="mb-4">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search users by email, name, role, tier..."
                  className="w-full max-w-md px-3 py-2 bg-slate-800/60 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* User table */}
              <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl overflow-hidden">
                {/* Desktop table */}
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700/80">
                        <th className="px-4 py-3 text-left"><SortHeader label="Email" field="email" /></th>
                        <th className="px-4 py-3 text-left"><SortHeader label="Role" field="role" /></th>
                        <th className="px-4 py-3 text-left"><SortHeader label="Tier" field="tier" /></th>
                        <th className="px-4 py-3 text-left"><SortHeader label="Sessions" field="session_count" /></th>
                        <th className="px-4 py-3 text-left"><SortHeader label="Created" field="created_at" /></th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-slate-400">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((u) => (
                        <tr key={u.id} className="border-b border-slate-700/40 hover:bg-slate-700/30">
                          <td className="px-4 py-3">
                            <div>
                              <p className="text-white font-medium">{u.email}</p>
                              {u.display_name && <p className="text-xs text-slate-500">{u.display_name}</p>}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {editingUser === u.id ? (
                              <select
                                value={editRole}
                                onChange={(e) => setEditRole(e.target.value)}
                                className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                              >
                                <option value="user">user</option>
                                <option value="admin">admin</option>
                              </select>
                            ) : (
                              <RoleBadge role={u.role} />
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {editingUser === u.id ? (
                              <select
                                value={editTier}
                                onChange={(e) => setEditTier(e.target.value)}
                                className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                              >
                                <option value="free">free</option>
                                <option value="pro">pro</option>
                                <option value="max">max</option>
                              </select>
                            ) : (
                              <TierBadge tier={u.tier} />
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-300">{u.session_count}</td>
                          <td className="px-4 py-3 text-slate-400 text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {editingUser === u.id ? (
                                <>
                                  <button
                                    onClick={() => handleSave(u.id)}
                                    className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 rounded text-xs text-white transition-colors"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => setEditingUser(null)}
                                    className="px-2 py-1 text-slate-400 hover:text-white text-xs transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => handleEdit(u)}
                                    className="px-2 py-1 text-slate-400 hover:text-indigo-300 text-xs transition-colors"
                                  >
                                    Edit
                                  </button>
                                  {deletingUser === u.id ? (
                                    <button
                                      onClick={() => handleDelete(u.id)}
                                      className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs text-white transition-colors"
                                    >
                                      Confirm
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => setDeletingUser(u.id)}
                                      className="px-2 py-1 text-slate-400 hover:text-red-400 text-xs transition-colors"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="sm:hidden divide-y divide-slate-700/40">
                  {filteredUsers.map((u) => (
                    <div key={u.id} className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-white font-medium">{u.email}</p>
                          {u.display_name && <p className="text-xs text-slate-500">{u.display_name}</p>}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <RoleBadge role={u.role} />
                          <TierBadge tier={u.tier} />
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>{u.session_count} sessions</span>
                        <span>{new Date(u.created_at).toLocaleDateString()}</span>
                      </div>
                      {editingUser === u.id ? (
                        <div className="flex items-center gap-2 pt-1">
                          <select
                            value={editRole}
                            onChange={(e) => setEditRole(e.target.value)}
                            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                          >
                            <option value="user">user</option>
                            <option value="admin">admin</option>
                          </select>
                          <select
                            value={editTier}
                            onChange={(e) => setEditTier(e.target.value)}
                            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                          >
                            <option value="free">free</option>
                            <option value="pro">pro</option>
                            <option value="max">max</option>
                          </select>
                          <button onClick={() => handleSave(u.id)} className="px-2 py-1 bg-indigo-600 rounded text-xs text-white">Save</button>
                          <button onClick={() => setEditingUser(null)} className="text-xs text-slate-400">Cancel</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={() => handleEdit(u)} className="text-xs text-slate-400 hover:text-indigo-300">Edit</button>
                          {deletingUser === u.id ? (
                            <button onClick={() => handleDelete(u.id)} className="text-xs text-red-400 hover:text-red-300">Confirm Delete</button>
                          ) : (
                            <button onClick={() => setDeletingUser(u.id)} className="text-xs text-slate-400 hover:text-red-400">Delete</button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {filteredUsers.length === 0 && (
                  <p className="text-sm text-slate-500 text-center py-8">No users found.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
