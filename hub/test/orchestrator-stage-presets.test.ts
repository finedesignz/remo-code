/**
 * Phase 30 (auto-dev-orchestrator) — lifecycle-stage presets.
 *
 * Two layers:
 *   1. Always-on (no DB): the preset table is pure/deterministic; each stage
 *      returns its documented row set; every non-Never row carries a VALID
 *      ScheduleRule; Never rows are disabled with label 'Never'; unknown stage
 *      falls back to development.
 *   2. Env-gated e2e (REMO_E2E_DB_URL): applyStagePreset insert vs overwrite
 *      merge policy against a real Postgres. Mirrors orchestrator-data-model.test.ts.
 *
 * Reqs: R-ADO-26 (per-stage frequency presets, data not behavior),
 *       R-ADO-27 (apply preset, overridable — overrides persist).
 */
import { describe, test, expect, beforeAll } from 'bun:test'
import {
  PRESET_ROWS,
  presetRowsForStage,
  normalizeStage,
  applyStagePreset,
  STAGE_PRESET_ANCHOR,
  type LifecycleStage,
  type PresetRow,
} from '../src/orchestrator/stage-presets.ts'
import { validateRule } from '../src/scheduler/schedule-rules.ts'

const STAGES: LifecycleStage[] = ['development', 'beta', 'production-maintenance']

// The SPEC §3 user-configurable command set every stage preset must cover.
const EXPECTED_COMMANDS = [
  'gsd-plan-phase',
  'gsd-execute-phase',
  'gsd-audit-fix',
  'gap-scan',
  'gsd-code-review',
  'gsd-verify-work',
  'gsd-complete-milestone',
  'gsd-ship',
  'merge-to-main',
]

// ── Always-on: pure preset table (no DB) ──────────────────────────────────────

describe('stage-presets — table shape + validity', () => {
  for (const stage of STAGES) {
    test(`${stage}: covers exactly the SPEC §3 command set`, () => {
      const cmds = presetRowsForStage(stage).map((r) => r.command)
      expect(cmds.slice().sort()).toEqual(EXPECTED_COMMANDS.slice().sort())
    })

    test(`${stage}: every non-Never row has a VALID ScheduleRule + enabled`, () => {
      for (const r of presetRowsForStage(stage)) {
        if (r.frequency_label === 'Never') continue
        expect(r.enabled).toBe(true)
        expect(r.schedule_rule).not.toBeNull()
        const v = validateRule(r.schedule_rule)
        expect(v.ok).toBe(true)
        expect(r.schedule_rule!.start_at).toBe(STAGE_PRESET_ANCHOR)
      }
    })

    test(`${stage}: every Never row is disabled, no rule`, () => {
      for (const r of presetRowsForStage(stage)) {
        if (r.frequency_label !== 'Never') continue
        expect(r.enabled).toBe(false)
        expect(r.schedule_rule).toBeNull()
      }
    })

    test(`${stage}: sort_order is unique + dense (0..n-1)`, () => {
      const orders = presetRowsForStage(stage).map((r) => r.sort_order).sort((a, b) => a - b)
      expect(orders).toEqual(orders.map((_, i) => i))
    })
  }
})

describe('stage-presets — documented stage biases', () => {
  const label = (rows: PresetRow[], cmd: string) =>
    rows.find((r) => r.command === cmd)?.frequency_label

  test('development: ship / milestone / merge are Never (manual)', () => {
    const d = presetRowsForStage('development')
    expect(label(d, 'gsd-ship')).toBe('Never')
    expect(label(d, 'gsd-complete-milestone')).toBe('Never')
    expect(label(d, 'merge-to-main')).toBe('Never')
    // build cadence is more frequent than review (bias to building)
    expect(label(d, 'gsd-execute-phase')).toBe('Every 3h')
  })

  test('beta: QC commands enabled; ship rare (weekly propose)', () => {
    const b = presetRowsForStage('beta')
    for (const c of ['gsd-audit-fix', 'gsd-code-review', 'gsd-verify-work', 'gap-scan']) {
      const r = b.find((x) => x.command === c)!
      expect(r.enabled).toBe(true)
      expect(r.frequency_label).not.toBe('Never')
    }
    expect(label(b, 'gsd-ship')).toBe('Weekly')
    expect(label(b, 'merge-to-main')).toBe('Never')
  })

  test('production-maintenance: build Never; security-weighted gap-scan; merge rare', () => {
    const p = presetRowsForStage('production-maintenance')
    expect(label(p, 'gsd-plan-phase')).toBe('Never')
    expect(label(p, 'gsd-execute-phase')).toBe('Never')
    const gap = p.find((r) => r.command === 'gap-scan')!
    expect(gap.enabled).toBe(true)
    expect((gap.micro_prompt ?? '').toLowerCase()).toContain('security')
    expect(label(p, 'merge-to-main')).toBe('Every 2 weeks')
  })
})

