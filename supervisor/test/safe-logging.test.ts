/**
 * Regression coverage for the 2026-05-31 prod outage: a broken stdout pipe to
 * a dead Tauri tray parent made `console.*` throw EPIPE, which surfaced as an
 * uncaughtException mid-`session.stop()` and aborted slot cleanup → leaked
 * slots → blanket `concurrency_cap` denials.
 *
 * These assert the logging layer can NEVER throw on a broken pipe and that the
 * std streams carry an EPIPE-swallowing 'error' listener.
 */
import { describe, test, expect } from 'bun:test'
import { isBrokenPipe, installStreamErrorGuards, makeSafeTee } from '../src/safe-logging'
import { EventEmitter } from 'events'

describe('isBrokenPipe', () => {
  test('matches EPIPE by code', () => {
    expect(isBrokenPipe(Object.assign(new Error('write'), { code: 'EPIPE' }))).toBe(true)
  })
  test('matches by message text', () => {
    expect(isBrokenPipe(new Error('EPIPE: broken pipe, write'))).toBe(true)
  })
  test('matches stream-destroyed family', () => {
    expect(isBrokenPipe({ code: 'ERR_STREAM_DESTROYED' })).toBe(true)
    expect(isBrokenPipe({ code: 'EBADF' })).toBe(true)
  })
  test('does NOT match unrelated errors', () => {
    expect(isBrokenPipe(new Error('boom'))).toBe(false)
    expect(isBrokenPipe(null)).toBe(false)
  })
})

describe('installStreamErrorGuards', () => {
  test('attaches an error listener that swallows EPIPE (no rethrow)', () => {
    const s = new EventEmitter() as any
    installStreamErrorGuards([s])
    expect(s.listenerCount('error')).toBe(1)
    // Emitting 'error' with a listener present must NOT throw.
    expect(() => s.emit('error', Object.assign(new Error('w'), { code: 'EPIPE' }))).not.toThrow()
  })
})

describe('makeSafeTee', () => {
  test('does NOT throw to caller when the console write throws EPIPE', () => {
    const fileLines: string[] = []
    const throwingOrig = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }) }
    const tee = makeSafeTee(throwingOrig, 'INFO', (l) => fileLines.push(l))
    // The whole point: a broken stdout pipe must not propagate.
    expect(() => tee('hello', { a: 1 })).not.toThrow()
    // File logging still happened — degraded to file-only, not lost.
    expect(fileLines.length).toBe(1)
    expect(fileLines[0]).toContain('INFO')
    expect(fileLines[0]).toContain('hello')
  })

  test('does NOT throw even when BOTH console and file writes throw', () => {
    const throwingOrig = () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }) }
    const tee = makeSafeTee(throwingOrig, 'ERROR', () => { throw new Error('disk full') })
    expect(() => tee('boom')).not.toThrow()
  })

  test('normal path still writes to both sinks', () => {
    const consoleArgs: any[][] = []
    const fileLines: string[] = []
    const tee = makeSafeTee((...a) => consoleArgs.push(a), 'WARN', (l) => fileLines.push(l))
    tee('msg', 42)
    expect(consoleArgs).toEqual([['msg', 42]])
    expect(fileLines[0]).toContain('WARN msg 42')
  })
})
