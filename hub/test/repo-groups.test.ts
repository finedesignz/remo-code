/**
 * Tests for repo grouping (Phase 1 — data + API).
 *
 * Always-on:  Zod schema contract for repo_ident + group name (no DB).
 * Env-gated:  DAL e2e against a real Postgres (mirrors chat-tabs.test.ts).
 *             Set REMO_E2E_DB_URL to a disposable Postgres URL to run them;
 *             without it the suite skips cleanly so `bun test` stays green.
 *
 * e2e cases:
 *   1. createGroup → listGroupsForUser returns it (with empty members)
 *   2. duplicate name → DuplicateGroupNameError (maps to 409)
 *   3. addMember many-to-many: one repo in 2 groups → appears under each
 *   4. removeMember / replaceMembers full-set replace
 *   5. ownership isolation: user A cannot touch user B's group (false, not throw)
 *   6. deleteGroup cascades repo_group_members
 *   7. collapse-state round-trip + default empty + isolation
 *   8. setGroupOrder reorders by index, user-scoped
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { RepoIdent } from '../src/api/repo-groups.ts'

// ── Always-on: repo_ident schema contract ───────────────────────────────────

describe('repo-groups — RepoIdent schema', () => {
  test('accepts github:// and path:// idents', () => {
    expect(RepoIdent.safeParse('github://acme/app').success).toBe(true)
    expect(RepoIdent.safeParse('github://acme/app.sub').success).toBe(true)
    expect(RepoIdent.safeParse('path://C:/Users/me/proj').success).toBe(true)
    expect(RepoIdent.safeParse('path:///home/me/proj').success).toBe(true)
  })
  test('rejects malformed idents', () => {
    expect(RepoIdent.safeParse('').success).toBe(false)
    expect(RepoIdent.safeParse('acme/app').success).toBe(false)
    expect(RepoIdent.safeParse('gitlab://acme/app').success).toBe(false)
    expect(RepoIdent.safeParse('github://acme').success).toBe(false) // no /repo
  })
})

// ── Env-gated DAL e2e ────────────────────────────────────────────────────────

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('repo-groups — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — repo-groups e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

maybe('repo-groups e2e', () => {
  let sql: any
  let dal: typeof import('../src/db/repo-groups-dal.ts')
  let userA: string
  let userB: string

  const IDENT_X = 'github://acme/x'
  const IDENT_Y = 'github://acme/y'
  const IDENT_LOCAL = 'path://C:/repos/local-only'

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/repo-groups-dal.ts')

    const schemaFile = Bun.file(new URL('../src/db/schema.sql', import.meta.url))
    await sql.unsafe(await schemaFile.text())

    const ua = await sql`
      INSERT INTO users (email, password_hash) VALUES (${`rg-a-${Date.now()}@e2e.local`}, 'x') RETURNING id
    `
    const ub = await sql`
      INSERT INTO users (email, password_hash) VALUES (${`rg-b-${Date.now()}@e2e.local`}, 'x') RETURNING id
    `
    userA = ua[0].id
    userB = ub[0].id
  })

  afterAll(async () => {
    if (!sql) return
    if (userA) await sql`DELETE FROM users WHERE id = ${userA}`
    if (userB) await sql`DELETE FROM users WHERE id = ${userB}`
    try { await sql.end({ timeout: 1 }) } catch {}
  })

  test('createGroup → listGroupsForUser returns it with empty members', async () => {
    const g = await dal.createGroup(userA, { name: 'frontends' })
    expect(g.name).toBe('frontends')
    expect(g.sort_order).toBe(0)
    const groups = await dal.listGroupsForUser(userA)
    const found = groups.find((x) => x.id === g.id)
    expect(found?.members).toEqual([])
  })

  test('duplicate name (same user) → DuplicateGroupNameError', async () => {
    await dal.createGroup(userA, { name: 'dup-test' })
    let threw = false
    try { await dal.createGroup(userA, { name: 'dup-test' }) }
    catch (e) { threw = e instanceof dal.DuplicateGroupNameError }
    expect(threw).toBe(true)
    // Same name is fine for a DIFFERENT user.
    const gB = await dal.createGroup(userB, { name: 'dup-test' })
    expect(gB.name).toBe('dup-test')
  })

  test('many-to-many: one repo in 2 groups appears under EACH group', async () => {
    const g1 = await dal.createGroup(userA, { name: 'group-1' })
    const g2 = await dal.createGroup(userA, { name: 'group-2' })
    expect(await dal.addMember(g1.id, userA, IDENT_X)).toBe(true)
    expect(await dal.addMember(g2.id, userA, IDENT_X)).toBe(true)
    expect(await dal.addMember(g1.id, userA, IDENT_Y)).toBe(true)
    // idempotent re-add
    expect(await dal.addMember(g1.id, userA, IDENT_X)).toBe(true)

    const groups = await dal.listGroupsForUser(userA)
    const m1 = groups.find((g) => g.id === g1.id)!.members.map((m) => m.repo_ident).sort()
    const m2 = groups.find((g) => g.id === g2.id)!.members.map((m) => m.repo_ident)
    expect(m1).toEqual([IDENT_X, IDENT_Y].sort())
    expect(m2).toEqual([IDENT_X]) // X is under BOTH g1 and g2
  })

  test('removeMember + replaceMembers full-set replace', async () => {
    const g = await dal.createGroup(userA, { name: 'replace-test' })
    await dal.addMember(g.id, userA, IDENT_X)
    await dal.addMember(g.id, userA, IDENT_Y)
    expect(await dal.removeMember(g.id, userA, IDENT_X)).toBe(true)
    let groups = await dal.listGroupsForUser(userA)
    expect(groups.find((x) => x.id === g.id)!.members.map((m) => m.repo_ident)).toEqual([IDENT_Y])

    // replace with a fresh set (incl. a local-only ident + dedupe)
    expect(await dal.replaceMembers(g.id, userA, [IDENT_LOCAL, IDENT_X, IDENT_X])).toBe(true)
    groups = await dal.listGroupsForUser(userA)
    const idents = groups.find((x) => x.id === g.id)!.members.map((m) => m.repo_ident).sort()
    expect(idents).toEqual([IDENT_LOCAL, IDENT_X].sort())
  })

  test('ownership isolation: user A cannot touch user B group', async () => {
    const gB = await dal.createGroup(userB, { name: 'b-private' })
    expect(await dal.addMember(gB.id, userA, IDENT_X)).toBe(false)
    expect(await dal.removeMember(gB.id, userA, IDENT_X)).toBe(false)
    expect(await dal.replaceMembers(gB.id, userA, [IDENT_X])).toBe(false)
    expect(await dal.getGroup(gB.id, userA)).toBeNull()
    expect(await dal.updateGroup(gB.id, userA, { name: 'hijack' })).toBeNull()
    expect(await dal.deleteGroup(gB.id, userA)).toBe(false)
    // B's group still intact
    expect((await dal.getGroup(gB.id, userB))?.name).toBe('b-private')
  })

  test('deleteGroup cascades members', async () => {
    const g = await dal.createGroup(userA, { name: 'cascade' })
    await dal.addMember(g.id, userA, IDENT_X)
    expect(await dal.deleteGroup(g.id, userA)).toBe(true)
    const rows = await sql`SELECT 1 FROM repo_group_members WHERE group_id = ${g.id}`
    expect(rows.length).toBe(0)
  })

  test('collapse-state — default empty, round-trip, isolation', async () => {
    expect(await dal.getCollapseState(userA)).toEqual({ collapsed_group_ids: [] })
    const set = await dal.setCollapseState(userA, ['g1', '__ungrouped__'])
    expect(set.collapsed_group_ids.sort()).toEqual(['__ungrouped__', 'g1'])
    expect((await dal.getCollapseState(userA)).collapsed_group_ids.sort()).toEqual(['__ungrouped__', 'g1'])
    // full replace
    await dal.setCollapseState(userA, ['only'])
    expect((await dal.getCollapseState(userA)).collapsed_group_ids).toEqual(['only'])
    // B unaffected
    expect((await dal.getCollapseState(userB)).collapsed_group_ids).toEqual([])
  })

  test('setGroupOrder reorders by index, user-scoped', async () => {
    const a = await dal.createGroup(userA, { name: 'ord-a' })
    const b = await dal.createGroup(userA, { name: 'ord-b' })
    await dal.setGroupOrder(userA, [b.id, a.id])
    const ra = (await dal.getGroup(a.id, userA))!.sort_order
    const rb = (await dal.getGroup(b.id, userA))!.sort_order
    expect(rb).toBeLessThan(ra) // b now before a
  })
})
