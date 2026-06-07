/**
 * Phase 32 (auto-dev-orchestrator) — legacy-task migration planner.
 *
 * The DB-touching `main()` is not unit-tested (it needs Postgres); the PURE
 * command-mapping planner is, which is the migration's actual logic. Idempotency
 * + dry-run are properties of the planner + the insert-only-when-absent loop:
 * the planner is deterministic (same legacy set → same command set), and a
 * re-run with the commands already seeded produces an empty delta.
 */
import { describe, test, expect } from 'bun:test'
import {
  commandsForLegacyTasks,
  LEGACY_TYPE_TO_COMMANDS,
  MIGRATABLE_LEGACY_TYPES,
} from '../scripts/migrate-legacy-tasks-to-orchestrator.ts'

describe('commandsForLegacyTasks', () => {
  test('dev → plan + execute', () => {
    expect(commandsForLegacyTasks([{ task_type: 'dev' }])).toEqual([
      'gsd-plan-phase',
      'gsd-execute-phase',
    ])
  })

  test('qc → audit-fix + code-review + verify-work', () => {
    expect(commandsForLegacyTasks([{ task_type: 'qc' }])).toEqual([
      'gsd-audit-fix',
      'gsd-code-review',
      'gsd-verify-work',
    ])
  })

  test('dedupes across multiple tasks (idempotent command set)', () => {
    const cmds = commandsForLegacyTasks([
      { task_type: 'dev' },
      { task_type: 'dev' },
      { task_type: 'continue_dev' },
    ])
    expect(cmds).toEqual(['gsd-plan-phase', 'gsd-execute-phase'])
  })

  test('union across dev + qc, stable order, no dupes', () => {
    const cmds = commandsForLegacyTasks([{ task_type: 'dev' }, { task_type: 'qc' }])
    expect(cmds).toEqual([
      'gsd-plan-phase',
      'gsd-execute-phase',
      'gsd-audit-fix',
      'gsd-code-review',
      'gsd-verify-work',
    ])
    expect(new Set(cmds).size).toBe(cmds.length)
  })

  test('unknown / unmappable legacy type → no commands', () => {
    expect(commandsForLegacyTasks([{ task_type: 'triage' }])).toEqual([])
    expect(commandsForLegacyTasks([{ task_type: 'orchestrator' }])).toEqual([])
  })

  test('deterministic: same input → same output (re-run safe)', () => {
    const input = [{ task_type: 'dev' }, { task_type: 'security' }]
    expect(commandsForLegacyTasks(input)).toEqual(commandsForLegacyTasks(input))
  })

  test('orchestrator is NOT a migratable legacy type (never folds into itself)', () => {
    expect(MIGRATABLE_LEGACY_TYPES).not.toContain('orchestrator')
    expect(LEGACY_TYPE_TO_COMMANDS['orchestrator']).toBeUndefined()
  })
})
