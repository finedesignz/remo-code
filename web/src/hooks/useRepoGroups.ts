/**
 * Repo-grouping data hook — shared by the Connections tab and the sidebar.
 *
 * Owns: the groups list (+ members), the inverse ident→groupIds map, the shared
 * server-persisted collapse state, and the localStorage "Group by" view toggle.
 *
 * Locked product decisions:
 *  - Grouping auto-turns-ON the first time the user creates a group.
 *  - Collapse state is SHARED between Connections and sidebar (one server row).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../lib/repo-groups'
import type { RepoGroup } from '../lib/repo-groups'
import { buildIdentToGroupIds } from '../lib/group-partition'

const VIEW_LS_KEY = 'remo:repos-group-view' // 'groups' | 'none'

function readView(): boolean {
  try {
    return localStorage.getItem(VIEW_LS_KEY) === 'groups'
  } catch {
    return false
  }
}

export function useRepoGroups(token: string | null) {
  const [groups, setGroups] = useState<RepoGroup[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [groupView, setGroupViewState] = useState<boolean>(readView)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const [gs, cs] = await Promise.all([api.listGroups(token), api.getCollapseState(token)])
      setGroups(gs)
      setCollapsed(new Set(cs.collapsed_group_ids))
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'failed to load groups')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setGroupView = useCallback((on: boolean) => {
    setGroupViewState(on)
    try {
      localStorage.setItem(VIEW_LS_KEY, on ? 'groups' : 'none')
    } catch {}
  }, [])

  const identToGroupIds = useMemo(() => buildIdentToGroupIds(groups), [groups])

  // ── Collapse (optimistic, debounced server PATCH of the full set) ──────────
  const toggleCollapsed = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        if (token) void api.setCollapseState(token, Array.from(next)).catch(() => {})
        return next
      })
    },
    [token],
  )

  // ── Mutations (refetch after each; small list, simplest correct path) ──────
  const createGroup = useCallback(
    async (name: string) => {
      if (!token) return
      await api.createGroup(token, name)
      // Auto-turn-ON grouping the first time a group is created.
      setGroupView(true)
      await refresh()
    },
    [token, refresh, setGroupView],
  )

  const renameGroup = useCallback(
    async (id: string, name: string) => {
      if (!token) return
      await api.renameGroup(token, id, name)
      await refresh()
    },
    [token, refresh],
  )

  const deleteGroup = useCallback(
    async (id: string) => {
      if (!token) return
      await api.deleteGroup(token, id)
      await refresh()
    },
    [token, refresh],
  )

  const reorderGroups = useCallback(
    async (orderedIds: string[]) => {
      if (!token) return
      await api.reorderGroups(token, orderedIds)
      await refresh()
    },
    [token, refresh],
  )

  /** Move a group up/down by one slot (computes the new order + persists). */
  const moveGroup = useCallback(
    async (id: string, dir: -1 | 1) => {
      const ids = groups.map((g) => g.id)
      const i = ids.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ids.length) return
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
      await reorderGroups(ids)
    },
    [groups, reorderGroups],
  )

  /** Toggle a repo's membership in a group (checkbox dropdown). */
  const toggleMembership = useCallback(
    async (groupId: string, repoIdent: string, member: boolean) => {
      if (!token) return
      if (member) await api.addMember(token, groupId, repoIdent)
      else await api.removeMember(token, groupId, repoIdent)
      await refresh()
    },
    [token, refresh],
  )

  const replaceMembers = useCallback(
    async (groupId: string, repoIdents: string[]) => {
      if (!token) return
      await api.replaceMembers(token, groupId, repoIdents)
      await refresh()
    },
    [token, refresh],
  )

  return {
    groups,
    identToGroupIds,
    collapsed,
    isCollapsed: (id: string) => collapsed.has(id),
    toggleCollapsed,
    groupView,
    setGroupView,
    loading,
    error,
    refresh,
    createGroup,
    renameGroup,
    deleteGroup,
    moveGroup,
    reorderGroups,
    toggleMembership,
    replaceMembers,
  }
}

export type UseRepoGroups = ReturnType<typeof useRepoGroups>
