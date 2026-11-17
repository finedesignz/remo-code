/**
 * PTYCAP-08 pure fix planner (D-15, D-05/D-06). Decides, from a finding plus the
 * candidate lists the engine already loaded, whether there is exactly one safe
 * fix to apply or only a proposal. No database, no env, no clock: ambiguity can
 * only ever produce a proposal, and the planner never emits a kind outside
 * SAFE_FIXES (the SafeFix union is the writer's own argument type).
 */
import { isValidTimezone } from '../scheduler/cron.ts'
import type { SafeFix } from './safe-fixes.ts'
import type { Finding, Proposal } from './types.ts'

export type PlanReason = 'autofix_off' | 'no_candidate' | 'ambiguous_candidate' | 'no_fix_candidate'

export type PlanResult = { kind: 'fix'; fix: SafeFix } | { kind: 'proposal'; reason: PlanReason; proposal: Proposal }

export interface PlanContext {
  /** REMO_TASK_QC_AUTOFIX; false turns every would-be fix into a proposal */
  autofix: boolean
  /** the audited task's current timezone value */
  taskTimezone?: string | null
  /** the owner's profile timezone (users.timezone) */
  userTimezone?: string | null
  /** application uuids of the user's sibling log_check/log_pull tasks (dupes and blanks allowed) */
  siblingApplicationUuids?: string[]
  /** sessions already filtered by the engine: same non-NULL repo_key, live status, not deleted */
  liveSessionIds?: string[]
  /** repo_key of the dead session; NULL/empty means no replacement can be derived */
  deadSessionRepoKey?: string | null
}

const distinct = (xs: Array<string | null | undefined> | undefined): string[] =>
  [...new Set((xs ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]

const asProposal = (finding: Finding, extra: Proposal['params'] = {}): Proposal => ({
  kind: finding.proposal.kind,
  params: { ...finding.proposal.params, ...extra },
})

export function planFix(finding: Finding, ctx: PlanContext): PlanResult {
  const candidate = finding.fixCandidate
  if (candidate == null) return { kind: 'proposal', reason: 'no_fix_candidate', proposal: asProposal(finding) }
  if (!ctx.autofix) {
    return { kind: 'proposal', reason: 'autofix_off', proposal: asProposal(finding, { would_fix: candidate }) }
  }

  if (candidate === 'normalize_timezone') {
    if (typeof ctx.taskTimezone === 'string' && isValidTimezone(ctx.taskTimezone)) {
      return { kind: 'proposal', reason: 'no_candidate', proposal: asProposal(finding) }
    }
    const target = typeof ctx.userTimezone === 'string' && isValidTimezone(ctx.userTimezone) ? ctx.userTimezone : 'UTC'
    return { kind: 'fix', fix: { kind: 'normalize_timezone', timezone: target } }
  }

  if (candidate === 'backfill_payload_from_sibling') {
    const uuids = distinct(ctx.siblingApplicationUuids)
    if (uuids.length === 1) return { kind: 'fix', fix: { kind: 'backfill_payload_from_sibling', applicationUuid: uuids[0]! } }
    return {
      kind: 'proposal',
      reason: uuids.length === 0 ? 'no_candidate' : 'ambiguous_candidate',
      proposal: asProposal(finding, { candidates: uuids.length }),
    }
  }

  if (candidate !== 'rebind_dead_session') {
    // a candidate outside the three SafeFixKind values can only be a proposal
    return { kind: 'proposal', reason: 'no_fix_candidate', proposal: asProposal(finding) }
  }
  const oldId = typeof finding.evidence.sessionId === 'string' ? finding.evidence.sessionId : ''
  const repoKey = typeof ctx.deadSessionRepoKey === 'string' ? ctx.deadSessionRepoKey.trim() : ''
  const live = distinct(ctx.liveSessionIds).filter((s) => s !== oldId)
  if (oldId === '' || repoKey === '') return { kind: 'proposal', reason: 'no_candidate', proposal: asProposal(finding, { candidates: 0 }) }
  if (live.length === 1) return { kind: 'fix', fix: { kind: 'rebind_dead_session', oldSessionId: oldId, newSessionId: live[0]! } }
  return {
    kind: 'proposal',
    reason: live.length === 0 ? 'no_candidate' : 'ambiguous_candidate',
    proposal: asProposal(finding, { candidates: live.length }),
  }
}
