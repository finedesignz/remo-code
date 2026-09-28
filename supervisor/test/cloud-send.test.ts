/**
 * Cloud sessions — `claude -p --cloud <id>` relay (quick 20260927-cloud-sessions).
 * Pins: argv shape, content on STDIN (never argv), id validation, CLI result parsing,
 * scrubbed env, timeout.
 */
import { describe, test, expect } from 'bun:test'
import { runCloudSend, cloudSendArgv, parseCloudSendOutput, type CloudSendDeps } from '../src/commands/cloud-send'

function stream(s: string) {
  return new Response(s).body as ReadableStream<Uint8Array>
}

function fakeDeps(opts: { stdout?: string; stderr?: string; code?: number; hang?: boolean } = {}) {
  const cap: { cmd?: string[]; stdin: string; env?: Record<string, string | undefined>; killed: boolean } = { stdin: '', killed: false }
  let resolveExit: (n: number) => void = () => {}
  const deps: CloudSendDeps = {
    timeoutMs: opts.hang ? 20 : 5_000,
    env: () => ({ PATH: '/bin' }),
    spawn: (o) => {
      cap.cmd = o.cmd
      cap.env = o.env
      const exited = opts.hang ? new Promise<number>((r) => { resolveExit = r }) : Promise.resolve(opts.code ?? 0)
      return {
        stdin: { write: (s: string) => { cap.stdin += s }, end: () => {} },
        stdout: stream(opts.hang ? '' : (opts.stdout ?? '')),
        stderr: stream(opts.stderr ?? ''),
        exited,
        kill: () => { cap.killed = true; resolveExit(143) },
      }
    },
  }
  return { deps, cap }
}

describe('cloud-send argv', () => {
  test('exact argv; content is NOT in argv', async () => {
    const { deps, cap } = fakeDeps({ stdout: '{"ok":true,"session_id":"cse_1","url":"u"}' })
    const r = await runCloudSend('cse_01ABC', '--dangerously-skip-permissions hi', deps)
    expect(r).toEqual({ ok: true })
    expect(cap.cmd).toEqual(['claude', '-p', '--cloud', 'cse_01ABC', '--output-format', 'json'])
    expect(cap.cmd).toEqual(cloudSendArgv('cse_01ABC'))
    expect(cap.stdin).toBe('--dangerously-skip-permissions hi')
  })
  test('never asks for stream-json (rejected by the CLI for --cloud <id>)', () => {
    expect(cloudSendArgv('cse_1').join(' ')).not.toContain('stream-json')
  })
})

describe('cloud-send validation', () => {
  for (const bad of ['', 'cse_', 'cse_a b', '--help', 'cse_1;rm', 'sess_1']) {
    test(`rejects id ${JSON.stringify(bad)} without spawning`, async () => {
      const { deps, cap } = fakeDeps()
      const r = await runCloudSend(bad, 'hi', deps)
      expect(r.ok).toBe(false)
      expect(cap.cmd).toBeUndefined()
    })
  }
  test('rejects empty message', async () => {
    const { deps } = fakeDeps()
    expect((await runCloudSend('cse_1', '', deps)).ok).toBe(false)
  })
})

describe('cloud-send result', () => {
  test('CLI ok:false surfaces its error', async () => {
    const { deps } = fakeDeps({ stdout: '{"ok":false,"session_id":"cse_1","error":"cloud session cse_1 is archived and cannot accept new messages"}', code: 1 })
    expect(await runCloudSend('cse_1', 'hi', deps)).toEqual({ ok: false, error: 'cloud session cse_1 is archived and cannot accept new messages' })
  })
  test('stderr-only config error surfaces without the Error: prefix', async () => {
    const { deps } = fakeDeps({ stderr: 'Error: Cloud sessions are disabled by your organization\'s policy.\n', code: 1 })
    const r = await runCloudSend('cse_1', 'hi', deps)
    expect(r).toEqual({ ok: false, error: 'Cloud sessions are disabled by your organization\'s policy.' })
  })
  test('timeout kills the process', async () => {
    const { deps, cap } = fakeDeps({ hang: true })
    expect(await runCloudSend('cse_1', 'hi', deps)).toEqual({ ok: false, error: 'cloud_send_timeout' })
    expect(cap.killed).toBe(true)
  })
  test('parseCloudSendOutput tolerates noise lines', () => {
    expect(parseCloudSendOutput('warning: x\n{"ok":true}\n')).toEqual({ ok: true, error: undefined })
    expect(parseCloudSendOutput('garbage')).toBeNull()
  })
})
