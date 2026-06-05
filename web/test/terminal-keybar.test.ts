/**
 * Terminal key-bar byte sequences.
 *
 * The user's Apple keyboard has no arrow keys, so the on-screen ↑/↓ buttons are
 * the only way to drive Claude/Codex TUI menus. These assert the exact raw bytes
 * each toolbar key emits (encoded the same way real keystrokes are) so a typo in
 * an escape sequence can't silently break menu navigation.
 */
import { describe, test, expect } from 'bun:test'
import { KEY_SEQUENCES, inputToB64, b64ToBytes, bytesToB64 } from '../src/components/TerminalSurface'

const bytesOf = (seq: string) => Array.from(b64ToBytes(inputToB64(seq)))

describe('terminal key-bar sequences', () => {
  test('arrow keys emit the correct CSI sequences', () => {
    expect(bytesOf(KEY_SEQUENCES.up)).toEqual([0x1b, 0x5b, 0x41])    // ESC [ A
    expect(bytesOf(KEY_SEQUENCES.down)).toEqual([0x1b, 0x5b, 0x42])  // ESC [ B
    expect(bytesOf(KEY_SEQUENCES.left)).toEqual([0x1b, 0x5b, 0x44])  // ESC [ D
    expect(bytesOf(KEY_SEQUENCES.right)).toEqual([0x1b, 0x5b, 0x43]) // ESC [ C
  })

  test('control keys emit single control bytes', () => {
    expect(bytesOf(KEY_SEQUENCES.esc)).toEqual([0x1b])   // ESC
    expect(bytesOf(KEY_SEQUENCES.tab)).toEqual([0x09])   // HT
    expect(bytesOf(KEY_SEQUENCES.enter)).toEqual([0x0d]) // CR
    expect(bytesOf(KEY_SEQUENCES.ctrlC)).toEqual([0x03]) // ETX
  })

  test('bytesToB64 round-trips arbitrary binary (attachment upload path)', () => {
    const data = new Uint8Array([0x00, 0xff, 0x10, 0x89, 0x7f, 0x80])
    expect(Array.from(b64ToBytes(bytesToB64(data)))).toEqual(Array.from(data))
  })
})
