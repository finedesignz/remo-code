/**
 * Cap coverage guard (fix/stop-the-bleed, CONCERNS item 4).
 *
 * THE SAFETY RED LINE: the product's core promise is a hard ceiling on spend.
 * On a flat-rate Max subscription the DOLLAR cap is theatre — the ceiling that
 * actually bounds a runaway loop is the daily TOKEN cap. Before this fix
 * `dailyTokenCapGate` rode ONLY the orchestrator inject path: the scheduler,
 * triage, error-capture, feedback, revanote and telegram dispatchers could each
 * spend unbounded tokens with nothing but the meaningless dollar cap in front of
 * them.
 *
 * This test enumerates EVERY dispatch entry point (every `gates: [...]` list in
 * hub/src) and fails if any of them omits `dailyTokenCapGate` or
 * `dailyCostCapGate`. A new dispatcher that forgets the cap fails CI here.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const SRC = join(import.meta.dir, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Every `gates: [ ... ]` literal in hub/src, with its file.
 *
 * Bracket-BALANCED scan, not `[^\]]*`. A naive regex terminates at the first `]`,
 * so a gate list containing a nested bracket (a gate factory taking an array arg, a
 * multi-line list with an inline array) would be truncated or skipped — and a
 * dispatcher could then omit `dailyTokenCapGate` without ever failing CI. A guard
 * with a hole in it is not a guard. Anything this scanner CANNOT parse is reported
 * as `unparsed` and HARD-FAILS the test; it is never silently ignored.
 */
function gateLists(): { lists: Array<{ file: string; list: string }>; unparsed: string[] } {
  const lists: Array<{ file: string; list: string }> = []
  const unparsed: string[] = []
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf-8')
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/')
    for (const m of src.matchAll(/gates:\s*\[/g)) {
      const open = m.index! + m[0].length - 1 // index of the '['
      let depth = 0
      let end = -1
      for (let i = open; i < src.length; i++) {
        const ch = src[i]
        if (ch === '[' || ch === '(' || ch === '{') depth++
        else if (ch === ']' || ch === ')' || ch === '}') {
          depth--
          if (depth === 0) { end = i; break }
        }
      }
      if (end === -1) {
        unparsed.push(`${rel}: unbalanced gates: [ at offset ${open}`)
        continue
      }
      lists.push({ file: rel, list: src.slice(open + 1, end) })
    }
  }
  return { lists, unparsed }
}

describe('daily TOKEN cap covers every dispatch entry point', () => {
  test('every gates: [ ... ] occurrence is PARSEABLE (an unparsed list must fail CI, never pass silently)', () => {
    expect(gateLists().unparsed).toEqual([])
  })

  test('at least the known dispatchers are present (the scan actually found them)', () => {
    const files = new Set(gateLists().lists.map((g) => g.file))
    for (const expected of [
      'orchestrator/inject.ts',
      'scheduler/senders/agent.ts',
      'scheduler/senders/triage.ts',
      'error-capture/dispatcher.ts',
      'feedback/dispatcher.ts',
      'revanote/dispatcher.ts',
      'telegram/dispatch.ts',
    ]) {
      expect(files.has(expected)).toBe(true)
    }
  })

  test('EVERY gates[] list carries dailyTokenCapGate AND dailyCostCapGate', () => {
    const offenders = gateLists().lists
      .filter((g) => !g.list.includes('dailyTokenCapGate') || !g.list.includes('dailyCostCapGate'))
      .map((g) => `${g.file}: gates: [${g.list.trim()}]`)
    expect(offenders).toEqual([])
  })
})
