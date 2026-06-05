// Hub /api/supervisors/:id/scan enriches the legacy repo.scan_result shape with
// worktree/canonical introspection from the supervisor's repo_inventory, so the
// web Connections list can hide worktrees + branch-checkout sibling clones
// without requiring a new supervisor MSI. See enrichScanWithInventory.
import { describe, expect, test } from 'bun:test'
import { enrichScanWithInventory } from '../src/api/supervisors'

const scan = [
  { path: 'C:/gh/app', name: 'app', remote: 'git@github.com:acme/app', branch: 'main' },
  { path: 'C:/gh/app-feat-x', name: 'app-feat-x', remote: 'git@github.com:acme/app', branch: 'feat/x' },
  { path: 'C:/gh/app-fix-y', name: 'app-fix-y', remote: 'git@github.com:acme/app', branch: 'fix/y' },
]

const inventory = [
  { local_path: 'C:/gh/app', is_worktree: false, canonical: true },
  { local_path: 'C:/gh/app-feat-x', is_worktree: true, canonical: false },  // git worktree
  { local_path: 'C:/gh/app-fix-y', is_worktree: false, canonical: false },  // sibling branch clone
]

describe('enrichScanWithInventory', () => {
  test('stamps is_worktree / is_canonical from inventory by path', () => {
    const out = enrichScanWithInventory(scan, inventory)
    expect(out[0]).toMatchObject({ path: 'C:/gh/app', is_worktree: false, is_canonical: true })
    expect(out[1]).toMatchObject({ path: 'C:/gh/app-feat-x', is_worktree: true, is_canonical: false })
    expect(out[2]).toMatchObject({ path: 'C:/gh/app-fix-y', is_worktree: false, is_canonical: false })
  })

  test('the enriched flags let the web keep only the canonical clone', () => {
    const out = enrichScanWithInventory(scan, inventory)
    // mirror SupervisorPage / isWorktreeOrNonCanonicalRepo
    const visible = out.filter((r) => !(r.is_worktree === true || r.is_canonical === false))
    expect(visible.map((r) => r.path)).toEqual(['C:/gh/app'])
  })

  test('joins case-insensitively and tolerates separator/trailing-slash drift', () => {
    const out = enrichScanWithInventory(
      [{ path: 'c:\\gh\\App\\' }],
      [{ local_path: 'C:/gh/app', is_worktree: true, canonical: false }],
    )
    expect(out[0]).toMatchObject({ is_worktree: true, is_canonical: false })
  })

  test('leaves entries unchanged when inventory is missing/empty (legacy supervisor)', () => {
    expect(enrichScanWithInventory(scan, undefined)).toEqual(scan)
    expect(enrichScanWithInventory(scan, [])).toEqual(scan)
  })

  test('passes through scan entries with no inventory match (shown by default)', () => {
    const out = enrichScanWithInventory(
      [{ path: 'C:/gh/orphan', name: 'orphan' }],
      inventory,
    )
    expect(out[0]).toEqual({ path: 'C:/gh/orphan', name: 'orphan' })
    expect(out[0].is_worktree).toBeUndefined()
  })
})
