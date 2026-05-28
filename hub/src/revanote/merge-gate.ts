/**
 * Merge gate for batched secure dispatch (Phase 5).
 *
 * Sequence (per annotation finishing the agent run in a sandbox):
 *   1. analyzeDiff(getSandboxDiff(...)) → blocked? → merge_decision='blocked'
 *   2. classifyRisk(analysis) → riskClass
 *   3. riskClass !== 'minor' → open PR, merge_decision='pr_opened'
 *   4. riskClass === 'minor' AND CI green (Phase 6) AND batch fully resolved
 *      AND no sibling clarification → squash-merge, merge_decision='auto_merged'
 *
 * Batch state is in-memory. Lost on restart (acceptable per D1 of the plan).
 * Each annotation reports in; the gate fires `merge_decision` only when
 * `batch_size` annotations have reported AND none are blocked/clarifying.
 *
 * Sibling clarification: if ANY annotation in the batch returned
 * `needs_clarification`, the gate emits `merge_decision='blocked'` with
 * reason `batch_blocked_on_clarification` for the whole batch.
 *
 * PR opening + squash merge are abstracted behind `MergeOps` so tests can
 * stub git/GitHub without spawning shells. The real implementation in
 * `defaultMergeOps()` shells out to git + uses the existing github-app
 * helpers; that lives outside the unit-test surface for Phase 5 and is
 * exercised by integration / Phase 6.
 */
import { analyzeDiff, getSandboxDiff, summarizeForCallback, type DiffAnalysis } from './diff-sandbox.ts'
import { classifyRisk, type LlmEscalator, type RiskClass } from './risk-classifier.ts'
import type { RevanoteCallbackPayload } from './callback.ts'
import { decidePolicy, loadDeployPolicy, type DeployPolicy } from './deploy-policy.ts'
import { notifyPrOpened } from './notify-pr.ts'
import type { RepoKind } from './sandbox.ts'

export type MergeDecision = 'auto_merged' | 'pr_opened' | 'blocked'

export interface BatchAnnotationReport {
  annotationId: string
  resolved: boolean
  needsClarification: boolean
  blocked: boolean
  riskClass: RiskClass | null
  prUrl: string | null
  diffHash: string | null
  diffSummary: string | null
}

interface BatchState {
  batchId: string
  expectedSize: number
  reports: Map<string, BatchAnnotationReport>
  finalized: boolean
}

const batches = new Map<string, BatchState>()

export interface MergeOps {
  /** Open a PR for the sandbox branch; return URL. */
  openPr(opts: { sandboxDir: string; repoSlug: string; batchId: string; title: string; body: string }): Promise<string>
  /** Squash-merge the PR (or branch) to default branch. Return merged URL. */
  squashMerge(opts: { sandboxDir: string; repoSlug: string; prUrl: string }): Promise<string>
  /** Check CI status — Phase 6 will wire this to GitHub checks. */
  ciGreen(opts: { sandboxDir: string; repoSlug: string }): Promise<boolean>
}

/**
 * Single-annotation gate result. Caller folds this into the outbound
 * callback payload via `applyGateToCallback()`.
 */
export interface GateOutcome {
  decision: MergeDecision | null  // null = batch incomplete, hold callback fields
  riskClass: RiskClass | null
  prUrl: string | null
  diffHash: string
  diffSummary: string
  reasons: string[]
}

export interface RunGateOpts {
  batchId: string | null | undefined
  batchSize: number | null | undefined
  annotationId: string
  sandboxDir: string
  repoSlug: string
  baseRef?: string
  needsClarification: boolean
  resolved: boolean
  mergeOps: MergeOps
  /** Phase 6: required to apply deploy-policy. Defaults to 'github' for back-compat. */
  repoKind?: RepoKind
  /** Phase 6: inject deploy policy (defaults to env-derived). */
  deployPolicy?: DeployPolicy
  /** Phase 6: LLM escalator (passes through to classifier). */
  llm?: LlmEscalator
  /** Phase 6: annotation_url for notification body. */
  annotationUrl?: string | null
  /** Phase 6: org-level notification recipient override. */
  notifyEmail?: string | null
  /** Phase 6: test seam — disable side-effectful notify. */
  notifier?: typeof notifyPrOpened
}

/**
 * Run the gate for a single annotation. Mutates batch state. Caller is
 * responsible for actually sending the outbound callback with the returned
 * outcome merged in.
 */
