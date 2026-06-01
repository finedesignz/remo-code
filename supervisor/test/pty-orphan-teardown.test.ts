/**
 * Phase 15 — orphaned-PTY teardown (R-PTY-27 / H7).
 *
 * Two guarantees, both exercised against the REAL pty-host.mjs running under
 * Node (the working runtime; see 15-SPIKE-FINDINGS.md why the host is Node):
 *   1. kill() reaps the PTY child + host (explicit teardown / WS-disconnect /
 *      session-close path).
 *   2. Dead-man's-switch — if the parent dies (stdin closes), the host self-
 *      terminates so no orphan claude/ConPTY host survives a crashed supervisor.
 *
 * FORWARD NOTE (Phase 16 detach-vs-kill policy): in Phase 16, CLIENT-disconnect
 * DETACHES (supervisor-owned tmux persistence) while session-close / idle-reap /
 * supervisor-exit KILLS. The spike's connection-scoped kill here is the
 * pre-persistence baseline.
 */
import { describe, test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runners', 'pty-host.mjs')

function frame(obj: unknown): Buffer {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  return Buffer.concat([len, buf])
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitGone(pid: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isAlive(pid)
}

/** Spawn the host, ask it to host a harmless long-lived PTY command, resolve
 *  with the host pid + the inner PTY child pid the host reports. */
function startHost(cmd: string, args: string[]): Promise<{ host: ReturnType<typeof spawn>; hostPid: number; childPid: number }> {
  return new Promise((resolve, reject) => {
    const host = spawn('node', [HOST], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    let acc = Buffer.alloc(0)
    const to = setTimeout(() => reject(new Error('host did not report spawned pid')), 5000)
    host.stdout!.on('data', (chunk: Buffer) => {
      acc = Buffer.concat([acc, chunk])
      while (acc.length >= 4) {
        const len = acc.readUInt32BE(0)
        if (acc.length < 4 + len) break
        let f: any
        try { f = JSON.parse(acc.subarray(4, 4 + len).toString('utf8')) } catch { f = null }
        acc = acc.subarray(4 + len)
        if (f && f.t === 'spawned') {
          clearTimeout(to)
          resolve({ host, hostPid: host.pid!, childPid: f.pid })
        }
      }
    })
    host.stdin!.write(frame({ t: 'spawn', file: cmd, args, cwd: process.cwd(), cols: 80, rows: 24 }))
  })
}

const longCmd = process.platform === 'win32'
  ? { cmd: 'cmd.exe', args: ['/c', 'pause'] }
  : { cmd: 'sleep', args: ['30'] }

describe('Phase 15 — orphaned-PTY teardown (H7 / R-PTY-27)', () => {
  test('kill frame reaps the PTY child and the host', async () => {
    const { host, hostPid, childPid } = await startHost(longCmd.cmd, longCmd.args)
    expect(isAlive(hostPid)).toBe(true)
    host.stdin!.write(frame({ t: 'kill' }))
    setTimeout(() => { try { host.kill() } catch {} }, 200)
    expect(await waitGone(hostPid)).toBe(true)
    expect(await waitGone(childPid)).toBe(true)
  })

  test('dead-man\'s-switch: when the parent process dies, the host self-terminates (parent-PID poll)', async () => {
    // Spawn an intermediate Node "launcher" that itself spawns the pty-host and
    // prints the host PID. Kill the launcher → the host's ppid is gone → the
    // host's parent-PID poll must reap it. This is the real crashed-supervisor
    // scenario (the stdin-end path is the graceful-exit complement).
    const launcherSrc = `
      const { spawn } = require('child_process');
      const h = spawn('node', [${JSON.stringify(HOST)}], { stdio: ['pipe','pipe','ignore'] });
      let acc = Buffer.alloc(0);
      h.stdout.on('data', c => { acc = Buffer.concat([acc,c]);
        while (acc.length>=4){ const l=acc.readUInt32BE(0); if(acc.length<4+l)break;
          const f=JSON.parse(acc.subarray(4,4+l)); acc=acc.subarray(4+l);
          if(f.t==='spawned') process.stdout.write('HOSTPID='+h.pid+'\\n'); } });
      function fr(o){const b=Buffer.from(JSON.stringify(o));const l=Buffer.alloc(4);l.writeUInt32BE(b.length,0);h.stdin.write(Buffer.concat([l,b]));}
      fr({t:'spawn',file:${JSON.stringify(longCmd.cmd)},args:${JSON.stringify(longCmd.args)},cwd:process.cwd(),cols:80,rows:24});
      setInterval(()=>{},1000);
    `
    const launcher = spawn('node', ['-e', launcherSrc], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
    const hostPid: number = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('launcher did not report host pid')), 6000)
      launcher.stdout!.on('data', (c: Buffer) => {
        const m = /HOSTPID=(\d+)/.exec(c.toString())
        if (m) { clearTimeout(to); resolve(Number(m[1])) }
      })
    })
    expect(isAlive(hostPid)).toBe(true)
    try { launcher.kill() } catch {}
    // The host's 1s parent-PID poll should reap it within a couple seconds.
    expect(await waitGone(hostPid, 6000)).toBe(true)
  })
})
