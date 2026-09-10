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
 *
 * TIMING IS NOT A SIGNAL. An earlier attempt (#467) suppressed the trailing
 * commit only inside a 30ms burst window. That measured HANDLER EXECUTION time
 * (WebSocket send + textarea keepalive + React render), not dispatch time, so a
 * GC pause or a slow phone pushed the engine's own commit outside the window
 * and double-sent ("abab"). Every gap in this fuzz is therefore randomized over
 * 0-200ms: any tracker that reads a clock fails it.
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
  | { t: 'bi'; it: string; data: string | null; dt: number; human?: true }

/** Drives the tracker over a trace, collecting every emitted chunk. */
function run(evs: Ev[]): string {
  const tr = new CompositionInputTracker()
  const out: (string | null)[] = []
  for (const e of evs) {
    if (e.t === 'start') tr.onCompositionStart()
    else if (e.t === 'end') out.push(tr.onCompositionEnd(e.data))
    else out.push(tr.handleBeforeInput(e.it, e.data))
  }
  return replay(out)
}

const S = (dt = 200): Ev => ({ t: 'start', dt })
const E = (data: string | null, dt = 50): Ev => ({ t: 'end', data, dt })
const B = (it: string, data: string | null, dt = 50): Ev => ({ t: 'bi', it, data, dt })
/** The engine's own trailing delivery of a commit. Its delay is irrelevant. */
const Bcommit = (data: string | null, it = 'insertText', dt = 0): Ev => ({ t: 'bi', it, data, dt })
/** A genuine human keystroke. */
const Bkey = (data: string | null, it = 'insertText'): Ev => ({ t: 'bi', it, data, dt: 500, human: true })

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
  expect(run([S(), B('insertCompositionText', 'ab'), E('ab'), Bcommit('ab')])).toBe('ab')
})

test('end-first order, differing final: the corrected text, once', () => {
  expect(run([S(), B('insertCompositionText', 'teh'), E('the'), Bcommit('the')])).toBe('the')
})

test('end-first order, trailing beforeinput repeats STALE interim data', () => {
  expect(run([S(), B('insertCompositionText', 'hel'), E('hello'), Bcommit('hel', 'insertCompositionText')])).toBe('hello')
})

test('end-first order: a JANKY trailing commit 2000ms later is still suppressed (#467 defect)', () => {
  expect(run([S(), B('insertCompositionText', 'ab'), E('ab'), Bcommit('ab', 'insertText', 2000)])).toBe('ab')
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
      S(), B('insertCompositionText', '你好'), E('你好'), Bcommit('你好'),
      S(), B('insertCompositionText', '世界'), E('世界'), Bcommit('世界'),
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
    run([S(), ...hyps.map((h) => B('insertCompositionText', h)), E('also fixed this'), Bcommit('also fixed this')]),
  ).toBe('also fixed this')
})

test('plain typing outside any composition is 1:1', () => {
  expect(run([Bkey('a'), Bkey('b'), Bkey(null, 'deleteContentBackward'), Bkey('c')])).toBe('ac')
})

// ------------------------------------------------------- learned engine order

test('a chrome-order engine stops arming once observed, so a retyped char survives', () => {
  // First composition teaches the tracker this engine is chrome-order (its
  // compositionend was followed by a NON-matching event). From then on the
  // ambiguous "compose a, then type a" case resolves in favour of the human.
  expect(
    run([
      S(), B('insertCompositionText', 'zz'), E('zz'), Bkey('q'),
      S(), B('insertCompositionText', 'a'), E('a'), Bkey('a'),
    ]),
  ).toBe('zzqaa')
})

test('an end-first engine keeps arming across utterances, never double-sending', () => {
  expect(
    run([
      S(), B('insertCompositionText', 'zz'), E('zz'), Bcommit('zz'),
      S(), B('insertCompositionText', 'ab'), E('ab'), Bcommit('ab'),
      S(), B('insertCompositionText', 'cd'), E('cd'), Bcommit('cd'),
    ]),
  ).toBe('zzabcd')
})

// ---------------------------------------------------------------------- fuzz

let seed = 0x2f6e2b1
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]
const ALPHA = ['a', 'b', 'c', 'd', '你', '好', '👍']
/** Real-world jank: GC, React render, a slow phone. Every gap is unpredictable. */
const jitter = () => Math.floor(rnd() * 201)

