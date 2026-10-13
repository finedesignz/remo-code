/**
 * PTYCAP-04-03: `counterKey` is a server-set budget identity. It may only be ASSIGNED
 * (object property, shorthand property, or member assignment) in the allowlisted modules;
 * a new construction site (e.g. one spreading a request body into a DispatchRequest) fails
 * CI until reviewed. Mirrors human-interactive-flag-guard.test.ts. The counter gate also
 * blocks lifetime_counter_key_missing at runtime when a key is absent (belt and braces).
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const ALLOWED = new Set([
  'dispatch/pipeline.ts', //            the type declaration + release args
  'dispatch/automation-controls.ts', // the reservation / ledger arguments
  'dispatch/pty-preflight.ts', //       the PTY door (plan 04-05)
  'orchestrator/inject.ts', //          orchestrator task key
  'scheduler/senders/agent.ts', //      task:<scheduled_tasks.id>
  'scheduler/senders/triage.ts', //     triage:<application_uuid>
])

// property (`counterKey: x`, `counterKey?: x`), shorthand (`{ counterKey }`), member (`.counterKey = x`)
const ASSIGNMENT = [/\bcounterKey\s*\??\s*:/, /\.counterKey\s*=[^=]/, /[{,]\s*counterKey\s*[,}]/]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

function sitesByFile(): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of walk(SRC)) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    const n = lines.filter((l) => ASSIGNMENT.some((re) => re.test(l))).length
    if (n > 0) out.set(relative(SRC, f).split('\\').join('/'), n)
  }
  return out
}

describe('counterKey assignment trust boundary', () => {
  test('counterKey is assigned only in allowlisted hub/src modules', () => {
    const offenders = [...sitesByFile().keys()].filter((f) => !ALLOWED.has(f))
    expect(offenders).toEqual([])
  })

  test('self-check: the scanner finds the known sites (inject, agent, triage) so a broken scanner fails', () => {
    const found = sitesByFile()
    for (const known of ['orchestrator/inject.ts', 'scheduler/senders/agent.ts', 'scheduler/senders/triage.ts']) {
      expect(found.has(known)).toBe(true)
    }
    expect(found.size).toBeGreaterThanOrEqual(3)
  })

  test('agent and triage derive the key from server-side data only (task row / webhook payload uuid)', () => {
    const agent = readFileSync(join(SRC, 'scheduler/senders/agent.ts'), 'utf8')
    const triage = readFileSync(join(SRC, 'scheduler/senders/triage.ts'), 'utf8')
    expect(agent).toContain('counterKey: `task:${task.id}`')
    expect(triage).toContain('counterKey: `triage:${payload.application_uuid}`')
  })
})
