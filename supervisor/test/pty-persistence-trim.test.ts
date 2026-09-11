import { describe, expect, test } from 'bun:test'
import { MAX_TRIM_HOLDBACK_BYTES, RingBuffer, safeTrimPoint } from '../src/runners/pty-persistence'

/**
 * Parity fixture table — the Rust `pty_host.rs` test module
 * (`safe_trim_point_parity_fixtures`) asserts the identical inputs/expected
 * values. Keep both tables in lock-step.
 */
const PARITY_FIXTURES: Array<{ label: string; buf: string; rawCut: number; expected: number }> = [
  {
    label: 'CSI introducer byte must not be mistaken for a final byte',
    buf: 'XXXX\x1b[38;5;6mHELLO',
    rawCut: 8,
    expected: 4,
  },
  {
    label: 'cut lands inside OSC content (unterminated)',
    buf: '\x1b]0;title\x07REST',
    rawCut: 5,
    expected: 0,
  },
  {
    label: 'OSC already terminated by BEL before the cut',
    buf: '\x1b]0;title\x07REST',
    rawCut: 10,
    expected: 10,
  },
  {
    label: 'cut lands inside ST-terminated DCS content (unterminated)',
    buf: '\x1bP1$q\x1b\\REST',
    rawCut: 3,
    expected: 0,
  },
  {
    label: 'cut lands exactly at an ESC byte',
    buf: 'AB\x1b[31mCD',
    rawCut: 2,
    expected: 2,
  },
  {
    label: 'cut lands right after a CSI final byte',
    buf: '\x1b[31mAB',
    rawCut: 5,
    expected: 5,
  },
  {
    label: 'no escape sequence nearby',
    buf: 'HELLOWORLD',
    rawCut: 5,
    expected: 5,
  },
  {
    // round-2 QC MAJOR: the formerly-fixed 256-byte scan window missed this
    // entirely (an OSC-8 hyperlink with a >256-byte URL) and returned rawCut
    // unchanged. Fixture matches the reported case: 440-byte OSC-8, cut at 330.
    label: 'a >256-byte OSC-8 hyperlink (longer than the old fixed scan window) cut deep in the URL payload',
    buf: '\x1b]8;;https://example.com/' + 'a'.repeat(400) + '\x07LINKTEXT\x1b]8;;\x07',
    rawCut: 330,
    expected: 0,
  },
  {
    // A 70 KB DCS/sixel-shaped payload, cut well past any fixed window,
    // still unterminated at the cut.
    label: 'a 70 KB unterminated DCS payload cut mid-way',
    buf: '\x1bP' + '1'.repeat(70000),
    rawCut: 40000,
    expected: 0,
  },
  {
    // An ST-terminated OSC followed by unrelated padding, then a cut inside
    // a LATER, separate unterminated CSI — proves the "keep scanning
    // backward past a closed candidate" walk doesn't over-shoot past the
    // OSC's own terminator into treating the later CSI as safe.
    label: 'a cut inside a later CSI following an already ST-terminated OSC',
    buf: '\x1b]0;title\x1b\\PAD\x1b[38;5;6mHELLO',
    rawCut: 20,
    expected: 14,
  },
  {
    // round-2 QC fuzz (34/20000 cases): an "ESC M" two-byte escape embedded
    // in a still-open, never-BEL/ST-terminated OSC. Evaluated in isolation
    // "ESC M" looks like a closed, harmless 2-byte escape (the nearest-ESC-
    // only bug), but the cut is still inside the OUTER unterminated OSC.
    label: 'an embedded "ESC M" two-byte escape inside a still-open unterminated OSC is not mistaken for the whole sequence being closed',
    buf: '\x1b]0;\x1bMtitle',
    rawCut: 11,
    expected: 0,
  },
]

describe('safeTrimPoint', () => {
  for (const { label, buf, rawCut, expected } of PARITY_FIXTURES) {
    test(label, () => {
      expect(safeTrimPoint(buf, rawCut)).toBe(expected)
    })
  }

  test('regression: CSI "[" introducer byte no longer treated as an already-closed sequence', () => {
    // Pre-fix defect: the "terminated" scan treated 0x40-0x7e as a final byte,
    // but CSI\'s own introducer "[" (0x5b) falls in that range, so every
    // "ESC [ ... m" was wrongly declared terminated and rawCut returned
    // unchanged -> replay desyncs starting mid-parameter-string.
    const buf = 'XXXX\x1b[38;5;6mHELLO'
    expect(safeTrimPoint(buf, 8)).not.toBe(8)
  })
})