/** One trace from ONE engine — a real browser does not switch ordering mid-session. */
function genCase(chromeOrder: boolean): { evs: Ev[]; expected: string } {
  const evs: Ev[] = []
  const expected: string[] = []
  const push = (s: string) => { for (const ch of Array.from(s)) expected.push(ch) }
  const n = 1 + Math.floor(rnd() * 4)
  for (let k = 0; k < n; k++) {
    const kind = rnd()
    if (kind < 0.55) {
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
      evs.push({ t: 'start', dt: jitter() })
      for (const i of interims) evs.push({ t: 'bi', it: 'insertCompositionText', data: i, dt: jitter() })
      if (chromeOrder) {
        if (final !== '' && final !== last) evs.push({ t: 'bi', it: 'insertCompositionText', data: final, dt: jitter() })
        evs.push({ t: 'end', data: final, dt: jitter() })
      } else {
        evs.push({ t: 'end', data: final, dt: jitter() })
        if (final !== '') evs.push({ t: 'bi', it: 'insertText', data: final, dt: jitter() })
      }
      push(final)
    } else if (kind < 0.85) {
      const c = pick(ALPHA)
      evs.push({ t: 'bi', it: 'insertText', data: c, dt: jitter(), human: true })
      push(c)
    } else {
      evs.push({ t: 'bi', it: 'deleteContentBackward', data: null, dt: jitter(), human: true })
      expected.pop()
    }
  }
  return { evs, expected: expected.join('') }
}

/**
 * The one irreducible ambiguity: a compositionend committing text T immediately
 * followed by a HUMAN keystroke that types exactly T. Nothing in the DOM
 * distinguishes that from the engine re-delivering its own commit.
 */
function isRetypeSameText(evs: Ev[]): boolean {
  for (let j = 0; j + 1 < evs.length; j++) {
    const end = evs[j]
    const next = evs[j + 1]
    if (end.t !== 'end' || end.data === '' || end.data == null) continue
    if (next.t !== 'bi' || next.human !== true) continue
    if (next.data === end.data) return true
  }
  return false
}

/** Index of the first compositionend that arms (non-cancel), or -1. */
function firstArmingEndIndex(evs: Ev[]): number {
  return evs.findIndex((e) => e.t === 'end' && e.data !== '' && e.data != null)
}

function fuzz(chromeOrder: boolean) {
  let mismatches = 0
  let retype = 0
  let afterLearning = 0
  const examples: string[] = []
  for (let i = 0; i < 5000; i++) {
    const { evs, expected } = genCase(chromeOrder)
    const got = run(evs)
    if (got === expected) continue
    mismatches++
    if (isRetypeSameText(evs)) {
      retype++
      // For a chrome engine the ambiguity may only bite BEFORE the ordering is
      // learned, i.e. on the trace's first arming compositionend.
      const first = firstArmingEndIndex(evs)
      const offending = evs.findIndex(
        (e, j) => e.t === 'end' && e.data !== '' && e.data != null && evs[j + 1]?.t === 'bi' && (evs[j + 1] as Ev & { data: string | null }).data === e.data && (evs[j + 1] as { human?: true }).human === true,
      )
      if (offending !== first) afterLearning++
    } else if (examples.length < 3) {
      examples.push(
        `#${i} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}\n   trace=` +
          evs
            .map((e) =>
              e.t === 'start'
                ? `START(+${e.dt})`
                : e.t === 'end'
                  ? `END(${JSON.stringify(e.data)},+${e.dt})`
                  : `BI[${e.it}](${JSON.stringify(e.data)},+${e.dt}${e.human ? ',human' : ''})`,
            )
            .join(' -> '),
      )
    }
  }
  return { mismatches, retype, afterLearning, examples }
}

test('fuzz: 5000 jittered chrome-order traces — no mismatch outside the retype ambiguity, none after learning', () => {
  seed = 0x2f6e2b1
  const r = fuzz(true)
  console.log(
    `chrome-order: mismatches=${r.mismatches}/5000 (retype-same-text=${r.retype}, after-learning=${r.afterLearning})`,
  )
  for (const e of r.examples) console.log(e)
  // Every mismatch is the irreducible retype ambiguity …
  expect(r.mismatches).toBe(r.retype)
  // … and the learned-ordering flag confines it to the session's FIRST utterance.
  expect(r.afterLearning).toBe(0)
})

test('fuzz: 5000 jittered end-first traces — no mismatch outside the retype ambiguity', () => {
  seed = 0x5c1d77
  const r = fuzz(false)
  console.log(`end-first: mismatches=${r.mismatches}/5000 (retype-same-text=${r.retype})`)
  for (const e of r.examples) console.log(e)
  expect(r.mismatches).toBe(r.retype)
})
