/**
 * PTYCAP-04-03 (T-04-10): a grace replay body in orchestrator/inject.ts runs up to 10
 * minutes after the original gate decision. It MUST re-enter dispatch() (full gates,
 * kill switch, reservation) and must never call the raw `send`. Static pin with a
 * self-check that the scanner finds both replay occurrences.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'orchestrator', 'inject.ts'), 'utf8')
  .split(/\r?\n/)
  .join('\n')

/** Extract every `replay: <value>` property value: from `replay:` to the matching close of its arrow body. */
function replayBodies(src: string): string[] {
  const out: string[] = []
  const re = /\breplay\s*:\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    const start = i
    // value is an arrow function: scan to the first `{`, then balance braces
    const open = src.indexOf('{', i)
    if (open < 0) continue
    let depth = 1
    i = open + 1
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    out.push(src.slice(start, i))
  }
  return out
}

describe('replay re-entry', () => {
  const bodies = replayBodies(SRC)

  test('self-check: finds both replay occurrences (online no-op + autospawn)', () => {
    expect(bodies.length).toBe(2)
  })

  test('every non-empty replay body re-enters dispatch and never calls the raw send', () => {
    const nonEmpty = bodies.filter((b) => b.replace(/\s+/g, '').replace(/\/\/[^\n]*/g, '') !== 'async()=>{}')
    expect(nonEmpty.length).toBeGreaterThanOrEqual(1)
    for (const b of nonEmpty) {
      expect(b).toContain('.dispatch(')
      expect(b).not.toMatch(/\bawait\s+send\s*\(/)
      expect(b).not.toMatch(/(?<![.\w])send\s*\(/)
    }
  })

  test('no `await send(` anywhere inside inject.ts outside the pipeline deps', () => {
    expect(SRC).not.toMatch(/\bawait\s+send\s*\(/)
  })
})