export async function runMergeGate(opts: RunGateOpts): Promise<GateOutcome> {
  const baseRef = opts.baseRef ?? 'HEAD'
  const diffText = await getSandboxDiff(opts.sandboxDir, baseRef)
  const analysis = analyzeDiff(diffText)
  const summary = summarizeForCallback(analysis)

  // Hard-block on diff-sandbox failure.
  if (!analysis.ok) {
    recordReport(opts, {
      annotationId: opts.annotationId,
      resolved: false,
      needsClarification: opts.needsClarification,
      blocked: true,
      riskClass: null,
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
    })
    return {
      decision: 'blocked',
      riskClass: null,
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: analysis.blockedReasons,
    }
  }

  // Hard-block on clarification (sibling check at batch finalization).
  if (opts.needsClarification) {
    recordReport(opts, {
      annotationId: opts.annotationId,
      resolved: false,
      needsClarification: true,
      blocked: false,
      riskClass: null,
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
    })
    return finalizeIfReady(opts, analysis, summary, 'individual_clarification')
  }

  const risk = await classifyRisk(analysis, { llm: opts.llm })
  const repoKind: RepoKind = opts.repoKind ?? 'github'
  const policy = opts.deployPolicy ?? loadDeployPolicy()

  // Major / breaking → PR (per-annotation; batch close still aggregates).
  if (risk.riskClass !== 'minor') {
    const policyDecision = decidePolicy({ riskClass: risk.riskClass, repoKind, ciGreen: false }, policy)
    const prUrl = await opts.mergeOps.openPr({
      sandboxDir: opts.sandboxDir,
      repoSlug: opts.repoSlug,
      batchId: opts.batchId ?? opts.annotationId,
      title: `revanote batch ${opts.batchId?.slice(0, 8) ?? 'single'}: ${risk.riskClass}`,
      body: `risk_class=${risk.riskClass}\nrationale=${risk.rationale}\nbase_branch=${policyDecision.baseBranch}\n\n${summary}`,
    })
    if (policyDecision.notify) {
      const notify = opts.notifier ?? notifyPrOpened
      // fire-and-forget; never blocks callback path
      void notify({
        riskClass: risk.riskClass,
        prUrl,
        diffSummary: summary,
        annotationUrl: opts.annotationUrl ?? null,
        payloadNotifyEmail: opts.notifyEmail ?? null,
      })
    }
    recordReport(opts, {
      annotationId: opts.annotationId,
      resolved: opts.resolved,
      needsClarification: false,
      blocked: false,
      riskClass: risk.riskClass,
      prUrl,
      diffHash: analysis.diffHash,
      diffSummary: summary,
    })
    return {
      decision: 'pr_opened',
      riskClass: risk.riskClass,
      prUrl,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: [risk.rationale],
    }
  }

  // Minor candidate. Record + try to finalize the batch.
  recordReport(opts, {
    annotationId: opts.annotationId,
    resolved: opts.resolved,
    needsClarification: false,
    blocked: false,
    riskClass: 'minor',
    prUrl: null,
    diffHash: analysis.diffHash,
    diffSummary: summary,
  })
  return finalizeIfReady(opts, analysis, summary, risk.rationale)
}

function recordReport(opts: RunGateOpts, report: BatchAnnotationReport): void {
  const batchId = opts.batchId
  if (!batchId) return // single-shot dispatch; nothing to aggregate
  let state = batches.get(batchId)
  if (!state) {
    state = {
      batchId,
      expectedSize: opts.batchSize ?? 1,
      reports: new Map(),
      finalized: false,
    }
    batches.set(batchId, state)
  }
  state.reports.set(report.annotationId, report)
  // Allow expectedSize to grow if revanote sent a higher number later.
  if (opts.batchSize && opts.batchSize > state.expectedSize) {
    state.expectedSize = opts.batchSize
  }
}

/**
 * If the batch is complete (or single-shot), decide auto_merge / pr_opened /
 * blocked. Otherwise return decision=null so the caller emits a partial
 * callback without merge fields.
 */
