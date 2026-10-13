/**
 * PTYCAP-04-04 -- reserve-caller pins (`.planning/phases/PTYCAP-04-lifetime-inject-counter-kill-switch/`).
 *
 * Two structural pins on the durable lifetime ledger:
 *   1. `reserveInject(` is called only from the controls module itself and the PTY
 *      door. Any other caller would be a second, uncoordinated consumer of the
 *      ledger (T-04-15/-18). Plan 04-07 adds the self-heal route as an allowed
 *      caller with its reason.
 *   2. `counterKey` / `turnToken` may be handed to `checkPtyTurnPreflight(` only
 *      from server-side orchestrator code (hub/src/orchestrator/). The web relay
 *      (ws/client.ts) passes neither, so a client can never choose its own
 *      counter key or per-turn token (T-04-19).
 *
 * Pins scan raw text INCLUDING comments. If a pin flags a comment-only mention,
 * reword the comment -- never widen an allowlist to accommodate it.
 * DB-free: reads source text only.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

const norm = (p: string) => relative(SRC, p).split('\\').join('/')
const FILES = walk(SRC)
  .map((p) => ({ rel: norm(p), text: readFileSync(p, 'utf8') }))
  .filter((f) => !/\.test\.ts$/.test(f.rel))
const filesIncluding = (needle: string) => FILES.filter((f) => f.text.includes(needle)).map((f) => f.rel)

/** Text between the opening paren after `needle` and its matching close paren. */
function callArguments(text: string, needle: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return out
    let depth = 1
    let i = at + needle.length
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    out.push(text.slice(at + needle.length, i - 1))
    from = at + needle.length
  }
}

describe('PTYCAP-04-04 -- reserveInject( callers (T-04-15, T-04-18)', () => {
  const ALLOWED = new Set(['dispatch/automation-controls.ts', 'dispatch/pty-preflight.ts'])

  test('reserveInject( appears only in the controls module and the PTY door', () => {
    const hits = filesIncluding('reserveInject(')
    expect(hits.filter((f) => !ALLOWED.has(f))).toEqual([])
  })

  test('scanner self-check: it finds BOTH allowed sites (a broken scan fails, never passes vacuously)', () => {
    const hits = new Set(filesIncluding('reserveInject('))
    for (const a of ALLOWED) expect(hits.has(a)).toBe(true)
  })

  test('the door reserves with the per-turn token, never the constant per-session token', () => {
    const door = FILES.find((f) => f.rel === 'dispatch/pty-preflight.ts')!
    const [args] = callArguments(door.text, 'await reserveInject(')
    expect(args).toBeDefined()
    expect(args).toMatch(/token:\s*input\.turnToken/)
    expect(args).not.toMatch(/pty-preflight:/)
  })
})

describe('PTYCAP-04-04 -- counterKey / turnToken suppliers of the PTY door (T-04-19)', () => {
  test('checkPtyTurnPreflight( call arguments mention counterKey or turnToken only under hub/src/orchestrator/', () => {
    const offenders: string[] = []
    for (const f of FILES) {
      if (f.rel === 'dispatch/pty-preflight.ts') continue // the receiver, not a caller
      if (f.rel.startsWith('orchestrator/')) continue
      for (const args of callArguments(f.text, 'checkPtyTurnPreflight(')) {
        if (/\bcounterKey\b|\bturnToken\b/.test(args)) offenders.push(f.rel)
      }
    }
    expect(offenders).toEqual([])
  })

  test('scanner self-check: it finds the ws/client.ts call and that call passes neither field', () => {
    const client = FILES.find((f) => f.rel === 'ws/client.ts')!
    const calls = callArguments(client.text, 'checkPtyTurnPreflight(')
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args).not.toMatch(/\bcounterKey\b|\bturnToken\b/)
    }
  })

  test('callArguments extracts balanced argument text (helper self-check)', () => {
    const args = callArguments('x = checkPtyTurnPreflight({ a: f(1), b: 2 }) + y', 'checkPtyTurnPreflight(')
    expect(args).toEqual(['{ a: f(1), b: 2 }'])
  })
})
