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

export const NotifyEmailAction = z.object({
  type: z.literal('notify_email'),
  ...Base,
  config: z.object({
    to: z.string().email().optional(),
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

export const PostRunAction = z.discriminatedUnion('type', [
  ChainTaskAction,
  NotifyEmailAction,
  NotifyTelegramAction,
  NotifyWebPushAction,
  WebhookAction,
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
