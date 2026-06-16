/**
 * `getSessionSkipPermissionsByRepo` — the repo-keyed resolver used by the spawn
 * paths that only have (userId, projectDir) and no sessionId (repo-launch,
 * orphan-resume, triage, supervisor manual start). These paths previously emitted
 * `session.start` WITHOUT `dangerously_skip_permissions`, so a respawn ran without
 * `--dangerously-skip-permissions` even when the bound session had opted in.
 *
 * Contract asserted here:
 *   - a matching session row's value is returned verbatim (true / false)
 *   - NULL coerces to false
 *   - NO matching row → TRUE (default-ON intent; the column now defaults TRUE,
 *     and the supervisor's host-config ceiling still ANDs the requested value,
 *     so a spurious TRUE can never exceed host policy).
 *
 * `sql` is mocked at the module seam (process-global bun mock, first-write-wins)
 * to feed deterministic rows without a live Postgres.
 */
import { describe, test, expect, mock } from 'bun:test'

let nextRows: any[] = []
mock.module('../src/db/postgres.ts', () => ({
  // tagged-template `sql\`...\`` — ignore the query, return the staged rows.
  sql: async () => nextRows,
}))

const dal = await import(`../src/db/dal.ts?byrepo=${Date.now()}`)

describe('getSessionSkipPermissionsByRepo — default-ON when no row', () => {
  test('matching row with TRUE → true', async () => {
    nextRows = [{ dangerously_skip_permissions: true }]
    expect(await dal.getSessionSkipPermissionsByRepo('u', '/repo')).toBe(true)
  })

  test('matching row with FALSE → false', async () => {
    nextRows = [{ dangerously_skip_permissions: false }]
    expect(await dal.getSessionSkipPermissionsByRepo('u', '/repo')).toBe(false)
  })

  test('matching row with NULL → false', async () => {
    nextRows = [{ dangerously_skip_permissions: null }]
    expect(await dal.getSessionSkipPermissionsByRepo('u', '/repo')).toBe(false)
  })

  test('NO matching row → true (default-ON; host config still ANDs)', async () => {
    nextRows = []
    expect(await dal.getSessionSkipPermissionsByRepo('u', '/repo')).toBe(true)
  })
})
