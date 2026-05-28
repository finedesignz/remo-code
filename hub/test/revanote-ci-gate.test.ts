import { describe, expect, test } from 'bun:test'
import { waitForCiGreen } from '../src/revanote/ci-gate'

function makeFetcher(scripted: Array<{ check_runs: any[] }>) {
  let i = 0
  return async (_id: number, _path: string) => {
    const v = scripted[Math.min(i, scripted.length - 1)]
    i++
    return v
  }
}

describe('waitForCiGreen', () => {
  const baseOpts = {
    installationId: 123,
    owner: 'acme',
    repo: 'site',
    sha: 'deadbeef',
    pollMs: 1,
    timeoutMs: 5_000,
    noCiGraceMs: 5,
    sleep: async () => {},
  }

  test('all checks success → green', async () => {
    const res = await waitForCiGreen({
      ...baseOpts,
      fetcher: makeFetcher([
        { check_runs: [
          { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
        ] },
      ]),
    })
    expect(res.green).toBe(true)
    expect(res.reason).toBe('ci_green')
  })

  test('any failure → false fast', async () => {
    const res = await waitForCiGreen({
      ...baseOpts,
      fetcher: makeFetcher([
        { check_runs: [
          { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'test', status: 'completed', conclusion: 'failure' },
        ] },
      ]),
    })
    expect(res.green).toBe(false)
    expect(res.reason).toContain('ci_failed')
    expect(res.reason).toContain('test')
  })

  test('cancelled / timed_out / action_required all fast-fail', async () => {
    for (const conclusion of ['cancelled', 'timed_out', 'action_required'] as const) {
      const res = await waitForCiGreen({
        ...baseOpts,
        fetcher: makeFetcher([
          { check_runs: [{ id: 1, name: 'x', status: 'completed', conclusion }] },
        ]),
      })
      expect(res.green).toBe(false)
      expect(res.reason).toContain(conclusion)
    }
  })

  test('queued → in_progress → success → green', async () => {
    let calls = 0
    let virtualNow = 0
    const res = await waitForCiGreen({
      ...baseOpts,
      now: () => virtualNow,
      sleep: async (ms) => { virtualNow += ms },
      fetcher: async () => {
        calls++
        if (calls === 1) return { check_runs: [{ id: 1, name: 'build', status: 'queued', conclusion: null }] }
        if (calls === 2) return { check_runs: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }] }
        return { check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] }
      },
    })
    expect(res.green).toBe(true)
  })

  test('no check-runs after grace → green + warn (no CI configured)', async () => {
    let virtualNow = 0
    const res = await waitForCiGreen({
      ...baseOpts,
      noCiGraceMs: 100,
      pollMs: 50,
      now: () => virtualNow,
      sleep: async (ms) => { virtualNow += ms },
      fetcher: async () => ({ check_runs: [] }),
    })
    expect(res.green).toBe(true)
    expect(res.reason).toBe('no_ci_configured')
  })

  test('timeout while pending → false', async () => {
    let virtualNow = 0
    const res = await waitForCiGreen({
      ...baseOpts,
      timeoutMs: 50,
      pollMs: 10,
      noCiGraceMs: 1_000_000, // disable the no-ci-grace branch
      now: () => virtualNow,
      sleep: async (ms) => { virtualNow += ms },
      fetcher: async () => ({ check_runs: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }] }),
    })
    expect(res.green).toBe(false)
    expect(res.reason).toBe('ci_timeout')
  })

  test('requiredNames filter — only required checks gate', async () => {
    const res = await waitForCiGreen({
      ...baseOpts,
      requiredNames: ['build'],
      fetcher: makeFetcher([
        { check_runs: [
          { id: 1, name: 'build', status: 'completed', conclusion: 'success' },
          { id: 2, name: 'optional-lint', status: 'completed', conclusion: 'failure' },
        ] },
      ]),
    })
    expect(res.green).toBe(true)
  })
})