describe('RingBuffer trim never wipes the whole ring on an unterminated trailing escape', () => {
  test('unterminated CSI at the very end of a full ring is preserved, not discarded', () => {
    // Pre-fix defect: when no terminator was found and no later ESC existed,
    // the fallback returned buf.length, discarding the ENTIRE ring.
    const ring = new RingBuffer(2)
    ring.push('AB\x1b[3') // 5 bytes; overflow=3, cut lands inside unterminated CSI
    const out = ring.snapshot()
    expect(out.length).toBeGreaterThan(0)
    expect(out).toBe('\x1b[3')
  })

  test('cut mid-OSC with content past the cap keeps the escape intact', () => {
    const ring = new RingBuffer(4)
    ring.push('AB\x1b]0;title') // overflow lands inside the OSC title text
    const out = ring.snapshot()
    expect(out.length).toBeGreaterThan(0)
    expect(out.startsWith('\x1b]')).toBe(true)
  })

  test('probe: "XXXX\\x1b[38;5;6mHELLO" replay never starts mid-parameter-string', () => {
    const ring = new RingBuffer(8)
    ring.push('XXXX\x1b[38;5;6mHELLO')
    const out = ring.snapshot()
    // Must never start with an orphaned CSI parameter/final byte with no
    // preceding ESC (e.g. the bare ";5;6mHELLO" tail from the pre-fix bug).
    expect(out.length === 0 || out.charCodeAt(0) === 0x1b || !/[\x30-\x7e]/.test(out[0])).toBe(
      true,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Round-5: escape-grammar correctness (F1) + bounded ring (F2).
//
// The ORACLE below is an intentionally INDEPENDENT implementation of the same
// ECMA-48 grammar, written in a different shape from the production scanner (it
// consumes whole sequences by explicit lookahead and paints an "inside" map,
// rather than stepping a byte state machine). Tests compare production output
// against the oracle, never against production's own logic.
// ─────────────────────────────────────────────────────────────────────────────

const ESC = 0x1b

/**
 * Returns, for every index 0..buf.length, the start index of the escape
 * sequence STRICTLY containing that index, or -1 when the index is a ground
 * (safe) cut point. Parses forward from 0, which is ground by construction.
 */
function oracleEnclosingSequenceStart(buf: string): Int32Array {
  const n = buf.length
  const owner = new Int32Array(n + 1).fill(-1)
  const at = (i: number) => (i < n ? buf.charCodeAt(i) : -1)
  let i = 0
  while (i < n) {
    if (at(i) !== ESC) {
      i++
      continue
    }
    const start = i
    let end: number // exclusive end of the sequence; n when unterminated
    const b = at(start + 1)
    if (b === -1) {
      end = n // lone trailing ESC — unterminated
    } else if (b >= 0x20 && b <= 0x2f) {
      // nF: intermediates 0x20-0x2F then a final 0x30-0x7E
      let k = start + 2
      while (k < n && at(k) >= 0x20 && at(k) <= 0x2f) k++
      end = k < n ? k + 1 : n
    } else if ((b >= 0x30 && b <= 0x3f) || (b >= 0x60 && b <= 0x7e)) {
      end = start + 2 // Fp / Fs — complete two-byte escape
    } else if (b === 0x5b) {
      // CSI: params/intermediates 0x20-0x3F, final 0x40-0x7E
      let k = start + 2
      while (k < n && at(k) >= 0x20 && at(k) <= 0x3f) k++
      end = k < n ? k + 1 : n
    } else if (b === 0x5d || b === 0x50 || b === 0x5e || b === 0x5f || b === 0x58) {
      // OSC / DCS / PM / APC / SOS — string, closed by BEL or ST (ESC \)
      let k = start + 2
      end = n
      while (k < n) {
        if (at(k) === 0x07) {
          end = k + 1
          break
        }
        if (at(k) === ESC && at(k + 1) === 0x5c) {
          end = k + 2
          break
        }
        k++
      }
    } else {
      end = start + 2 // any other Fe — complete two-byte escape
    }
    for (let k = start + 1; k < end && k <= n; k++) owner[k] = start
    i = Math.max(end, start + 1)
  }
  return owner
}

describe('safeTrimPoint escape grammar (F1) — never starts the retained region mid-sequence', () => {
  const F1_REPROS: Array<{ label: string; buf: string; rawCut: number; expected: number }> = [
    {
      label: 'ESC 7 (Fp, DECSC) embedded in a still-open OSC does not close the OSC',
      buf: '\x1b]0;AAAA\x1b7BBBB',
      rawCut: 14,
      expected: 0,
    },
    {
      label: 'ESC 8 (Fp) embedded in a still-open OSC does not close it',
      buf: '\x1b]0;AAAA\x1b8BBBB',
      rawCut: 12,
      expected: 0,
    },
    {
      label: 'ESC ( B (nF charset designation) embedded in a still-open DCS does not close it',
      buf: '\x1bP1$q\x1b(Bpayload',
      rawCut: 12,
      expected: 0,
    },
    {
      label: 'ESC = (Fp, DECKPAM) embedded in a still-open APC does not close it',
      buf: '\x1b_data\x1b=more',
      rawCut: 9,
      expected: 0,
    },
    {
      label: 'a bare Fp escape (ESC 7) is a COMPLETE two-byte sequence',
      buf: 'AA\x1b7BB',
      rawCut: 4,
      expected: 4,
    },
    {
      label: 'a bare Fs escape (ESC c, RIS) is a COMPLETE two-byte sequence',
      buf: 'AA\x1bcBB',
      rawCut: 4,
      expected: 4,
    },
    {
      label: 'a cut INSIDE an nF sequence (ESC ( B) holds back to its start',
      buf: 'AA\x1b(BXX',
      rawCut: 4,
      expected: 2,
    },
    {
      label: 'an nF sequence is complete once its final byte is consumed',
      buf: 'AA\x1b(BXX',
      rawCut: 5,
      expected: 5,
    },
    {
      label: 'SOS (ESC X) is a string sequence, not a two-byte escape',
      buf: '\x1bXpayload',
      rawCut: 5,
      expected: 0,
    },
  ]
  for (const { label, buf, rawCut, expected } of F1_REPROS) {
    test(label, () => {
      expect(safeTrimPoint(buf, rawCut)).toBe(expected)
    })
  }

  test('seeded fuzz: 20000 cases agree exactly with the independent oracle', () => {
    let s = 0x5eed17
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const ri = (n: number) => Math.floor(rnd() * n)
    const INTRO = [0x5b, 0x5d, 0x50, 0x5e, 0x5f, 0x58, 0x4d, 0x37, 0x28, 0x3d, 0x63]
    const EMBEDDED = [0x4d, 0x5b, 0x5d, 0x37, 0x38, 0x3d, 0x28]
    const seq = (): number[] => {
      const intro = INTRO[ri(INTRO.length)]!
      const out = [ESC, intro]
      if (intro === 0x5b) {
        for (let i = ri(300); i > 0; i--) out.push(0x30 + ri(16))
        if (rnd() < 0.75) out.push(0x40 + ri(0x3f))
      } else if (intro === 0x28) {
        if (rnd() < 0.8) out.push(0x41 + ri(26))
      } else if ([0x5d, 0x50, 0x5e, 0x5f, 0x58].includes(intro)) {
        for (let i = ri(400); i > 0; i--) {
          if (rnd() < 0.06) out.push(ESC, EMBEDDED[ri(EMBEDDED.length)]!)
          else out.push(0x20 + ri(0x5f))
        }
        if (rnd() < 0.7) {
          if (rnd() < 0.5) out.push(0x07)
          else out.push(ESC, 0x5c)
        }
      }
      return out
    }

    let unsafe = 0
    let mismatched = 0
    let overshoot = 0
    for (let c = 0; c < 20000; c++) {
      const bytes: number[] = []
      for (let i = 1 + ri(6); i > 0; i--) {
        for (let j = ri(40); j > 0; j--) bytes.push(0x41 + ri(26))
        bytes.push(...seq())
      }
      for (let j = ri(40); j > 0; j--) bytes.push(0x41 + ri(26))
      if (bytes.length === 0) bytes.push(0x41)
      const buf = String.fromCharCode(...bytes)
      const rawCut = 1 + ri(buf.length)

      const owner = oracleEnclosingSequenceStart(buf)
      const got = safeTrimPoint(buf, rawCut)
      if (got > rawCut) overshoot++
      if (owner[got] !== -1) unsafe++ // retained region starts strictly inside a sequence
      const start = owner[rawCut]!
      const want = start === -1 || rawCut - start > MAX_TRIM_HOLDBACK_BYTES ? rawCut : start
      if (got !== want) mismatched++
    }
    expect({ unsafe, mismatched, overshoot }).toEqual({ unsafe: 0, mismatched: 0, overshoot: 0 })
  })
})

describe('RingBuffer stays bounded (F2) — an unterminated sequence can never pin the ring', () => {
  test('a 4 MiB unterminated OSC then 50k single-byte pushes stays <= cap + MAX_TRIM_HOLDBACK_BYTES', () => {
    const cap = 1 << 20
    const ring = new RingBuffer(cap)
    ring.push('\x1b]0;' + 'A'.repeat(4 * 1024 * 1024))
    const t0 = performance.now()
    for (let i = 0; i < 50_000; i++) ring.push('B')
    const elapsedMs = performance.now() - t0
    expect(ring.size).toBeLessThanOrEqual(cap + MAX_TRIM_HOLDBACK_BYTES)
    // Flat per-push cost: 50k pushes must not rescan the whole overflow each
    // time. Generous ceiling (pre-fix this was ~63 us/push == >3 s).
    expect(elapsedMs).toBeLessThan(1500)
  })

  test('an unterminated CSI at the ring front is eventually cut rather than held forever', () => {
    const cap = 64
    const ring = new RingBuffer(cap)
    ring.push('\x1b[' + '1'.repeat(200_000))
    expect(ring.size).toBeLessThanOrEqual(cap + MAX_TRIM_HOLDBACK_BYTES)
  })

  test('a short unterminated sequence IS still held back intact', () => {
    const ring = new RingBuffer(4)
    ring.push('ABCD\x1b]0;ti')
    expect(ring.snapshot().startsWith('\x1b]')).toBe(true)
  })
})
