import { describe, expect, test } from 'bun:test'
import { readFrames } from '../src/codex-jsonrpc'

describe('readFrames (ndjson)', () => {
  test('parses complete newline-delimited frames', () => {
    const out = readFrames('{"a":1}\n{"b":2}\n', 'unknown')
    expect(out.framing).toBe('ndjson')
    expect(out.frames).toEqual(['{"a":1}', '{"b":2}'])
    expect(out.bufferRest).toBe('')
  })

  test('buffers partial trailing frame', () => {
    const out = readFrames('{"a":1}\n{"b":', 'unknown')
    expect(out.frames).toEqual(['{"a":1}'])
    expect(out.bufferRest).toBe('{"b":')
  })

  test('skips blank lines', () => {
    const out = readFrames('\n{"a":1}\n\n', 'ndjson')
    expect(out.frames).toEqual(['{"a":1}'])
  })
})

describe('readFrames (LSP framing)', () => {
  test('auto-detects Content-Length header on first byte', () => {
    const body = '{"a":1}'
    const buf = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
    const out = readFrames(buf, 'unknown')
    expect(out.framing).toBe('lsp')
    expect(out.frames).toEqual([body])
    expect(out.bufferRest).toBe('')
  })

  test('buffers incomplete LSP body', () => {
    const body = '{"a":1}'
    const buf = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n{"a":`
    const out = readFrames(buf, 'lsp')
    expect(out.frames).toEqual([])
    // bufferRest preserves the entire header + partial body for next chunk
    expect(out.bufferRest.length).toBeGreaterThan(0)
  })

  test('parses multiple LSP frames in one buffer', () => {
    const b1 = '{"a":1}'
    const b2 = '{"b":2}'
    const buf =
      `Content-Length: ${b1.length}\r\n\r\n${b1}` +
      `Content-Length: ${b2.length}\r\n\r\n${b2}`
    const out = readFrames(buf, 'lsp')
    expect(out.frames).toEqual([b1, b2])
  })
})

describe('readFrames (whitespace)', () => {
  test('returns unknown framing when only whitespace seen', () => {
    const out = readFrames('   \n   ', 'unknown')
    expect(out.framing).toBe('unknown')
    expect(out.frames).toEqual([])
  })
})
