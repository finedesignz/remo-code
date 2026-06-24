/**
 * Typed client for the repo-grouping API (`/api/repo-groups`).
 * Thin wrappers over hubFetch — auth/CSRF handled centrally.
 */
import { hubFetch } from './api'

export interface RepoGroupMember {
  repo_ident: string
  created_at: string
}

export interface RepoGroup {
  id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
  members: RepoGroupMember[]
}

export interface CollapseState {
  collapsed_group_ids: string[]
}

export async function listGroups(token: string | null): Promise<RepoGroup[]> {
  const data = await hubFetch<{ groups: RepoGroup[] }>(token, '/api/repo-groups')
  return Array.isArray(data?.groups) ? data.groups : []
}

export function createGroup(token: string | null, name: string): Promise<Omit<RepoGroup, 'members'>> {
  return hubFetch(token, '/api/repo-groups', { method: 'POST', json: { name } })
}

export function renameGroup(token: string | null, id: string, name: string): Promise<Omit<RepoGroup, 'members'>> {
  return hubFetch(token, `/api/repo-groups/${id}`, { method: 'PATCH', json: { name } })
}

export function deleteGroup(token: string | null, id: string): Promise<void> {
  return hubFetch(token, `/api/repo-groups/${id}`, { method: 'DELETE', raw: true }) as unknown as Promise<void>
}

export function reorderGroups(token: string | null, orderedIds: string[]): Promise<void> {
  return hubFetch(token, '/api/repo-groups/reorder', {
    method: 'PUT',
    json: { ordered_ids: orderedIds },
    raw: true,
  }) as unknown as Promise<void>
}

export function addMember(token: string | null, groupId: string, repoIdent: string): Promise<void> {
  return hubFetch(token, `/api/repo-groups/${groupId}/members`, {
    method: 'POST',
    json: { repo_ident: repoIdent },
    raw: true,
  }) as unknown as Promise<void>
}

export function removeMember(token: string | null, groupId: string, repoIdent: string): Promise<void> {
  return hubFetch(token, `/api/repo-groups/${groupId}/members/${encodeURIComponent(repoIdent)}`, {
    method: 'DELETE',
    raw: true,
  }) as unknown as Promise<void>
}

export function replaceMembers(token: string | null, groupId: string, repoIdents: string[]): Promise<void> {
  return hubFetch(token, `/api/repo-groups/${groupId}/members`, {
    method: 'PUT',
    json: { repo_idents: repoIdents },
    raw: true,
  }) as unknown as Promise<void>
}

export function getCollapseState(token: string | null): Promise<CollapseState> {
  return hubFetch(token, '/api/repo-groups/collapse-state')
}

export function setCollapseState(token: string | null, collapsedGroupIds: string[]): Promise<CollapseState> {
  return hubFetch(token, '/api/repo-groups/collapse-state', {
    method: 'PATCH',
    json: { collapsed_group_ids: collapsedGroupIds },
  })
}
