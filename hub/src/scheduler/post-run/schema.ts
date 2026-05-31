/**
 * Post-run action schemas (W2/T8.6).
 *
 * Zod discriminated union describing the JSON shape stored in
 * `scheduled_tasks.post_run_actions`. The DAL treats this as opaque; the API
 * layer (W3/T13) will gate writes through `validatePostRunActions`.
 */
import { z } from 'zod'

const OnCondition = z.enum(['success', 'failure', 'always', 'cost_exceeded'])

const Base = {
  on: OnCondition,
  delay_seconds: z.number().int().min(0).max(86_400).optional(),
}

export const ChainTaskAction = z.object({
  type: z.literal('chain_task'),
  ...Base,
  config: z.object({ task_id: z.string().min(1) }),
})

// `to` is "blank = your account email" per the editor UX. We accept either a
// valid email OR an empty/whitespace string, normalizing empty → undefined so
// downstream code uses the configured account email automatically.
const EmptyOrEmail = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().email().optional(),
)

export const NotifyEmailAction = z.object({
  type: z.literal('notify_email'),
  ...Base,
  config: z.object({
    to: EmptyOrEmail,
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
  }),
})

export const NotifyTelegramAction = z.object({
  type: z.literal('notify_telegram'),
  ...Base,
  config: z.object({ body: z.string().min(1).max(4000) }),
})

export const NotifyWebPushAction = z.object({
  type: z.literal('notify_web_push'),
  ...Base,
  config: z.object({
    title: z.string().max(200).optional(),
    body: z.string().min(1).max(2000),
  }),
})

export const WebhookAction = z.object({
  type: z.literal('webhook'),
  ...Base,
  config: z.object({ url: z.string().url() }),
})

export const GithubIssueAction = z.object({
  type: z.literal('github_issue'),
  ...Base,
  config: z.object({
    repo_full_name: z.string().regex(/^[^/]+\/[^/]+$/, 'must be owner/repo'),
    labels: z.array(z.string()).max(20).optional(),
    assignees: z.array(z.string()).max(10).optional(),
  }),
})

// auto-dev P5: deploy-verify post-run action. After a deploy-failure fix commit
// lands (push → Coolify auto-deploys), this triggers a forced Coolify redeploy
// then probes the REAL routes (rule 14.4 — not `/health` alone) and reports
// pass/fail to chat. `application_uuid` drives the redeploy; `base_url` + `routes`
// drive the probe. Routes SHOULD be the app's top-level `/api/*` namespaces plus
// `/openapi.json` + `/docs` when present.
export const DeployVerifyAction = z.object({
  type: z.literal('deploy_verify'),
  ...Base,
  config: z.object({
    application_uuid: z.string().min(1),
    base_url: z.string().url(),
    routes: z.array(z.string().min(1)).min(1).max(40),
    health_paths: z.array(z.string().min(1)).max(5).optional(),
    health_timeout_ms: z.number().int().min(1000).max(600_000).optional(),
    health_interval_ms: z.number().int().min(500).max(60_000).optional(),
    // Optional session to post the verify report into; defaults to the run's
    // repo-bound / orchestrator session resolved at execute time.
    report_session_id: z.string().optional(),
  }),
})

export const PostRunAction = z.discriminatedUnion('type', [
  ChainTaskAction,
  NotifyEmailAction,
  NotifyTelegramAction,
  NotifyWebPushAction,
  WebhookAction,
  GithubIssueAction,
  DeployVerifyAction,
])
export type PostRunAction = z.infer<typeof PostRunAction>

export const PostRunActions = z.array(PostRunAction).max(20)

export function validatePostRunActions(
  arr: unknown,
): { ok: true; value: PostRunAction[] } | { ok: false; errors: string[] } {
  const r = PostRunActions.safeParse(arr ?? [])
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }
}

/**
 * Cycle detection for chain_task edges across the user's full task graph.
 * Each chain_task action is a directed edge id → action.config.task_id.
 * Returns { ok: true } or { ok: false, cycle: [taskId, ...] }.
 */
export function detectChainCycles(
  graph: Array<{ id: string; actions: PostRunAction[] }>,
): { ok: true } | { ok: false; cycle: string[] } {
  const out = new Map<string, string[]>()
  for (const n of graph) {
    const edges: string[] = []
    for (const a of n.actions) if (a.type === 'chain_task') edges.push(a.config.task_id)
    out.set(n.id, edges)
  }

  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()

  function dfs(node: string): string[] | null {
    color.set(node, GRAY)
    const edges = out.get(node) ?? []
    for (const next of edges) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) {
        const cycle: string[] = [next]
        let cur: string | null = node
        while (cur && cur !== next) { cycle.push(cur); cur = parent.get(cur) ?? null }
        cycle.push(next); cycle.reverse()
        return cycle
      }
      if (c === WHITE) { parent.set(next, node); const r = dfs(next); if (r) return r }
    }
    color.set(node, BLACK)
    return null
  }

  for (const n of graph) {
    if ((color.get(n.id) ?? WHITE) === WHITE) {
      parent.set(n.id, null)
      const cyc = dfs(n.id)
      if (cyc) return { ok: false, cycle: cyc }
    }
  }
  return { ok: true }
}
