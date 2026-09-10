import { test, expect } from 'bun:test'
import { CompositionInputTracker } from '../src/components/TerminalSurface'

/**
 * IME / dictation commit fuzz + regression suite.
 *
 * The two real-world event orderings are:
 *   chrome/android : beforeinput(insertCompositionText, "ab") … compositionend("ab")
 *   ios/end-first  : beforeinput(insertCompositionText, "ab") … compositionend("ab")
 *                    … beforeinput(insertText, "ab")
 * They are IDENTICAL up to and including compositionend, so no decision taken
 * inside onCompositionEnd can be right for both. See the design comment above
 * CompositionInputTracker.
 */

/** Terminal line model: DEL pops one CODE POINT, everything else appends. */
function replay(chunks: (string | null)[]): string {
  const cps: string[] = []
  for (const c of chunks) {
    if (c == null) continue
    for (const ch of Array.from(c)) {
      if (ch === '\x7f') cps.pop()
      else cps.push(ch)
    }
  }
  return cps.join('')
}

type Ev =
  | { t: 'start'; dt: number }
  | { t: 'end'; data: string | null; dt: number }
  | { t: 'bi'; it: string; data: string | null; dt: number }

/** Drives the tracker over a timed trace, collecting every emitted chunk. */
function run(evs: Ev[]): string {
  let clock = 1000
  const tr = new CompositionInputTracker(() => clock)
  const out: (string | null)[] = []
  for (const e of evs) {
    clock += e.dt
    if (e.t === 'start') tr.onCompositionStart()
    else if (e.t === 'end') out.push(tr.onCompositionEnd(e.data))
    else out.push(tr.handleBeforeInput(e.it, e.data))
  }
  return replay(out)
}

const S = (dt = 200): Ev => ({ t: 'start', dt })
const E = (data: string | null, dt = 50): Ev => ({ t: 'end', data, dt })
const B = (it: string, data: string | null, dt = 50): Ev => ({ t: 'bi', it, data, dt })
/** A beforeinput delivered in the SAME input burst as the preceding event. */
const Bnow = (it: string, data: string | null): Ev => ({ t: 'bi', it, data, dt: 0 })
/** A genuine human keystroke — never within the commit burst window. */
const Bkey = (data: string | null, it = 'insertText'): Ev => ({ t: 'bi', it, data, dt: 500 })

// ---------------------------------------------------------------- hand cases

test('chrome order: commit "ab" then a plain "X" keeps the X', () => {
  expect(run([S(), B('insertCompositionText', 'ab'), E('ab'), Bkey('X')])).toBe('abX')
})

test('chrome order: commit "ab" then two plain chars keeps both', () => {
  expect(run([S(), B('insertCompositionText', 'ab'), E('ab'), Bkey('X'), Bkey('Y')])).toBe('abXY')
})

test('chrome order: commit then Enter forwards CR', () => {
  expect(run([S(), B('insertCompositionText', 'hi'), E('hi'), Bkey(null, 'insertLineBreak')])).toBe('hi\r')
})

test('chrome order: commit then Backspace deletes one char', () => {
  expect(run([S(), B('insertCompositionText', 'hi'), E('hi'), Bkey(null, 'deleteContentBackward')])).toBe('h')
})

test('end-first order, same final: exactly one copy', () => {
  expect(run([S(), B('insertCompositionText', 'ab'), E('ab'), Bnow('insertText', 'ab')])).toBe('ab')
})

test('end-first order, differing final: the corrected text, once', () => {
  expect(run([S(), B('insertCompositionText', 'teh'), E('the'), Bnow('insertText', 'the')])).toBe('the')
})

test('end-first order, trailing beforeinput repeats STALE interim data', () => {
  expect(run([S(), B('insertCompositionText', 'hel'), E('hello'), Bnow('insertCompositionText', 'hel')])).toBe('hello')
})

test('chrome order, differing final ("teh" -> "the") then X', () => {
  expect(run([S(), B('insertCompositionText', 'teh'), E('the'), Bkey('X')])).toBe('theX')
})

test('two back-to-back CJK compositions, chrome order', () => {
  expect(
    run([S(), B('insertCompositionText', '你好'), E('你好'), S(), B('insertCompositionText', '世界'), E('世界')]),
  ).toBe('你好世界')
})

