/**
 * PTYCAP-08 plan 02: a full detector pass performs zero sql calls and the two
 * source files import nothing but each other, scheduler/cron and node builtins.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const SRC = join(import.meta.dir, '..', 'src', 'task-qc')
const NOW = new Date('2026-10-13T12:00:00.000Z')

afterAll(() => {
  mock.restore()
})

describe('detector purity', () => {
  test('a full runDetectors pass over all six detectors records zero sql calls', async () => {
    const fake = createTaskQcFakeSql()
    mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql, default: fake.sql }))
    const mod = (await import(`../src/task-qc/detectors.ts?purity=${Date.now()}`)) as typeof import('../src/task-qc/detectors.ts')

    const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
    const mk = (over: Record<string, unknown>) => ({
      id: 'p',
      user_id: 'u',
      name: 'n',
      task_type: 'dev',
      enabled: true,
      schedule_kind: 'cron',
      cron_expr: '*/10 * * * *',
      timezone: 'UTC',
      created_at: ago(9 * 86_400_000),
      next_fire_at: new Date(NOW.getTime() + 60_000).toISOString(),
      target_kind: 'session',
      target_id: 's1',
      prompt: 'p',
      payload: {},
      ...over,
    })
    const run = (id: string, task_id: string, status: string, i: number, error: string | null = null) => ({
      id,
      task_id,
      status,
      error,
      started_at: ago((i + 1) * 3_600_000),
    })
    const tasks = [
      mk({ id: 'failing' }),
      mk({ id: 'skip' }),
      mk({ id: 'never', next_fire_at: null }),
      mk({ id: 'misconf', task_type: 'log_check', resolvedAppUuid: null }),
      mk({ id: 'dead', target_id: 'gone' }),
      mk({ id: 'dupA', prompt: 'same' }),
      mk({ id: 'dupB', prompt: 'same' }),
    ] as never[]
    const runsByTask: Record<string, unknown[]> = {
      failing: [0, 1, 2].map((i) => run(`f${i}`, 'failing', 'failed', i, 'boom')),
      skip: [0, 1, 2].map((i) => run(`s${i}`, 'skip', 'skipped', i, 'some_reason')),
      misconf: [0, 1, 2].map((i) => run(`m${i}`, 'misconf', 'skipped', i, 'no_application_uuid')),
      dupA: Array.from({ length: 20 }, (_, i) => run(`h${i}`, 'dupA', 'skipped', i, 'no_errors_detected')),
    }
    const out = mod.runDetectors(
      {
        tasks,
        runsByTask: runsByTask as never,
        sessionsById: { s1: { id: 's1', status: 'online', deleted_at: null, last_activity: ago(1000), created_at: ago(1e9) } },
        now: NOW,
      },
      { failStreak: 3 },
    )
    const seen = new Set(out.map((f) => f.detector))
    for (const d of ['FAILING', 'SKIP_FOREVER', 'NEVER_FIRED', 'MISCONFIGURED', 'DEAD_SESSION', 'OPTIMIZE']) {
      expect(seen.has(d as never)).toBe(true)
    }
    const recordedCalls = fake.state.statements.length
    expect(recordedCalls).toBe(0)
  })

  test('static import allowlist: only each other, scheduler/cron and node builtins', () => {
    const allowed = new Set(['./types.ts', './detectors.ts', '../scheduler/cron.ts'])
    for (const file of ['detectors.ts', 'types.ts']) {
      const src = readFileSync(join(SRC, file), 'utf8')
      const specs = [...src.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      const dyn = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!)
      for (const s of [...specs, ...dyn]) {
        const ok = allowed.has(s) || s.startsWith('node:')
        if (!ok) throw new Error(`${file} imports disallowed module ${s}`)
      }
      expect(/\bprocess\.env\b|\bDate\.now\b|\bnew Date\(\)/.test(src)).toBe(false)
    }
  })
})
