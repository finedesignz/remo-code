/**
 * Real GitHub CI gate (Phase 6).
 *
 * Replaces the Phase 5 `MergeOps.ciGreen()` stub. Polls
 *   GET /repos/{owner}/{repo}/commits/{sha}/check-runs
 * until either:
 *   - all required check-runs report `conclusion='success'` → return true
 *   - any check-run reports a failure-class conclusion → return false (fast)
 *   - timeout elapses → return false
 *   - 60s elapse with ZERO check-runs ever observed → return true + warn
 *     (repo has no CI configured; backward compat with local_path / bare repos)
 *
 * Env:
 *   CI_GATE_TIMEOUT_MS    default 900_000 (15m)
 *   CI_GATE_POLL_MS       default 15_000  (15s)
 *   CI_GATE_NOCI_GRACE_MS default 60_000  (60s)
 */
import { githubApiGet } from '../auth/github-app.ts'

type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | null

interface CheckRun {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: CheckRunConclusion
}

const FAILURE_CONCLUSIONS = new Set<CheckRunConclusion>([
  'failure', 'cancelled', 'timed_out', 'action_required',
])

export interface CiGateOpts {
  installationId: number
  owner: string
  repo: string
  sha: string
  /** Optional set of check-run names to require. If empty, all check-runs are required. */
  requiredNames?: string[]
  /** Test seam: override timeout. */
  timeoutMs?: number
  /** Test seam: override poll interval. */
  pollMs?: number
  /** Test seam: override the "no-CI" grace window. */
  noCiGraceMs?: number
  /** Test seam: inject the HTTP fetcher (defaults to githubApiGet). */
  fetcher?: (installationId: number, path: string) => Promise<{ check_runs: CheckRun[] }>
  /** Test seam: clock. */
  now?: () => number
  /** Test seam: sleep. */
  sleep?: (ms: number) => Promise<void>
}

export interface CiGateResult {
  green: boolean
  reason: string
  checks: { name: string; conclusion: CheckRunConclusion }[]
}

export async function waitForCiGreen(opts: CiGateOpts): Promise<CiGateResult> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CI_GATE_TIMEOUT_MS ?? 900_000)
  const pollMs = opts.pollMs ?? Number(process.env.CI_GATE_POLL_MS ?? 15_000)
  const noCiGraceMs = opts.noCiGraceMs ?? Number(process.env.CI_GATE_NOCI_GRACE_MS ?? 60_000)
  const fetcher = opts.fetcher ?? (async (id, path) => githubApiGet<{ check_runs: CheckRun[] }>(id, path))
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const path = `/repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/check-runs?per_page=100`
  const required = new Set((opts.requiredNames ?? []).map((s) => s.toLowerCase()))
  const startedAt = now()
  let lastChecks: CheckRun[] = []
  let everSawAnyCheck = false

  while (true) {
    const elapsed = now() - startedAt
    if (elapsed >= timeoutMs) {
      return {
        green: false,
        reason: 'ci_timeout',
        checks: lastChecks.map((c) => ({ name: c.name, conclusion: c.conclusion })),
      }
    }

    let data: { check_runs: CheckRun[] }
    try {
      data = await fetcher(opts.installationId, path)
    } catch (err: any) {
      // Transient API error → don't burn the budget, just retry.
      console.warn(`[ci-gate] fetch error (will retry): ${err?.message ?? err}`)
      await sleep(pollMs)
      continue
    }

    lastChecks = data.check_runs ?? []
    if (lastChecks.length > 0) everSawAnyCheck = true

    // No check-runs ever observed AND past grace → assume repo has no CI.
    if (!everSawAnyCheck && elapsed >= noCiGraceMs) {
      console.warn(`[ci-gate] no check-runs observed for ${opts.owner}/${opts.repo}@${opts.sha.slice(0, 7)} after ${elapsed}ms; treating as ci_green (repo has no CI configured)`)
      return { green: true, reason: 'no_ci_configured', checks: [] }
    }

    // Filter to "required" subset if provided.
    const considered = required.size > 0
      ? lastChecks.filter((c) => required.has(c.name.toLowerCase()))
      : lastChecks

    // Fast fail: any considered check failed.
    const failed = considered.find((c) => c.status === 'completed' && FAILURE_CONCLUSIONS.has(c.conclusion))
    if (failed) {
      return {
        green: false,
        reason: `ci_failed:${failed.name}:${failed.conclusion}`,
        checks: considered.map((c) => ({ name: c.name, conclusion: c.conclusion })),
      }
    }

    // Have we seen completion of every required check (or all checks if no required set)?
    const haveAll = considered.length > 0 && considered.every((c) => c.status === 'completed')
    if (haveAll) {
      const allSuccess = considered.every(
        (c) => c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped',
      )
      if (allSuccess) {
        return {
          green: true,
          reason: 'ci_green',
          checks: considered.map((c) => ({ name: c.name, conclusion: c.conclusion })),
        }
      }
      // Should be caught by the FAILURE_CONCLUSIONS branch; defensive.
      return {
        green: false,
        reason: 'ci_inconclusive',
        checks: considered.map((c) => ({ name: c.name, conclusion: c.conclusion })),
      }
    }

    await sleep(pollMs)
  }
}
