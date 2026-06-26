/**
 * BSA-03 — per-user build-session autospawn repo allowlist DAL.
 *
 * isRepoAutospawnAllowed: empty allowlist ⇒ false (fail-closed), a present
 * (user, repo_ident) ⇒ true. We mock postgres.sql to return rows per the queried
 * pair so this is pure DAL-logic coverage (no REMO_E2E_DB_URL).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Simulated allowlist contents keyed by `${user}|${ident}`.
const present = new Set<string>()

mock.module('../src/db/postgres.ts', () => ({
  sql: async (_s: TemplateStringsArray, ...params: any[]) => {
    // isRepoAutospawnAllowed interpolates (userId, repoIdent) in that order.
    const [userId, repoIdent] = params
    return present.has(`${userId}|${repoIdent}`) ? [{ one: 1 }] : []
  },
}))

const url = `../src/db/orchestrator-rows-dal.ts?t=${Date.now()}${Math.random()}`
const { isRepoAutospawnAllowed } = await import(url)

beforeEach(() => present.clear())

describe('BSA-03 isRepoAutospawnAllowed', () => {
  test('empty allowlist ⇒ false (fail-closed)', async () => {
    expect(await isRepoAutospawnAllowed('u1', 'github://finedesignz/remo-code')).toBe(false)
  })

  test('present (user, repo_ident) ⇒ true', async () => {
    present.add('u1|github://finedesignz/remo-code')
    expect(await isRepoAutospawnAllowed('u1', 'github://finedesignz/remo-code')).toBe(true)
  })

  test('scoped per user — another user is not allowed', async () => {
    present.add('u1|github://finedesignz/remo-code')
    expect(await isRepoAutospawnAllowed('u2', 'github://finedesignz/remo-code')).toBe(false)
  })

  test('exact repo_ident match (path:// form too)', async () => {
    present.add('u1|path:///abs/repo')
    expect(await isRepoAutospawnAllowed('u1', 'path:///abs/repo')).toBe(true)
    expect(await isRepoAutospawnAllowed('u1', 'github://finedesignz/remo-code')).toBe(false)
  })

  test('blank user / ident short-circuit to false', async () => {
    expect(await isRepoAutospawnAllowed('', 'github://x/y')).toBe(false)
    expect(await isRepoAutospawnAllowed('u1', '')).toBe(false)
  })
})
