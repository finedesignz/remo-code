/**
 * Phase 15 — PTY byte round-trip (R-PTY-02).
 *
 * Drives the REAL pty-host.mjs (Node + ConPTY/forkpty) with a harmless echo-
 * style command — NOT `claude` — so it needs no login in CI. Asserts that
 * input bytes written to the PTY surface back as output bytes (the byte relay
 * the whole term channel depends on). Uses the same frame protocol the
 * ClaudePtyRunner speaks, so this also exercises the host wire format.
 */
import { describe, test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runners', 'pty-host.mjs')

function encode(obj: unknown): Buffer {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0)
  return Buffer.concat([len, buf])
}

const echoCmd = process.platform === 'win32'
  ? { file: 'cmd.exe', args: [] }
  : { file: 'bash', args: [] }

describe('Phase 15 — PTY byte round-trip (R-PTY-02)', () => {
  test('bytes written to the PTY surface back as output (echo round-trip)', async () => {
    const host = spawn('node', [HOST], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    let acc = Buffer.alloc(0)
    let out = ''
    host.stdout!.on('data', (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      while (acc.length >= 4) {
        const len = acc.readUInt32BE(0)
        if (acc.length < 4 + len) break
        let f: any
        try { f = JSON.parse(acc.subarray(4, 4 + len).toString('utf8')) } catch { f = null }
        acc = acc.subarray(4 + len)
        if (f && f.t === 'data') out += f.d
      }
    })

    host.stdin!.write(encode({ t: 'spawn', file: echoCmd.file, args: echoCmd.args, cwd: process.cwd(), cols: 80, rows: 24 }))
    await new Promise((r) => setTimeout(r, 400))
    host.stdin!.write(encode({ t: 'input', d: 'echo BYTERELAY_OK_777\r\n' }))
    await new Promise((r) => setTimeout(r, 1200))

    expect(out.length).toBeGreaterThan(0)
    expect(out.includes('BYTERELAY_OK_777')).toBe(true)

    host.stdin!.write(encode({ t: 'kill' }))
    try { host.kill() } catch {}
  })
})
