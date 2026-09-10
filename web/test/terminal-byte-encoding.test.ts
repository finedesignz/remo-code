/**
 * Regression: the PTY terminal byte path must preserve RAW BYTES end-to-end.
 *
 * The 2026-06-04 bug: the supervisor utf8-decoded PTY bytes to a string and the
 * browser fed that binary string straight to xterm. Multibyte sequences (the
 * box-drawing borders of the claude/codex TUI) were corrupted — each 3-byte char
 * collapsed to one garbage byte — so the TUI rendered as bare fragments and the
 * cursor desynced. Fix: bytes stay bytes; xterm runs the only UTF-8 decode.
 *
 * These guard the browser end of the contract (the pure helpers). They simulate
 * the supervisor seam (bridge emits raw-byte latin1 string → session-bridge
 * re-base64s it unchanged) and assert the original bytes survive.
 */
import { describe, test, expect } from 'bun:test'
import { inputToB64, b64ToBytes, inputEventToBytes } from '../src/components/TerminalSurface'

// Mirror of the (now-correct) supervisor output seam: raw PTY bytes → base64.
function supervisorWire(rawBytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < rawBytes.length; i++) bin += String.fromCharCode(rawBytes[i])
  return Buffer.from(bin, 'binary').toString('base64')
}

describe('PTY terminal byte encoding (regression)', () => {
  test('multibyte box-drawing + ANSI survive the output path byte-for-byte', () => {
    // "┌─┐" (each U+250x is 3 UTF-8 bytes) + ESC[1m + ASCII
    const original = new Uint8Array([
      0xe2, 0x94, 0x8c, 0xe2, 0x94, 0x80, 0xe2, 0x94, 0x90, // ┌─┐
      0x1b, 0x5b, 0x31, 0x6d, // ESC[1m
      0x41, 0x42, 0x43, // ABC
    ])
    const out = b64ToBytes(supervisorWire(original))
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  test('inputToB64 encodes keystrokes as UTF-8 bytes (incl. multibyte)', () => {
    // 'é' is 0xC3 0xA9; '\r' is 0x0D.
    const b64 = inputToB64('é\r')
    const bytes = Array.from(b64ToBytes(b64))
    expect(bytes).toEqual([0xc3, 0xa9, 0x0d])
  })

  test('plain ASCII input is unchanged', () => {
    expect(Array.from(b64ToBytes(inputToB64('ls\r')))).toEqual([0x6c, 0x73, 0x0d])
  })

  test('b64ToBytes is tolerant of garbage input (returns empty, never throws)', () => {
    expect(b64ToBytes('!!!not-base64!!!').length).toBe(0)
  })
})

/**
 * Exactly-once mobile/iOS input contract (the IME double-echo fix).
 *
 * iOS WebKit routes every keystroke through composition; we read committed text
 * off the helper textarea's `beforeinput` events and send it ONCE. These guard
 * the pure inputType→bytes mapping that the surface's beforeinput handler uses,
 * proving a single insertText 'a' maps to exactly one 'a' byte (no double) and
 * edit keys map to the right control bytes.
 */
describe('mobile input — exactly-once inputType→bytes mapping', () => {
  test("insertText 'a' → single 'a' byte (no doubling)", () => {
    const bytes = inputEventToBytes('insertText', 'a')
    expect(bytes).toBe('a')
    expect(Array.from(b64ToBytes(inputToB64(bytes!)))).toEqual([0x61])
  })

  test('composed/predictive commit (insertCompositionText) sends the committed text', () => {
    expect(inputEventToBytes('insertCompositionText', 'hi')).toBe('hi')
    expect(inputEventToBytes('insertReplacementText', 'the')).toBe('the')
  })

  test('Enter → CR, backspace → DEL, forward-delete → CSI 3~', () => {
    expect(inputEventToBytes('insertLineBreak', null)).toBe('\r')
    expect(inputEventToBytes('insertParagraph', null)).toBe('\r')
    expect(inputEventToBytes('deleteContentBackward', null)).toBe('\x7f')
    expect(inputEventToBytes('deleteContentForward', null)).toBe('\x1b[3~')
  })

  test('empty / unknown inputType yields null (caller defers to xterm onData)', () => {
    expect(inputEventToBytes('insertText', '')).toBeNull()
    expect(inputEventToBytes('insertText', null)).toBeNull()
    expect(inputEventToBytes('historyUndo', null)).toBeNull()
    expect(inputEventToBytes('formatBold', null)).toBeNull()
  })
})
