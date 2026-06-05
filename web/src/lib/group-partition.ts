/**
 * Pure grouping/partition helpers shared by the Connections table and the
 * sessions sidebar. No React, no I/O — easy to unit-test.
 *
 * Locked product rules:
 *  - A repo in N groups renders under EACH of those groups (duplication).
 *  - Repos in zero groups (or with a null ident) fall into a trailing,
 *    collapsible "Ungrouped" section (reserved id `__ungrouped__`).
 *  - Group order follows `sort_order` (already sorted by the API).
 */
import type { RepoGroup } from './repo-groups'
import { UNGROUPED_ID } from './repo-ident'

export interface GroupSectionView<T> {
  id: string // group id, or UNGROUPED_ID
  name: string
  count: number
  items: T[]
  isUngrouped: boolean
}

/** Build `ident → groupId[]` from the groups list (the inverse membership map). */
export function buildIdentToGroupIds(groups: RepoGroup[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const g of groups) {
    for (const m of g.members) {
      const arr = map.get(m.repo_ident) ?? []
      arr.push(g.id)
      map.set(m.repo_ident, arr)
    }
  }
  return map
}

/**
 * Partition an ordered list of items into group sections + a trailing Ungrouped
 * section. `identOf` maps an item to its repo_ident (null → Ungrouped).
 *
 * Items keep their incoming order within each section (caller pre-sorts/filters).
 * Empty group sections are KEPT (so the user can see/seed an empty group); the
 * Ungrouped section is included only when it has items.
 */
export function partitionIntoGroups<T>(
  items: T[],
  groups: RepoGroup[],
  identOf: (item: T) => string | null,
): GroupSectionView<T>[] {
  const buckets = new Map<string, T[]>()
  for (const g of groups) buckets.set(g.id, [])
  const ungrouped: T[] = []

  for (const item of items) {
    const ident = identOf(item)
    const groupIds = ident ? groups.filter((g) => g.members.some((m) => m.repo_ident === ident)).map((g) => g.id) : []
    if (groupIds.length === 0) {
      ungrouped.push(item)
      continue
    }
    for (const gid of groupIds) buckets.get(gid)!.push(item)
  }

  const sections: GroupSectionView<T>[] = groups.map((g) => {
    const arr = buckets.get(g.id)!
    return { id: g.id, name: g.name, count: arr.length, items: arr, isUngrouped: false }
  })
  if (ungrouped.length > 0) {
    sections.push({ id: UNGROUPED_ID, name: 'Ungrouped', count: ungrouped.length, items: ungrouped, isUngrouped: true })
  }
  return sections
}
