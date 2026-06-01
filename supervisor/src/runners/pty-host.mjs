#!/usr/bin/env node
/**
 * PTY host — the Phase-15 spike proved this MUST run under NODE, not Bun.
 *
 * WHY A SEPARATE NODE PROCESS (the Phase-15 derisk verdict):
 *   `node-pty`'s Windows I/O (both the ConPTY and winpty backends) rides
 *   `node:net` named-pipe Sockets. Bun 1.3.x on Windows cannot drive those
 *   sockets — the native addon LOADS fine under Bun (`require('node-pty')`
 *   succeeds) but the very first PTY write throws `ERR_SOCKET_CLOSED` from
 *   inside windowsTerminal.js. The identical prebuilt binary works perfectly
 *   under Node. So the Bun sidecar cannot host the PTY directly; it spawns
 *   THIS host as a Node child and speaks a length-prefixed JSON-frame protocol
 *   over stdio. (Approach (b) in 15-RESEARCH.md — helper-exe / sidecar-of-the-
 *   sidecar.) See 15-SPIKE-FINDINGS.md for the full empirical record.
 *
 * HARD CONSTRAINTS enforced here (interactive-pty-runner-SPEC.md):
 *   - Constraint 1: provider API keys are deleted from the spawned env. ALWAYS
 *     — both ANTHROPIC_API_KEY (claude) and OPENAI_API_KEY (codex), regardless
 *     of which `file` the parent asked for, so no provider key can ever leak
 *     onto either interactive client's spawn path.
 *   - Constraint 5: argv is passed through verbatim from the parent, which is
 *     contractually empty for `claude` (interactive TUI; NO -p / --print /
 *     --input-format / --output-format). The behavioral spawn-interception
 *     harness asserts this at the parent (claude-pty-runner.ts) boundary.
 *   - Constraint 2: spawns the official binary only; never reads/forwards
 *     ~/.claude/.credentials.json — auth is delegated to the official client.
 *
 * Frame protocol (4-byte big-endian length prefix + UTF-8 JSON):
 *   parent -> host: {t:'spawn',file,args,cwd,cols,rows} | {t:'input',d}
 *                   | {t:'resize',cols,rows} | {t:'kill'}
 *   host -> parent: {t:'data',d} | {t:'exit',code} | {t:'spawned',pid}
 *                   | {t:'error',message}
 *
 * Dead-man's-switch (R-PTY-27 / H7): the host self-terminates if its parent
 * (the Bun supervisor) dies, so a crashed supervisor never leaves an orphan
 * `claude` + ConPTY host holding a live OAuth session.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let pty
try {
  pty = require('node-pty')
} catch (err) {
  // Surface load failure as a frame, then exit — the parent decides fallback.
  process.stderr.write(`[pty-host] failed to load node-pty: ${err && err.message}\n`)
  process.exit(2)
}

let term = null

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  try {
    process.stdout.write(Buffer.concat([len, buf]))
  } catch {
    // Parent pipe gone — nothing we can do; the dead-man's-switch will reap us.
  }
}

let acc = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  acc = Buffer.concat([acc, chunk])
  while (acc.length >= 4) {
    const len = acc.readUInt32BE(0)
    if (acc.length < 4 + len) break
    let frame
    try {
      frame = JSON.parse(acc.subarray(4, 4 + len).toString('utf8'))
    } catch (err) {
      acc = acc.subarray(4 + len)
      send({ t: 'error', message: `bad frame: ${err && err.message}` })
      continue
    }
    acc = acc.subarray(4 + len)
    handle(frame)
  }
})

// Dead-man's-switch (R-PTY-27 / H7) — TWO independent triggers so a crashed/
// killed supervisor never leaves an orphan claude + ConPTY host:
//   1. stdin end/close (graceful parent exit closes the pipe).
//   2. parent-PID poll — if our parent process disappears (hard crash, the
//      pipe quirk on some runtimes, reparenting to init), self-terminate.
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

const PARENT_PID = process.ppid
if (PARENT_PID && PARENT_PID > 0) {
  const ppoll = setInterval(() => {
    let alive = true
    try { process.kill(PARENT_PID, 0) } catch { alive = false }
    if (!alive) { clearInterval(ppoll); shutdown() }
  }, 1000)
  // Do not let the poll keep us alive on its own.
  if (typeof ppoll.unref === 'function') ppoll.unref()
}

function shutdown() {
  try { if (term) term.kill() } catch {}
  process.exit(0)
}

function handle(f) {
  if (f.t === 'spawn') {
    // CONSTRAINT 1 — strip every provider API key no matter what the parent
    // sent or which interactive client (`claude`/`codex`) is being spawned.
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    delete env.OPENAI_API_KEY
    try {
      term = pty.spawn(f.file, Array.isArray(f.args) ? f.args : [], {
        name: 'xterm-256color',
        cols: f.cols || 80,
        rows: f.rows || 24,
        cwd: f.cwd || process.cwd(),
        env,
        // ConPTY is the modern Windows backend; node-pty auto-selects but we
        // never hard-code a single-OS path (POSIX uses forkpty).
        useConpty: process.platform === 'win32' ? true : undefined,
      })
    } catch (err) {
      send({ t: 'error', message: `spawn failed: ${err && err.message}` })
      send({ t: 'exit', code: null })
      return
    }
    send({ t: 'spawned', pid: term.pid })
    term.onData((d) => send({ t: 'data', d }))
    term.onExit(({ exitCode }) => {
      send({ t: 'exit', code: typeof exitCode === 'number' ? exitCode : null })
      term = null
    })
  } else if (f.t === 'input' && term) {
    try { term.write(f.d) } catch (err) { send({ t: 'error', message: `write failed: ${err && err.message}` }) }
  } else if (f.t === 'resize' && term) {
    try { term.resize(f.cols, f.rows) } catch {}
  } else if (f.t === 'kill') {
    try { if (term) term.kill() } catch {}
    term = null
  }
}
