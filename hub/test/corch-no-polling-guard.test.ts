// CORCH-01 (CORCH-R3.6): the only periodic loop under hub/src/corch/ is the reconciler's single
// setInterval. Everything else is event-driven (enqueue, run end, kill-switch release, supervisor
// hello/close) plus ONE setTimeout re-armed to the earliest future not_before.
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(import.meta.dir, '..', 'src', 'corch')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/.*$/gm, '$1')
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))
const count = (src: string, re: RegExp) => (stripComments(src).match(re) ?? []).length

describe('no polling under hub/src/corch (CORCH-R3.6)', () => {
  test('setInterval( appears exactly once in total, and only in reconciler.ts', () => {
    const per = files.map((f) => [f, count(readFileSync(join(DIR, f), 'utf8'), /\bsetInterval\s*\(/g)] as const)
    expect(per.reduce((n, [, c]) => n + c, 0)).toBe(1)
    expect(per.filter(([, c]) => c > 0).map(([f]) => f)).toEqual(['reconciler.ts'])
  })

  test('no recursive setTimeout polling loop: setTimeout( only in dispatcher.ts (the not_before timer)', () => {
    const per = files
      .map((f) => [f, count(readFileSync(join(DIR, f), 'utf8'), /\bsetTimeout\s*\(/g)] as const)
      .filter(([, c]) => c > 0)
    // The timer lives behind deps.timers.setTimeout and its real impl; nothing else may schedule.
    // CORCH-04 (R1.14) deliberately adds gsdc-ingest.ts: it re-arms ONE reconnect/idle timeout per event
    // through the same injected timers seam and never owns a loop (next test pins that).
    expect(per.map(([f]) => f)).toEqual(['dispatcher.ts', 'gsdc-ingest.ts'])
  })

  test('gsdc-ingest.ts schedules only through the injected timers seam (no bare setTimeout, no setInterval)', () => {
    const src = stripComments(readFileSync(join(DIR, 'gsdc-ingest.ts'), 'utf8'))
    const all = src.match(/\bsetTimeout\s*\(/g) ?? []
    const seam = src.match(/\btimers\.setTimeout\s*\(/g) ?? []
    expect(all.length).toBeGreaterThan(0)
    expect(seam.length).toBe(all.length)
    expect(src).not.toMatch(/\bsetInterval\s*\(/)
  })

  test('the board is never polled: one SSE stream open and one per-project read, both inside the event path', () => {
    const src = stripComments(readFileSync(join(DIR, 'gsdc-ingest.ts'), 'utf8'))
    expect((src.match(/\/api\/board\/projects\//g) ?? []).length).toBe(1)
    expect((src.match(/\/api\/board\/stream/g) ?? []).length).toBe(1)
  })
})
