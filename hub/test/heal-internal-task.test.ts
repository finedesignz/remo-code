/**
 * PTYCAP-07 plan 02 task 3 - durable internal-task marker (flag OR name prefix).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { isInternalScheduledTask } from '../src/heal/internal-task.ts'

describe('isInternalScheduledTask', () => {
  test('true when is_internal is true, whatever the name', () => {
    expect(isInternalScheduledTask({ name: 'My ordinary task', is_internal: true })).toBe(true)
  })
  test('true for the __internal_ name prefix even when is_internal is false (no backfill)', () => {
    expect(isInternalScheduledTask({ name: '__internal_triage', is_internal: false })).toBe(true)
    expect(isInternalScheduledTask({ name: '__internal_coolify_deployment', is_internal: false })).toBe(true)
  })
  test('tolerant of a missing is_internal field (older row shape)', () => {
    expect(isInternalScheduledTask({ name: '__internal_x' })).toBe(true)
    expect(isInternalScheduledTask({ name: 'nightly sync' })).toBe(false)
  })
  test('false for a normal user task', () => {
    expect(isInternalScheduledTask({ name: 'Continue Dev', is_internal: false })).toBe(false)
  })
  test('fails closed on a nullish row or name', () => {
    expect(isInternalScheduledTask(null)).toBe(true)
    expect(isInternalScheduledTask({ name: null as any })).toBe(false)
  })
})

describe('source pins', () => {
  const hubSrc = resolve(import.meta.dir, '../src')
  const dal = readFileSync(join(hubSrc, 'db/dal.ts'), 'utf-8')

  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) yield* walk(p)
      else if (p.endsWith('.ts') || p.endsWith('.sql')) yield p
    }
  }

  test('both ensureInternal*Task INSERTs set is_internal true', () => {
    for (const fn of ['ensureInternalTriageTask', 'ensureInternalDeploymentTask']) {
      const start = dal.indexOf(`export async function ${fn}`)
      expect(start).toBeGreaterThan(-1)
      const body = dal.slice(start, dal.indexOf('\nexport', start + 10))
      const ins = body.slice(body.indexOf('INSERT INTO scheduled_tasks'))
      expect(ins).toMatch(/\bis_internal\b/)
      expect(ins).toMatch(/\btrue\b[\s\S]*RETURNING/)
    }
    expect((dal.match(/is_internal/g) ?? []).length).toBe(2)
  })

  test('no UPDATE of scheduled_tasks.is_internal anywhere in hub/src', () => {
    for (const f of walk(hubSrc)) {
      const text = readFileSync(f, 'utf-8')
      expect(/UPDATE\s+scheduled_tasks[^;`]*is_internal/i.test(text)).toBe(false)
    }
  })

  test('ScheduledTask type exposes optional is_internal', () => {
    const t = readFileSync(join(hubSrc, 'db/scheduled-tasks-dal.ts'), 'utf-8')
    expect(t).toMatch(/is_internal\?:\s*boolean/)
  })
})