async function finalizeIfReady(
  opts: RunGateOpts,
  analysis: DiffAnalysis,
  summary: string,
  rationale: string,
): Promise<GateOutcome> {
  const batchId = opts.batchId
  const repoKind: RepoKind = opts.repoKind ?? 'github'
  const policy = opts.deployPolicy ?? loadDeployPolicy()

  // Single-shot: minor → consult policy.
  if (!batchId) {
    const ciGreen = await opts.mergeOps.ciGreen({ sandboxDir: opts.sandboxDir, repoSlug: opts.repoSlug })
    const policyDecision = decidePolicy({ riskClass: 'minor', repoKind, ciGreen }, policy)
    if (policyDecision.decision === 'pr_opened' && !policyDecision.performMerge) {
      // local_path: no PR, no merge — just leave the sandbox branch.
      if (repoKind === 'local_path') {
        return {
          decision: 'pr_opened',
          riskClass: 'minor',
          prUrl: null,
          diffHash: analysis.diffHash,
          diffSummary: summary,
          reasons: [policyDecision.rationale],
        }
      }
      // github + CI not green: open PR, no merge.
      return {
        decision: 'pr_opened',
        riskClass: 'minor',
        prUrl: await opts.mergeOps.openPr({
          sandboxDir: opts.sandboxDir,
          repoSlug: opts.repoSlug,
          batchId: opts.annotationId,
          title: 'revanote: minor change (CI pending)',
          body: `risk_class=minor\nrationale=${rationale}\nbase_branch=${policyDecision.baseBranch}\n\n${summary}`,
        }),
        diffHash: analysis.diffHash,
        diffSummary: summary,
        reasons: [policyDecision.rationale],
      }
    }
    // Auto-merge path.
    const prUrl = await opts.mergeOps.openPr({
      sandboxDir: opts.sandboxDir,
      repoSlug: opts.repoSlug,
      batchId: opts.annotationId,
      title: 'revanote: minor change',
      body: `risk_class=minor\nrationale=${rationale}\nbase_branch=${policyDecision.baseBranch}\n\n${summary}`,
    })
    const merged = await opts.mergeOps.squashMerge({
      sandboxDir: opts.sandboxDir,
      repoSlug: opts.repoSlug,
      prUrl,
    })
    return {
      decision: 'auto_merged',
      riskClass: 'minor',
      prUrl: merged,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: [rationale],
    }
  }

  // Batched: only finalize when the last report arrives.
  const state = batches.get(batchId)
  if (!state) {
    return {
      decision: null,
      riskClass: 'minor',
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['batch_state_missing'],
    }
  }
  if (state.reports.size < state.expectedSize || state.finalized) {
    return {
      decision: null,
      riskClass: 'minor',
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['batch_incomplete'],
    }
  }

  state.finalized = true

  // Sibling clarification → whole batch blocked.
  const anyClar = [...state.reports.values()].some((r) => r.needsClarification)
  if (anyClar) {
    return {
      decision: 'blocked',
      riskClass: null,
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['batch_blocked_on_clarification'],
    }
  }
  // Any individual block → whole batch blocked.
  const anyBlocked = [...state.reports.values()].some((r) => r.blocked)
  if (anyBlocked) {
    return {
      decision: 'blocked',
      riskClass: null,
      prUrl: null,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['batch_contains_blocked_diff'],
    }
  }
  // Any major/breaking → batch PR-opens, no auto-merge.
  const anyMajor = [...state.reports.values()].some((r) => r.riskClass && r.riskClass !== 'minor')
  if (anyMajor) {
    return {
      decision: 'pr_opened',
      riskClass: highest([...state.reports.values()]),
      prUrl: firstPrUrl(state),
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['batch_contains_non_minor'],
    }
  }

  // All minor. CI gate.
  const ciGreen = await opts.mergeOps.ciGreen({ sandboxDir: opts.sandboxDir, repoSlug: opts.repoSlug })
  const batchPolicyDecision = decidePolicy({ riskClass: 'minor', repoKind, ciGreen }, policy)
  if (!batchPolicyDecision.performMerge) {
    // local_path: leave sandbox branch, no PR.
    if (repoKind === 'local_path') {
      return {
        decision: 'pr_opened',
        riskClass: 'minor',
        prUrl: null,
        diffHash: analysis.diffHash,
        diffSummary: summary,
        reasons: [batchPolicyDecision.rationale],
      }
    }
    const prUrl = await opts.mergeOps.openPr({
      sandboxDir: opts.sandboxDir,
      repoSlug: opts.repoSlug,
      batchId,
      title: `revanote batch ${batchId.slice(0, 8)}: minor (CI pending)`,
      body: `risk_class=minor\nrationale=batch_all_minor_ci_pending\nbase_branch=${batchPolicyDecision.baseBranch}\n\n${summary}`,
    })
    return {
      decision: 'pr_opened',
      riskClass: 'minor',
      prUrl,
      diffHash: analysis.diffHash,
      diffSummary: summary,
      reasons: ['ci_not_green'],
    }
  }

  // Auto-merge path.
  const prUrl = await opts.mergeOps.openPr({
    sandboxDir: opts.sandboxDir,
    repoSlug: opts.repoSlug,
    batchId,
    title: `revanote batch ${batchId.slice(0, 8)}: minor`,
    body: `risk_class=minor\nrationale=batch_all_minor\n\n${summary}`,
  })
  const merged = await opts.mergeOps.squashMerge({
    sandboxDir: opts.sandboxDir,
    repoSlug: opts.repoSlug,
    prUrl,
  })
  return {
    decision: 'auto_merged',
    riskClass: 'minor',
    prUrl: merged,
    diffHash: analysis.diffHash,
    diffSummary: summary,
    reasons: ['batch_all_minor_ci_green'],
  }
}