describe('stage-presets — purity + unknown stage fallback', () => {
  test('presetRowsForStage is deterministic across calls', () => {
    expect(presetRowsForStage('beta')).toEqual(presetRowsForStage('beta'))
  })

  test('returned rows are fresh copies (mutating one does not affect the table)', () => {
    const a = presetRowsForStage('development')
    a[0].enabled = !a[0].enabled
    a[0].command = 'mutated'
    const b = presetRowsForStage('development')
    expect(b[0].command).not.toBe('mutated')
    // frozen source table unchanged
    expect(PRESET_ROWS.development[0].command).not.toBe('mutated')
  })

  test('unknown / invalid stage falls back to development', () => {
    expect(normalizeStage('nope')).toBe('development')
    expect(normalizeStage('')).toBe('development')
    expect(normalizeStage(null)).toBe('development')
    expect(normalizeStage(42 as unknown)).toBe('development')
    expect(presetRowsForStage('garbage')).toEqual(presetRowsForStage('development'))
  })

  test('normalizeStage passes through valid stages', () => {
    for (const s of STAGES) expect(normalizeStage(s)).toBe(s)
  })
})

// ── Env-gated e2e: applyStagePreset merge policy against real Postgres ─────────

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('stage-presets — e2e gating', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — orchestrator-stage-presets e2e SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

maybe('stage-presets — applyStagePreset e2e', () => {
  let sql: any
  let taskId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const SCHEMA = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text()
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    await sql.unsafe(SCHEMA)

    const u = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${`ado-preset-${Date.now()}@e2e.local`}, 'x')
      RETURNING id
    `
    const s = await sql`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${u[0].id}, 'preset-sess', '/tmp/preset', ${`h-${Date.now()}`})
      RETURNING id
    `
    const t = await sql`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type)
      VALUES (${u[0].id}, ${s[0].id}, 'orch', '* * * * *', '', 'orchestrator')
      RETURNING id
    `
    taskId = t[0].id
  })

  test('apply (no overwrite) inserts the full preset; second apply skips all', async () => {
    const first = await applyStagePreset(taskId, 'development')
    expect(first.stage).toBe('development')
    expect(first.inserted).toBe(PRESET_ROWS.development.length)
    expect(first.updated).toBe(0)

    const rows = await sql`SELECT command, enabled, frequency_label FROM orchestrator_rows WHERE task_id = ${taskId}`
    expect(rows.length).toBe(PRESET_ROWS.development.length)

    const second = await applyStagePreset(taskId, 'development')
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(PRESET_ROWS.development.length)
  })

  test('no-overwrite preserves a user customization', async () => {
    // user parks gsd-execute-phase manually
    await sql`UPDATE orchestrator_rows SET enabled = false, frequency_label = 'Never', schedule_rule = NULL
              WHERE task_id = ${taskId} AND command = 'gsd-execute-phase'`
    await applyStagePreset(taskId, 'development') // no overwrite
    const r = await sql`SELECT enabled, frequency_label FROM orchestrator_rows
                        WHERE task_id = ${taskId} AND command = 'gsd-execute-phase'`
    expect(r[0].enabled).toBe(false)
    expect(r[0].frequency_label).toBe('Never')
  })

  test('overwrite=true resets preset rows to stage defaults', async () => {
    const res = await applyStagePreset(taskId, 'development', { overwrite: true })
    expect(res.updated).toBe(PRESET_ROWS.development.length)
    expect(res.inserted).toBe(0)
    const r = await sql`SELECT enabled, frequency_label FROM orchestrator_rows
                        WHERE task_id = ${taskId} AND command = 'gsd-execute-phase'`
    expect(r[0].enabled).toBe(true)
    expect(r[0].frequency_label).toBe('Every 3h')
  })

  test('switching stage with overwrite updates frequencies, leaves extra user rows', async () => {
    // user adds an extra custom row not in any preset
    await sql`INSERT INTO orchestrator_rows (task_id, command, enabled, frequency_label, sort_order)
              VALUES (${taskId}, 'my-custom-cmd', true, 'Daily', 99)`
    const res = await applyStagePreset(taskId, 'production-maintenance', { overwrite: true })
    expect(res.updated).toBe(PRESET_ROWS['production-maintenance'].length)

    const plan = await sql`SELECT enabled FROM orchestrator_rows
                           WHERE task_id = ${taskId} AND command = 'gsd-plan-phase'`
    expect(plan[0].enabled).toBe(false) // Never in prod-maintenance

    const custom = await sql`SELECT command FROM orchestrator_rows
                             WHERE task_id = ${taskId} AND command = 'my-custom-cmd'`
    expect(custom.length).toBe(1) // untouched
  })
})
