/**
 * PTYCAP-04-07 (D-09d): enumerating pin over every `session.start` sender in hub/src.
 *
 * Gate lists cover dispatch(), but sessions are also spawned outside dispatch. Every site
 * that emits a `session.start` frame must be explicitly classified, so a NEW sender fails CI
 * until it is classified MACHINE (halt-guarded) or HUMAN (user-initiated web action).
 * api/sessions.ts has two senders and is classified per enclosing route.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

type Cls = 'MACHINE' | 'MACHINE_FLAGGED' | 'HUMAN'
interface Expected { cls: Cls; count: number; why: string; mustContain?: string[] }

// Non-route files: one sender each.
const FILES: Record<string, Expected> = {
  'dispatch/spawn-on-error.ts': { cls: 'MACHINE', count: 1, why: 'post-gate spawn; covered by the gate lists plus the pipeline final check' },
  'orchestrator/auto-launch.ts': { cls: 'MACHINE', count: 1, why: 'launchOrchestrator machine option', mustContain: ['isAutomationHalted', 'args.machine'] },
  'orchestrator/orphan-resume.ts': { cls: 'MACHINE', count: 1, why: 'orchestrator orphans deferred on a halt', mustContain: ['isAutomationHalted', 'skipped_halted'] },
  'telegram/launch.ts': { cls: 'MACHINE_FLAGGED', count: 1, why: 'machine option; callers pinned by launch-callers-guard', mustContain: ['isAutomationHalted', 'args.machine'] },
}
// api files: classified per enclosing route handler.
const ROUTES: Record<string, { cls: Cls; why: string }> = {
  'api/sessions.ts POST /heal': { cls: 'MACHINE', why: 'external self-heal service (panel F-2)' },
  'api/sessions.ts POST /:id/launch': { cls: 'HUMAN', why: 'web Connect/Start of a user session (cookie-authenticated, user-initiated)' },
  'api/supervisors.ts POST /:id/start': { cls: 'HUMAN', why: 'web Start button (cookie-authenticated, user-initiated)' },
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

const isComment = (l: string) => {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

interface Site { file: string; route: string | null; lineNo: number }

function scan(): Site[] {
  const out: Site[] = []
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f).split('\\').join('/')
    if (rel === 'ws/supervisor-protocol.ts') continue // the wire type declaration, not a sender
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    let route: string | null = null
    lines.forEach((line, i) => {
      const m = /^\s*(?:sessions|supervisors)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/.exec(line)
      if (m) route = `${rel} ${m[1]!.toUpperCase()} ${m[2]}`
      if (!isComment(line) && /['"`]session\.start['"`]/.test(line)) out.push({ file: rel, route, lineNo: i + 1 })
    })
  }
  return out
}

describe('session.start sender classification', () => {
  const all = scan()

  test('self-check: the scanner finds at least the 7 known sender occurrences', () => {
    expect(all.length).toBeGreaterThanOrEqual(7)
  })

  test('the wire type declaration still exists (exclusion is sane)', () => {
    expect(readFileSync(join(SRC, 'ws/supervisor-protocol.ts'), 'utf8')).toContain("'session.start'")
  })

  test('default deny: every sender is classified (file or route) with the expected count', () => {
    const unclassified: string[] = []
    const counts = new Map<string, number>()
    for (const s of all) {
      const key = s.file in FILES ? s.file : s.route && s.route in ROUTES ? s.route : null
      if (!key) { unclassified.push(`${s.file}:${s.lineNo} (${s.route ?? 'no route'})`); continue }
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(unclassified).toEqual([])
    for (const [k, e] of Object.entries(FILES)) expect([k, counts.get(k) ?? 0]).toEqual([k, e.count])
    for (const k of Object.keys(ROUTES)) expect([k, counts.get(k) ?? 0]).toEqual([k, 1])
  })

  test('MACHINE files carry their halt handling', () => {
    for (const [k, e] of Object.entries(FILES)) {
      const src = readFileSync(join(SRC, k), 'utf8')
      for (const needle of e.mustContain ?? []) expect([k, src.includes(needle)]).toEqual([k, true])
    }
  })
})