function highest(reports: BatchAnnotationReport[]): RiskClass | null {
  const order: Record<RiskClass, number> = { minor: 0, major: 1, breaking: 2 }
  let best: RiskClass | null = null
  for (const r of reports) {
    if (!r.riskClass) continue
    if (!best || order[r.riskClass] > order[best]) best = r.riskClass
  }
  return best
}

function firstPrUrl(state: BatchState): string | null {
  for (const r of state.reports.values()) if (r.prUrl) return r.prUrl
  return null
}

/**
 * Fold a gate outcome into a callback payload. When `decision` is null the
 * batch is incomplete — the callback still goes out with the existing fields
 * but `merge_decision` is left undefined so revanote doesn't write a final
 * row for a non-final report.
 */
export function applyGateToCallback(
  payload: RevanoteCallbackPayload,
  outcome: GateOutcome,
  batchId: string | null,
): RevanoteCallbackPayload {
  return {
    ...payload,
    batch_id: batchId ?? payload.batch_id ?? null,
    risk_class: outcome.riskClass ?? null,
    merge_decision: outcome.decision ?? null,
    pr_url: outcome.prUrl ?? null,
    diff_summary: outcome.diffSummary ?? null,
    diff_hash: outcome.diffHash ?? null,
  }
}

/**
 * Default MergeOps using real GitHub CI gate (Phase 6) + thin git/PR stubs.
 *
 * Phase 6 lands the CI gate as real (poll check-runs). PR open + squash
 * merge are still abstracted — the actual `gh pr create` / merge plumbing
 * is implemented elsewhere (existing supervisor → hub flow handles it for
 * non-revanote paths). Until that's wired, this default emits a deterministic
 * placeholder PR URL and logs the intended action; integration paths that
 * really need to ship to GitHub MUST inject their own MergeOps.
 *
 * Callers who want the real merge surface should construct their own
 * MergeOps and pass it through `RunGateOpts.mergeOps`.
 */
export interface DefaultMergeOpsOpts {
  installationId?: number
  /** Override the head SHA the CI gate polls (defaults to `git rev-parse HEAD` in sandbox). */
  headShaResolver?: (sandboxDir: string) => Promise<string>
  /** Override CI poll behavior (tests). */
  ciFetcher?: Parameters<typeof import('./ci-gate.ts')['waitForCiGreen']>[0]['fetcher']
}

export function defaultMergeOps(extra: DefaultMergeOpsOpts = {}): MergeOps {
  return {
    async openPr(opts) {
      // Real PR opening is delegated to integration paths. Log + return a
      // deterministic synthetic URL so the gate flow completes.
      const synthetic = `https://github.com/${opts.repoSlug}/pull/synthetic-${opts.batchId.slice(0, 8)}`
      console.warn(`[revanote.merge-gate.defaultMergeOps] openPr stub — wire real impl. would open: ${synthetic} title=${JSON.stringify(opts.title)}`)
      return synthetic
    },
    async squashMerge(opts) {
      console.warn(`[revanote.merge-gate.defaultMergeOps] squashMerge stub — wire real impl. would merge: ${opts.prUrl}`)
      return `${opts.prUrl}/merged`
    },
    async ciGreen(opts) {
      const installationId = extra.installationId
      if (!installationId) {
        // No installation context → fall back to optimistic green so
        // local_path / unconfigured flows complete the loop.
        console.warn(`[revanote.merge-gate.defaultMergeOps] ciGreen optimistic (no installationId) repo=${opts.repoSlug}`)
        return true
      }
      const slugMatch = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(opts.repoSlug.trim())
      if (!slugMatch) {
        console.warn(`[revanote.merge-gate.defaultMergeOps] ciGreen: unparseable repoSlug ${opts.repoSlug}; optimistic`)
        return true
      }
      const owner = slugMatch[1]
      const repo = slugMatch[2]
      const headSha = await (extra.headShaResolver ?? defaultHeadSha)(opts.sandboxDir)
      if (!headSha) {
        console.warn(`[revanote.merge-gate.defaultMergeOps] ciGreen: no head sha; optimistic`)
        return true
      }
      const { waitForCiGreen } = await import('./ci-gate.ts')
      const result = await waitForCiGreen({
        installationId, owner, repo, sha: headSha, fetcher: extra.ciFetcher,
      })
      if (!result.green) {
        console.warn(`[revanote.merge-gate.defaultMergeOps] ciGreen=false reason=${result.reason}`)
      }
      return result.green
    },
  }
}

async function defaultHeadSha(sandboxDir: string): Promise<string> {
  try {
    const { spawnSync } = await import('node:child_process')
    const out = spawnSync('git', ['-C', sandboxDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' })
    return (out.stdout || '').trim()
  } catch {
    return ''
  }
}

// Test helpers.
export function _resetBatchState(): void { batches.clear() }
export function _peekBatchState(batchId: string): BatchState | undefined { return batches.get(batchId) }
