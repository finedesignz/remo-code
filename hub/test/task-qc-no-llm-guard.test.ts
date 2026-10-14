/**
 * PTYCAP-08-06 Task 3 (FORK-1, TQC-07 superseded structurally): "no dev loop, no
 * model" is a CI-enforced fact, not a promise. TQC-07's literal token-ceiling
 * acceptance is SUPERSEDED: the auditor spends zero model tokens, so there is no
 * ceiling to test. In its place this file proves (1) a closed per-file import
 * allowlist: the QC modules reach no shared dispatch pipeline, orchestrator
 * inject helper, task macro module, agent/supervisor sender or Phase 9 cap-hit
 * module, and (2) a full pass plus a sender run writes no token_usage /
 * usage_event row and calls no pipeline or session launch. Run growth is bounded
 * by the lifetime counter added in plan 07 and the deterministic bounds in
 * task-qc-bounds.test.ts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setupFireHarness, flush, QC_ID, USER } from './fixtures/task-qc-fire-harness.ts'

const calls = { pipeline: 0, launch: 0 }
const { h, reset } = setupFireHarness()
mock.module('../src/dispatch/pipeline.ts', () => ({ dispatch: async () => { calls.pipeline++ } }))
mock.module('../src/telegram/launch.ts', () => ({ launchSessionForUser: async () => { calls.launch++ } }))
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({ afterRun: async () => {} }))

const { fire } = await import('../src/scheduler/dispatcher.ts')
const { runTaskQcPass } = await import('../src/task-qc/engine.ts')

beforeEach(() => {
  reset()
  calls.pipeline = 0
  calls.launch = 0
  process.env.REMO_TASK_QC_ENABLED = '1'
})
afterAll(() => {
  delete process.env.REMO_TASK_QC_ENABLED
  mock.restore()
})

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Static, side-effect, re-export, dynamic and require specifiers of a source text (comments stripped). */
function importSpecifiers(source: string): { specifiers: string[]; nonLiteral: number } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const specifiers = new Set<string>()
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of code.matchAll(re)) specifiers.add(m[1]!)
  }
  const dynamicTotal = [...code.matchAll(/\bimport\s*\(/g)].length + [...code.matchAll(/\brequire\s*\(/g)].length
  const literalDynamic = [...code.matchAll(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g)].length + [...code.matchAll(/\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g)].length
  return { specifiers: [...specifiers].sort(), nonLiteral: dynamicTotal - literalDynamic }
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['shared dispatch pipeline', /dispatch\/pipeline/],
  ['orchestrator inject helper', /orchestrator\/inject/],
  ['task macro module', /task-macros/],
  ['agent sender', /senders\/agent/],
  ['supervisor sender', /senders\/supervisor/],
  ['Phase 9 cap-hit module', /cap-hit|cap-qc/],
]

const NODE = ['node:crypto']
const SIB = (...names: string[]) => names.map((n) => `./${n}.ts`)

/** Closed per-file allowlist. A new import fails here with a clear message: add it deliberately or remove it. */
const ALLOW: Record<string, string[]> = {
  'task-qc/types.ts': [],
  'task-qc/flags.ts': ['../scheduler/cron.ts'],
  'task-qc/findings.ts': [...NODE],
  'task-qc/detectors.ts': [...NODE, '../scheduler/cron.ts', ...SIB('types')],
  'task-qc/digest.ts': ['../lib/email.ts', ...SIB('safe-fixes', 'types')],
  'task-qc/fix-plans.ts': ['../scheduler/cron.ts', ...SIB('safe-fixes', 'types')],
  'task-qc/safe-fixes.ts': [...NODE, '../scheduler/cron.ts', ...SIB('detectors', 'findings', 'types')],
  'task-qc/run-claim.ts': ['../db/postgres.ts'],
  // the one allowed cross-module dependency into a sender file: the exported app-uuid resolver (lazy)
  'task-qc/load.ts': ['../scheduler/senders/coolify.ts', ...SIB('findings', 'flags', 'types')],
  'task-qc/engine.ts': ['../db/postgres.ts', ...SIB('detectors', 'findings', 'fix-plans', 'flags', 'load', 'safe-fixes', 'types')],
  // the sender: finalizeRun, the direct E4A helper and (plan 07) the kill-switch contract
  'scheduler/senders/task-qc.ts': [
    '../../db/scheduled-tasks-dal.ts',
    '../../db/postgres.ts',
    '../../lib/email.ts',
    '../../task-qc/engine.ts',
    '../../task-qc/digest.ts',
    '../../dispatch/automation-controls.ts',
    '../dispatcher.ts',
    '../../observability/logger',
  ],
}

function checkImports(file: string, source: string): string[] {
  const problems: string[] = []
  const { specifiers, nonLiteral } = importSpecifiers(source)
  if (nonLiteral > 0) problems.push(`${file}: dynamic import/require with a non-literal specifier`)
  const allowed = ALLOW[file]
  if (!allowed) problems.push(`${file}: file has no entry in the closed import allowlist`)
  for (const spec of specifiers) {
    for (const [label, re] of FORBIDDEN) {
      if (re.test(spec)) problems.push(`${file}: forbidden import of the ${label} ("${spec}")`)
    }
    if (allowed && !allowed.includes(spec)) problems.push(`${file}: import "${spec}" is not in the allowlist`)
  }
  return problems
}

const qcFiles = (): string[] => [
  ...readdirSync(join(SRC, 'task-qc'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `task-qc/${f}`),
  'scheduler/senders/task-qc.ts',
]

describe('import allowlist (closed list, both directions)', () => {
  test('every QC module imports only its allowlisted specifiers and no forbidden module', () => {
    const problems = qcFiles().flatMap((f) => checkImports(f, readFileSync(join(SRC, f), 'utf8')))
    expect(problems).toEqual([])
  })

  test('the allowlist has no stale entry for a file that does not exist', () => {
    expect(Object.keys(ALLOW).sort()).toEqual([...qcFiles()].sort())
  })

  test('the forbidden set catches every named module (deliberately violating fixtures)', () => {
    const bad = [
      "import { dispatch } from '../dispatch/pipeline.ts'",
      "import { injectOrchestratorPrompt } from '../orchestrator/inject.ts'",
      "const m = await import('../orchestrator/task-macros.ts')",
      "import { sendAgent } from '../scheduler/senders/agent.ts'",
      "import { sendSupervisor } from '../scheduler/senders/supervisor.ts'",
      "export * from '../dispatch/cap-hit-guard.ts'",
      "const x = require('../usage/cap-qc.ts')",
    ]
    for (const src of bad) {
      const problems = checkImports('task-qc/engine.ts', src)
      expect(problems.some((p) => p.includes('forbidden import')), src).toBe(true)
    }
  })

  test('a new unlisted import fails with a clear message; a non-literal dynamic import is flagged', () => {
    const problems = checkImports('task-qc/engine.ts', "import { x } from './brand-new-module.ts'")
    expect(problems).toEqual(['task-qc/engine.ts: import "./brand-new-module.ts" is not in the allowlist'])
    expect(checkImports('task-qc/engine.ts', 'const m = await import(name)').join('\n')).toContain('non-literal')
    expect(checkImports('task-qc/unknown.ts', '').join('\n')).toContain('no entry in the closed import allowlist')
  })

  test('the parser sees all import shapes and ignores commented-out imports', () => {
    const src = [
      "import a from './a.ts'",
      "import './side.ts'",
      "export { b } from './b.ts'",
      "const c = await import('./c.ts')",
      "// import nope from './comment.ts'",
      "/* import nope2 from './block.ts' */",
    ].join('\n')
    expect(importSpecifiers(src).specifiers).toEqual(['./a.ts', './b.ts', './c.ts', './side.ts'])
  })

  test('no QC source names a model client or provider key', () => {
    for (const f of qcFiles()) {
      const src = readFileSync(join(SRC, f), 'utf8')
      expect(src, f).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|api\.anthropic\.com|api\.openai\.com/)
    }
  })
})

// ---------------------------------------------------------------------------
// Zero model tokens, zero dispatch
// ---------------------------------------------------------------------------
describe('zero token_usage, zero pipeline', () => {
  test('a fire (engine + sender + digest + finalize) writes no token usage and calls no pipeline or launch', async () => {
    await fire(QC_ID)
    await flush()
    expect(h.finalized[0]!.status).toBe('success')
    expect(h.fake.state.statements.filter((s) => /token_usage|usage_event/i.test(s.text))).toHaveLength(0)
    expect(calls).toEqual({ pipeline: 0, launch: 0 })
    expect(h.thresholdCalls).toBe(0)
    expect(h.costCapCalls).toBe(0)
    expect(h.resolveTargetsCalls).toBe(0)
  })

  test('an auto-fix-enabled engine pass records no token statement either', async () => {
    const res = await runTaskQcPass({
      userId: USER,
      origin: 'run_now',
      deps: { autofix: true, haltCheck: async () => ({ halted: false }) },
    })
    expect(res.findings.length).toBeGreaterThan(0)
    expect(h.fake.state.statements.filter((s) => /token_usage|usage_event/i.test(s.text))).toHaveLength(0)
    expect(calls).toEqual({ pipeline: 0, launch: 0 })
  })
})
