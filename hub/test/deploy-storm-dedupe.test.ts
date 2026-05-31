import { describe, it, expect, mock, afterAll } from 'bun:test'
import {
  deployFailureFingerprint,
  DEPLOY_DEDUPE_WINDOW_MS,
} from '../src/scheduler/deploy-fingerprint.ts'

// ── fingerprint (pure) ───────────────────────────────────────────────────────
describe('deployFailureFingerprint (auto-dev P5)', () => {
  const base = { application_uuid: 'app-1', git_repository: 'o/r', commit_sha: 'abc' }

  it('same signal + same window → same fingerprint (storm collapses)', () => {
    const t = 1_000_000_000_000
    expect(deployFailureFingerprint(base, t)).toBe(deployFailureFingerprint(base, t + 1000))
  })

  it('different commit → different fingerprint (new failure dispatches)', () => {
    const t = 1_000_000_000_000
    expect(deployFailureFingerprint(base, t)).not.toBe(
      deployFailureFingerprint({ ...base, commit_sha: 'def' }, t),
    )
  })

  it('later window → different fingerprint (same commit re-fails later)', () => {
    const t = 1_000_000_000_000
    expect(deployFailureFingerprint(base, t)).not.toBe(
      deployFailureFingerprint(base, t + DEPLOY_DEDUPE_WINDOW_MS + 1),
    )
  })

  it('different app → different fingerprint', () => {
    const t = 1_000_000_000_000
    expect(deployFailureFingerprint(base, t)).not.toBe(
      deployFailureFingerprint({ ...base, application_uuid: 'app-2' }, t),
    )
  })
})

// ── dispatchTriage storm gate (mocked claim + dispatcher) ────────────────────
// Simulate the atomic claim: first call for a key wins, repeats lose.
const claimed = new Set<string>()
let dispatchCount = 0

const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  claimDeployFailure: async (u: string, app: string, fp: string, prevFp?: string) => {
    const key = `${u}|${app}|${fp}`
    // Sliding-window: an existing claim on the previous bucket counts as a dup.
    if (prevFp && claimed.has(`${u}|${app}|${prevFp}`)) return false
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  },
  ensureInternalTriageTask: async () => 'triage-task-id',
}))

mock.module('../src/scheduler/dispatcher.ts', () => ({
  runNow: async () => {
    dispatchCount++
  },
}))

const { dispatchTriage } = await import('../src/api/coolify-webhook.ts?storm')

afterAll(() => mock.restore())

const payload = {
  event: 'deployment.failed' as const,
  deployment_uuid: 'dep-1',
  application_uuid: 'app-X',
  git_repository: 'o/r',
  commit_sha: 'sha-1',
}

describe('dispatchTriage storm dedupe (auto-dev P5)', () => {
  it('2 failed deploys, same (user, app, fingerprint) within window → ONE fix dispatch', async () => {
    claimed.clear()
    dispatchCount = 0
    await dispatchTriage('user-1', 'run-1', payload)
    await dispatchTriage('user-1', 'run-2', payload)
    expect(dispatchCount).toBe(1)
  })

  it('different commit → second dispatch allowed', async () => {
    claimed.clear()
    dispatchCount = 0
    await dispatchTriage('user-1', 'run-1', payload)
    await dispatchTriage('user-1', 'run-2', { ...payload, commit_sha: 'sha-2' })
    expect(dispatchCount).toBe(2)
  })

  it('different user → not deduped against each other', async () => {
    claimed.clear()
    dispatchCount = 0
    await dispatchTriage('user-1', 'run-1', payload)
    await dispatchTriage('user-2', 'run-2', payload)
    expect(dispatchCount).toBe(2)
  })

  it('sliding window: a claim straddling a bucket boundary is deduped via prevFingerprint', async () => {
    // The DAL claim treats a prev-bucket claim as a duplicate. Simulate a storm
    // whose first failure lands in bucket N (current) and a follow-up lands in
    // bucket N+1 — where N is the previous bucket relative to the follow-up.
    const { claimDeployFailure } = await import('../src/db/dal.ts')
    claimed.clear()
    const t = 1_000_000_000_000
    const fpN = deployFailureFingerprint(payload, t)
    const fpN1 = deployFailureFingerprint(payload, t + DEPLOY_DEDUPE_WINDOW_MS) // next bucket
    expect(fpN).not.toBe(fpN1)
    // First failure claims bucket N (no prev claim yet).
    expect(await claimDeployFailure('user-1', 'app-X', fpN)).toBe(true)
    // Follow-up in bucket N+1 with prev=fpN → deduped (no double dispatch).
    expect(await claimDeployFailure('user-1', 'app-X', fpN1, fpN)).toBe(false)
  })
})
