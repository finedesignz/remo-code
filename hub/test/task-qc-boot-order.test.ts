/**
 * PTYCAP-08-08 Task 1 (F2-B3): static pin on the boot order in hub/src/index.ts.
 * The seed must run after runMigrations() and strictly before schedRegistry.loadAll(),
 * which precedes schedCatchup.runOnce(), so the normal loader arms the seeded row.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8').split(/\r?\n/).join('\n')
const idx = (needle: string) => src.indexOf(needle)

describe('task_qc boot order (static pin over index.ts)', () => {
  const MIGRATE = idx('runMigrations()\n')
  const SEED_CALL = idx('await seedTaskQcTasks()')
  const LOAD = idx('await schedRegistry.loadAll()')
  const CATCHUP = idx('await schedCatchup.runOnce()')

  test('self-check: every anchor exists', () => {
    for (const [n, v] of Object.entries({ MIGRATE, SEED_CALL, LOAD, CATCHUP })) {
      expect(v, `anchor ${n}`).toBeGreaterThanOrEqual(0)
    }
    expect(src).toContain("from './task-qc/seed.ts'")
  })

  test('seed runs after migrations, before the registry load, which precedes catchup', () => {
    expect(SEED_CALL).toBeGreaterThan(MIGRATE)
    expect(SEED_CALL).toBeLessThan(LOAD)
    expect(LOAD).toBeLessThan(CATCHUP)
  })

  test('the seed call is wrapped so a failure logs and boot continues', () => {
    const block = src.slice(Math.max(0, SEED_CALL - 80), SEED_CALL + 260)
    expect(block).toContain('try {')
    expect(block).toContain('catch')
  })

  test('the seed never touches schema.sql', () => {
    const schema = readFileSync(join(import.meta.dir, '..', 'src', 'db', 'schema.sql'), 'utf8')
    expect(schema).not.toMatch(/INSERT INTO scheduled_tasks[^;]*task_qc/i)
  })
})
