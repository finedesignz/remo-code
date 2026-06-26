/**
 * Milestone BSA — Phase BSA-05: plan-first + no-auto-merge guard.
 *
 * Asserts two non-negotiable invariants for the build-session autospawn seam:
 *
 *   (a) PLAN-FIRST / STOPS-AT-PR — the DEV (build) macro prompt that an
 *       autospawned session runs instructs the agent to open a PR + dispatch a
 *       reviewer and does NOT instruct it to auto-merge to main. A regression that
 *       slips an "auto-merge to main" directive into the dev macro fails here.
 *
 *   (b) NO MERGE FROM THE AUTOSPAWN SEAM — the inject/autospawn path never reaches
 *       the merge-to-main primitive. Merge-to-main stays the off-hours
 *       window-gated `runMergeToMain` path (controller.dispatchMergeIfDue), which
 *       is NOT on the autospawn code path. We assert structurally: the macro-cycle
 *       module (which drives autospawn via inject) does not import the merge
 *       primitive, and merge-to-main is EXCLUDED from the wave planner.
 *
 * Mirrors orchestrator-macro-path-guard.test.ts (DB-free, string/structural).
 * Reqs: BSA-05.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMacro } from '../src/orchestrator/task-macros.ts'
import { isMergeCommand, MERGE_COMMAND } from '../src/orchestrator/merge-command.ts'
import { EXCLUDED_COMMANDS } from '../src/orchestrator/waves.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'orchestrator')

describe('BSA-05: autospawn plan-first + no-auto-merge guard', () => {
  const dev = renderMacro('dev', {
    repo_path: '/srv/demo',
    repo_ident: 'github://finedesignz/demo',
    lifecycle_stage: 'development',
  })

  test('(a) dev macro is a complete, injectable prompt', () => {
    expect(dev.task_type).toBe('dev')
    expect(dev.complete).toBe(true)
    expect(dev.prompt.length).toBeGreaterThan(200)
  })

  test('(a) dev macro is plan-first: open-PR + one-branch-one-PR discipline', () => {
    // Whitespace-insensitive (the prompt is line-wrapped).
    const flat = dev.prompt.replace(/\s+/g, ' ').toLowerCase()
    expect(flat).toContain('open pr')
    expect(flat).toContain('one branch = one phase = one pr')
  })

  test('(a) dev macro does NOT instruct an off-hours auto-merge-to-main', () => {
    const flat = dev.prompt.replace(/\s+/g, ' ').toLowerCase()
    // The macro must NOT carry the orchestrator's off-hours auto-merge directive.
    expect(flat).not.toContain('auto-merge')
    expect(flat).not.toContain('merge-to-main')
    // It MUST carry the guard rail that merging is gated on green CI (proves it is
    // not an unconditional auto-merge instruction).
    expect(flat).toContain('never merge to main without green ci')
    // And the only merge it describes is a squash-merge of its OWN feature branch
    // during RELEASE — never a blanket "merge all open PRs to main".
    expect(flat).not.toContain('merge all')
  })

  test('(b) merge-to-main is EXCLUDED from the wave planner (off-hours-only path)', () => {
    expect(isMergeCommand(MERGE_COMMAND)).toBe(true)
    expect(EXCLUDED_COMMANDS.has(MERGE_COMMAND)).toBe(true)
  })

  test('(b) the autospawn driver (macro-cycle) does NOT import the merge primitive', () => {
    const macroCycle = readFileSync(join(SRC, 'macro-cycle.ts'), 'utf8')
    expect(macroCycle).not.toContain('merge-command')
    expect(macroCycle).not.toContain('runMergeToMain')
  })

  test('(b) the inject/autospawn seam does NOT import the merge primitive', () => {
    const inject = readFileSync(join(SRC, 'inject.ts'), 'utf8')
    expect(inject).not.toContain('merge-command')
    expect(inject).not.toContain('runMergeToMain')
  })
})