test('two back-to-back CJK compositions, end-first order', () => {
  expect(
    run([
      S(), B('insertCompositionText', '你好'), E('你好'), Bnow('insertText', '你好'),
      S(), B('insertCompositionText', '世界'), E('世界'), Bnow('insertText', '世界'),
    ]),
  ).toBe('你好世界')
})

test('cancelled composition retracts the interim bytes, then X types cleanly', () => {
  expect(run([S(), B('insertCompositionText', 'abc'), E(''), Bkey('X')])).toBe('X')
})

test('cancelled composition retracts emoji as exactly one DEL per code point', () => {
  expect(run([S(), B('insertCompositionText', 'ok 👍'), E('')])).toBe('')
})

test('dictation full-hypothesis stream, chrome order, lands exactly one copy', () => {
  const hyps = ['also fix', 'also fixed', 'also fixed this']
  expect(run([S(), ...hyps.map((h) => B('insertCompositionText', h)), E('also fixed this')])).toBe('also fixed this')
})

test('dictation full-hypothesis stream, end-first order, lands exactly one copy', () => {
  const hyps = ['also fix', 'also fixed', 'also fixed this']
  expect(
    run([S(), ...hyps.map((h) => B('insertCompositionText', h)), E('also fixed this'), Bnow('insertText', 'also fixed this')]),
  ).toBe('also fixed this')
})

test('plain typing outside any composition is 1:1', () => {
  expect(run([Bkey('a'), Bkey('b'), Bkey(null, 'deleteContentBackward'), Bkey('c')])).toBe('ac')
})

// ---------------------------------------------------------------------- fuzz

let seed = 0x2f6e2b1
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
const ALPHA = ['a', 'b', 'c', 'd', '你', '好', '👍']

function genCase(): { evs: Ev[]; expected: string } {
  const evs: Ev[] = []
  const expected: string[] = []
  const push = (s: string) => { for (const ch of Array.from(s)) expected.push(ch) }
  const n = 1 + Math.floor(rnd() * 4)
  for (let k = 0; k < n; k++) {
    const kind = rnd()
    if (kind < 0.55) {
      const chromeOrder = rnd() < 0.5
      const interims: string[] = []
      let cur = ''
      const steps = 1 + Math.floor(rnd() * 4)
      for (let s = 0; s < steps; s++) {
        if (rnd() < 0.75) cur = cur + pick(ALPHA)
        else cur = Array.from(cur).slice(0, Math.max(0, Array.from(cur).length - 1)).join('') + pick(ALPHA)
        interims.push(cur)
      }
      const last = interims[interims.length - 1]
      const fr = rnd()
      const final = fr < 0.5 ? last : fr < 0.8 ? last + pick(ALPHA) : ''
      evs.push(S())
      for (const i of interims) evs.push(B('insertCompositionText', i))
      if (chromeOrder) {
        if (final !== '' && final !== last) evs.push(B('insertCompositionText', final))
        evs.push(E(final))
      } else {
        evs.push(E(final))
        if (final !== '') evs.push(Bnow('insertText', final))
      }
      push(final)
    } else if (kind < 0.85) {
      const c = pick(ALPHA)
      evs.push(Bkey(c))
      push(c)
    } else {
      evs.push(Bkey(null, 'deleteContentBackward'))
      expected.pop()
    }
  }
  return { evs, expected: expected.join('') }
}

test('fuzz: 5000 seeded IME traces replay to the expected line', () => {
  let mismatches = 0
  const firstThree: string[] = []
  for (let i = 0; i < 5000; i++) {
    const { evs, expected } = genCase()
    const got = run(evs)
    if (got !== expected) {
      mismatches++
      if (firstThree.length < 3) {
        firstThree.push(
          `#${i} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}\n   trace=` +
            evs
              .map((e) =>
                e.t === 'start'
                  ? 'START'
                  : e.t === 'end'
                    ? `END(${JSON.stringify(e.data)})`
                    : `BI[${e.it}](${JSON.stringify(e.data)})`,
              )
              .join(' -> '),
        )
      }
    }
  }
  if (mismatches > 0) {
    console.log(`MISMATCHES: ${mismatches}/5000`)
    for (const f of firstThree) console.log(f)
  }
  expect(mismatches).toBe(0)
})
