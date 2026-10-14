// hub/src/api/orchestrator-proof.ts
// PTYCAP-05-04: read-only status of the throwaway-repo due->PR proof.
//
//   GET /api/orchestrator/proof   - latest proof run + up to 5 earlier runs, caller's own only
//
// Tenancy: the user id comes ONLY from c.get('userId') (set by the /api/* auth catch-all);
// a user_id query string or header is never read, and the DAL query is scoped by user_id.
// Read-only by design (D-05): arm, disarm and enable are an operator script, never an HTTP
// surface, so this router registers no mutating handler. The response is an explicit
// allowlist mapping: installation ids, ruleset ids, raw arm preconditions and the counter
// key never leave the hub, and the ruleset digest is truncated.

import { Hono } from 'hono'
import { listProofRunsForUser, countProofInjects } from '../db/orchestrator-proof-dal.ts'
import type { ProofRun } from '../orchestrator/proof-types.ts'

type Env = { Variables: { userId: string } }

export const orchestratorProofApi = new Hono<Env>()

/** Latest run plus up to this many earlier ones. */
const HISTORY_LIMIT = 5

async function injectsFor(run: ProofRun): Promise<number | null> {
  try {
    return await countProofInjects(run.counter_key, (run.started_at ?? run.armed_at) as Date | string)
  } catch (err: any) {
    console.warn(`[orchestrator-proof-api] inject count failed run=${run.id}: ${err?.message ?? err}`)
    return null
  }
}

async function present(run: ProofRun) {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    outcome_detail: run.outcome_detail,
    repo_ident: run.repo_ident,
    branch: run.branch,
    base_sha: run.base_sha,
    default_branch: run.default_branch,
    pr_url: run.pr_url,
    pr_number: run.pr_number,
    last_ci_state: run.last_ci_state,
    last_inject_outcome: run.last_inject_outcome,
    protection_shape: run.protection_shape,
    ruleset_digest: String(run.ruleset_digest ?? '').slice(0, 12),
    budgets: {
      max_injects: Number(run.max_injects),
      max_tokens: Number(run.max_tokens),
      max_wall_ms: Number(run.max_wall_ms),
    },
    usage: { injects: await injectsFor(run), tokens_hwm: Number(run.tokens_hwm) },
    // Fail closed: anything other than an explicit 'verified' reads as unverified.
    bypass_verification: run.arm_preconditions?.bypass_verification === 'verified' ? 'verified' : 'unverified',
    armed_at: run.armed_at,
    started_at: run.started_at,
    terminal_at: run.terminal_at,
  }
}

orchestratorProofApi.get('/', async (c) => {
  const userId = c.get('userId')
  try {
    const rows = await listProofRunsForUser(userId, HISTORY_LIMIT + 1)
    const [latest, ...earlier] = rows
    return c.json({
      run: latest ? await present(latest) : null,
      history: await Promise.all(earlier.slice(0, HISTORY_LIMIT).map(present)),
    })
  } catch (err: any) {
    console.error(`[orchestrator-proof-api] read failed user=${userId}: ${err?.message ?? err}`)
    return c.json({ error: 'internal' }, 500)
  }
})
