import { describe, expect, test } from 'bun:test'
import { RingBuffer, safeTrimPoint } from '../src/runners/pty-persistence'

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
