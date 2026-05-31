import { describe, it, expect, mock, afterAll } from 'bun:test'

// Mock the chain executor + task lookup BEFORE importing the dispatcher so the
// router under test uses our stubs. Cache-bust the import to avoid cross-file
// bun mock.module pollution (see feedback_bun_mock_pollution memory).
const chainCalls: Array<{ taskId: string; depth: number }> = []
mock.module('../src/scheduler/post-run/chain.ts', () => ({
  executeChain: async (action: any, ctx: any) => {
    chainCalls.push({ taskId: action.config.task_id, depth: ctx.chainDepth })
  },
}))

// task_id → task_type for getTaskById stub.
const childTypes: Record<string, string> = {
  plan_task: 'dev_plan',
  execute_task: 'dev_execute',
  ship_task: 'dev_ship',
}
// Preserve every real DAL export (the dispatcher transitively imports the whole
// module); override only getTaskById so the router resolves our stub children.
const realDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  getTaskById: async (id: string) =>
    childTypes[id] ? { id, task_type: childTypes[id] } : null,
}))

const mod = await import('../src/scheduler/post-run/dispatcher.ts?controller-routing')
const { routeControllerDecision } = mod as {
  routeControllerDecision: (args: any, actions: any[]) => Promise<boolean>
}

afterAll(() => mock.restore())

function args(action: string, taskType = 'dev') {
  return {
    task: { id: 'root', user_id: 'u1', task_type: taskType },
    runId: 'run1',
    status: 'success',
    error: null,
    cost_usd: null,
    duration_ms: null,
    output_snippet: `<<DECISION\naction: ${action}\nreason: r\nnext_goal: g\nDECISION`,
    parentFireId: null,
    chainDepth: 0,
  }
}

const edges = [
  { type: 'chain_task', on: 'success', config: { task_id: 'plan_task' } },
  { type: 'chain_task', on: 'success', config: { task_id: 'execute_task' } },
  { type: 'chain_task', on: 'success', config: { task_id: 'ship_task' } },
]

describe('routeControllerDecision (auto-dev P2)', () => {
  it('continue → chains dev_execute', async () => {
    chainCalls.length = 0
    const handled = await routeControllerDecision(args('continue'), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([{ taskId: 'execute_task', depth: 0 }])
  })

  it('plan → chains dev_plan', async () => {
    chainCalls.length = 0
    await routeControllerDecision(args('plan'), edges)
    expect(chainCalls).toEqual([{ taskId: 'plan_task', depth: 0 }])
  })

  it('bootstrap → chains dev_plan', async () => {
    chainCalls.length = 0
    await routeControllerDecision(args('bootstrap'), edges)
    expect(chainCalls).toEqual([{ taskId: 'plan_task', depth: 0 }])
  })

  it('ship → chains dev_ship', async () => {
    chainCalls.length = 0
    await routeControllerDecision(args('ship'), edges)
    expect(chainCalls).toEqual([{ taskId: 'ship_task', depth: 0 }])
  })

  it('propose → no chain, still handled', async () => {
    chainCalls.length = 0
    const handled = await routeControllerDecision(args('propose'), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })

  it('missing decision block → fallback continue → dev_execute', async () => {
    chainCalls.length = 0
    const a = args('continue')
    a.output_snippet = 'just prose, no block'
    await routeControllerDecision(a, edges)
    expect(chainCalls).toEqual([{ taskId: 'execute_task', depth: 0 }])
  })

  it('no wired edge for the action → safe no-op, no chain', async () => {
    chainCalls.length = 0
    const handled = await routeControllerDecision(args('ship'), [
      { type: 'chain_task', on: 'success', config: { task_id: 'plan_task' } },
    ])
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })
})
