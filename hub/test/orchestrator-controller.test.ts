/**
 * Phase 23 (auto-dev-orchestrator) — controller decision core (no DB).
 *
 *   - parser: valid multi-command parse; malformed → safe `continue` fallback;
 *     missing block → fallback; run-log blocks survive a bad decision block.
 *   - prompt: SPEC §4 substitutions (repo/stage/due-rows/run-log) + implicit
 *     status-check first / deploy-verify terminal rows.
 *   - gate: REMO_ORCHESTRATOR_ENABLED unset ⇒ runner NOT registered ⇒ drainOnce
 *     dormant; set ⇒ runner registered.
 *
 * Reqs: R-ADO-08, R-ADO-09, R-ADO-10. Decision D10 (live-path gate).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  parseControllerDecisions,
  renderControllerPrompt,
  isOrchestratorEnabled,
  registerCycleRunnerIfEnabled,
  type ControllerContext,
} from '../src/orchestrator/controller.ts'
import * as queue from '../src/orchestrator/queue.ts'

// ── parser ────────────────────────────────────────────────────────────────────

describe('parseControllerDecisions — happy path', () => {
  test('parses a decision + multiple RUNLOG blocks', () => {
    const raw = [
      'Some prose from the agent.',
      '<<RUNLOG',
      'command: gsd-execute-phase',
      'outcome: success',
      'pr_url: https://github.com/x/y/pull/1',
      'reviewer_verdict: PASS',
      'gap_dimension:',
      'deploy_verify_result: ok',
      'RUNLOG',
      '<<RUNLOG',
      'command: gsd-code-review',
      'outcome: success',
      'gap_dimension: security',
      'RUNLOG',
      '<<DECISION',
      'action: continue',
      'reason: more work queued',
      'next_goal: finish phase 24',
      'roadmap: Phase 24',
      'DECISION',
    ].join('\n')
    const res = parseControllerDecisions(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.decision.action).toBe('continue')
    expect(res.value.decision.roadmap).toBe('Phase 24')
    expect(res.value.runLogBlocks.length).toBe(2)
    const exec = res.value.runLogBlocks[0]
    expect(exec.command).toBe('gsd-execute-phase')
    expect(exec.pr_url).toBe('https://github.com/x/y/pull/1')
    expect(exec.reviewer_verdict).toBe('PASS')
    expect(exec.gap_dimension).toBeNull() // empty value → null
    expect(res.value.runLogBlocks[1].gap_dimension).toBe('security')
  })
})

describe('parseControllerDecisions — malformed → safe fallback', () => {
  test('no decision block → fallback continue, no throw', () => {
    const res = parseControllerDecisions('just some text, no blocks')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('no_decision_block')
    expect(res.fallback.decision.action).toBe('continue')
    expect(res.fallback.runLogBlocks.length).toBe(0)
  })

  test('invalid action → fallback continue', () => {
    const raw = '<<DECISION\naction: nuke-everything\nDECISION'
    const res = parseControllerDecisions(raw)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toContain('invalid_action')
    expect(res.fallback.decision.action).toBe('continue')
  })

  test('RUNLOG blocks survive a bad/absent decision block', () => {
    const raw = '<<RUNLOG\ncommand: gsd-audit-fix\noutcome: success\nRUNLOG\n(no decision)'
    const res = parseControllerDecisions(raw)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.fallback.runLogBlocks.length).toBe(1)
    expect(res.fallback.runLogBlocks[0].command).toBe('gsd-audit-fix')
  })

  test('RUNLOG block missing command is dropped', () => {
    const raw = '<<RUNLOG\noutcome: success\nRUNLOG\n<<DECISION\naction: plan\nDECISION'
    const res = parseControllerDecisions(raw)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.runLogBlocks.length).toBe(0)
  })

  test('null/empty input does not throw', () => {
    expect(() => parseControllerDecisions('')).not.toThrow()
    // @ts-expect-error exercising defensive null handling
    expect(() => parseControllerDecisions(null)).not.toThrow()
  })
})

// ── prompt ──────────────────────────────────────────────────────────────────

describe('renderControllerPrompt — SPEC §4 substitutions', () => {
  const ctx: ControllerContext = {
    repo: 'finedesignz/kh-hub',
    stage: 'beta',
    runtimeContext: { repo: 'finedesignz/kh-hub', branch: 'main' },
    runLog: [
      {
        id: 'l1',
        session_id: 's1',
        repo_key: 'finedesignz/kh-hub',
        command: 'gsd-execute-phase',
        decision_rationale: null,
        outcome: 'success',
        gap_dimension: null,
        pr_url: 'https://github.com/x/y/pull/9',
        reviewer_verdict: 'PASS',
        deploy_verify_result: 'ok',
        created_at: '2026-06-05T10:00:00.000Z',
      },
    ],
    dueRows: [
      {
        row: {
          id: 'r1',
          task_id: 't1',
          command: 'gsd-code-review',
          enabled: true,
          schedule_rule: { interval: 4, unit: 'hours', start_at: '2026-01-01T00:00:00.000Z' },
          frequency_label: null,
          micro_prompt: null,
          sort_order: 0,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        autoDisableAfter: false,
      },
    ],
  }

  test('includes repo + stage + due row + run-log + implicit rows', () => {
    const p = renderControllerPrompt(ctx)
    expect(p).toContain('finedesignz/kh-hub')
    expect(p).toContain('beta')
    expect(p).toContain('gsd-code-review')
    expect(p).toContain('gsd-execute-phase') // from run log
    expect(p).toContain('status-check/decide')
    expect(p).toContain('deploy+log-verify')
    expect(p).toContain('<<DECISION')
    expect(p).toContain('<<RUNLOG')
    expect(p).toContain('non-bypassable')
  })

  test('empty due rows renders the none-this-tick note', () => {
    const p = renderControllerPrompt({ ...ctx, dueRows: [] })
    expect(p).toContain('none this tick')
  })
})

// ── live-path gate (D10) ──────────────────────────────────────────────────────

describe('cycle-runner gate — REMO_ORCHESTRATOR_ENABLED', () => {
  const original = process.env.REMO_ORCHESTRATOR_ENABLED

  afterEach(() => {
    if (original === undefined) delete process.env.REMO_ORCHESTRATOR_ENABLED
    else process.env.REMO_ORCHESTRATOR_ENABLED = original
    queue._resetForTests()
  })

  test('unset ⇒ disabled ⇒ runner NOT registered ⇒ drain dormant', async () => {
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    queue._resetForTests()
    expect(isOrchestratorEnabled()).toBe(false)
    const registered = registerCycleRunnerIfEnabled()
    expect(registered).toBe(false)
    const claimed = await queue.drainOnce()
    expect(claimed).toEqual([]) // no runner ⇒ dormant
  })

  test("'0' is treated as OFF", () => {
    process.env.REMO_ORCHESTRATOR_ENABLED = '0'
    expect(isOrchestratorEnabled()).toBe(false)
    expect(registerCycleRunnerIfEnabled()).toBe(false)
  })

  test("'1' enables and registers the runner", () => {
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    queue._resetForTests()
    expect(isOrchestratorEnabled()).toBe(true)
    expect(registerCycleRunnerIfEnabled()).toBe(true)
  })
})
