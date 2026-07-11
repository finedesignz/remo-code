/**
 * fix/sched-qc — `log_check` sender app-uuid resolution.
 *
 * Prod bug: repo-bound log_check tasks with no `application_uuid` in payload
 * finalized `failed / no_application_uuid` every 6h forever (noise + fired
 * `on:'failure'` post-run chains). Now: resolve the uuid from the
 * `coolify_app_repo` map via the task's session repo_key; if still unresolvable,
 * finalize `skipped` (not `failed`).
 *
 * DAL + dispatcher mocked via `mock.module` (spread-real; see memory:
 * bun-mock-pollution). No DB required.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const USER = '11111111-1111-1111-1111-111111111111'
const SESSION_KEYED = 'sess_keyed'
const SESSION_NOREPO = 'sess_norepo'

const finals: { runId: string; status: string; error: string | null }[] = []

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getSession: async (id: string, userId: string) => {
    if (userId !== USER) return null
    if (id === SESSION_KEYED) return { id, repo_key: 'github://finedesignz/remo-code' }
    if (id === SESSION_NOREPO) return { id, repo_key: null }
    return null
  },
  getCoolifyAppByRepoKey: async (repoKey: string, userId: string) => {
    if (userId !== USER) return null
    return repoKey === 'github://finedesignz/remo-code'
      ? { application_uuid: 'app-uuid-123', user_id: userId, repo_key: repoKey, git_full_url: null, updated_at: '' }
      : null
  },
}))

const realDispatcher = await import(`../src/scheduler/dispatcher.ts?real=${Date.now()}`)
mock.module('../src/scheduler/dispatcher.ts', () => ({
  ...realDispatcher,
  finalizeRun: async (runId: string, status: string, error?: string | null) => {
    finals.push({ runId, status, error: error ?? null })
  },
}))

const { sendLogCheck } = await import('../src/scheduler/senders/coolify.ts')

const ctx = { runId: 'run1', taskId: 'task1', userId: USER }

function task(overrides: any = {}): any {
  return {
    id: 'task1', user_id: USER, session_id: null, task_type: 'log_check',
    target_kind: 'session', target_id: null, payload: {}, ...overrides,
  }
}

const originalToken = process.env.COOLIFY_TOKEN
const originalFetch = globalThis.fetch

beforeEach(() => {
  finals.length = 0
  process.env.COOLIFY_TOKEN = 'tok'
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.COOLIFY_TOKEN
  else process.env.COOLIFY_TOKEN = originalToken
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('sendLogCheck app-uuid resolution', () => {
  test('resolves the uuid from coolify_app_repo via the session repo_key', async () => {
    let requested = ''
    globalThis.fetch = (async (url: any) => {
      requested = String(url)
      return new Response('all good\n', { status: 200 })
    }) as any

    await sendLogCheck(task({ session_id: SESSION_KEYED }), ctx)

    expect(requested).toContain('/api/v1/applications/app-uuid-123/logs')
    // Clean logs → skipped/no_errors_detected (existing behavior), i.e. we got
    // past the uuid gate.
    expect(finals[0].status).toBe('skipped')
    expect(finals[0].error).toBe('no_errors_detected')
  })

  test('payload uuid still wins over the map lookup', async () => {
    let requested = ''
    globalThis.fetch = (async (url: any) => {
      requested = String(url)
      return new Response('ok', { status: 200 })
    }) as any

    await sendLogCheck(
      task({ session_id: SESSION_KEYED, payload: { application_uuid: 'payload-uuid' } }),
      ctx,
    )
    expect(requested).toContain('/applications/payload-uuid/logs')
  })

  test('unresolvable uuid finalizes SKIPPED (not failed) — no failure chains', async () => {
    globalThis.fetch = (async () => { throw new Error('should not fetch') }) as any

    await sendLogCheck(task({ session_id: SESSION_NOREPO }), ctx)

    expect(finals).toHaveLength(1)
    expect(finals[0].status).toBe('skipped')
    expect(finals[0].error).toBe('no_application_uuid')
  })

  test('missing COOLIFY_TOKEN is still a FAILURE (misconfiguration)', async () => {
    delete process.env.COOLIFY_TOKEN
    await sendLogCheck(task({ session_id: SESSION_KEYED }), ctx)
    expect(finals[0].status).toBe('failed')
    expect(finals[0].error).toBe('coolify_unconfigured')
  })
})
