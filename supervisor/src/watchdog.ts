#!/usr/bin/env bun
// Watchdog: standalone entry point that wraps the supervisor.
// Task Scheduler should invoke this file directly instead of `index.ts run`.
//
// Manual swap (one-time):
//   schtasks /Change /TN '\RemoCodeSupervisor' /TR 'C:\Users\artic\scoop\shims\bun.exe "C:\Users\artic\GitHub\remo-code\supervisor\src\watchdog.ts"'
//
// (Requires admin in some configurations; if /Change is rejected,
// delete-and-recreate the task with the updated /TR.)
//
// Flow:
//   1. Spawn `index.ts run` as a subprocess (Bun.spawn, argv array, no shell).
//   2. Clean exit (code 0) -> done.
//   3. Healthy >=60s then crash -> treat as transient, exit with child's code so
//      Task Scheduler can retry.
//   4. Crash within first 60s -> read supervisor.log tail, spawn Claude headless
//      with full tool access to investigate + patch source. After Claude exits,
//      retry the child once. If still crashing -> notify user.
//
// Only ONE self-heal attempt per watchdog invocation.

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'

const VERSION = '0.1.0'
const SUPERVISOR_ENTRY = join(import.meta.dir, 'index.ts')
const REPO_ROOT = join(import.meta.dir, '..', '..')
const MIN_HEALTHY_RUNTIME_MS = 60_000

function logDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, 'remo-code-supervisor')
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'remo-code-supervisor')
}

const LOG_DIR = logDir()
const SUP_LOG = join(LOG_DIR, 'supervisor.log')
const WATCHDOG_LOG = join(LOG_DIR, 'watchdog.log')
const INCIDENTS_DIR = join(LOG_DIR, 'incidents')

function ensureDirs() {
  for (const d of [LOG_DIR, INCIDENTS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

function wlog(msg: string) {
  ensureDirs()
  const line = `${new Date().toISOString()} ${msg}\n`
  try { appendFileSync(WATCHDOG_LOG, line) } catch {}
  process.stdout.write(line)
}

async function runChild(cmd: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<{ exitCode: number; runtimeMs: number; stdout: string; stderr: string }> {
  const started = Date.now()
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd || REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
  })
  if (opts.stdin !== undefined && proc.stdin) {
    try {
      const writer = proc.stdin as unknown as { write: (s: string) => void; end: () => void }
      writer.write(opts.stdin)
      writer.end()
    } catch {}
  }
  let stdoutBuf = ''
  let stderrBuf = ''
  const drain = async (stream: ReadableStream<Uint8Array>, into: (s: string) => void, sink: (s: string) => void) => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const s = dec.decode(value)
      into(s); sink(s)
    }
  }
  const sd = drain(proc.stdout, (s) => { stdoutBuf += s }, (s) => process.stdout.write(s))
  const se = drain(proc.stderr, (s) => { stderrBuf += s }, (s) => process.stderr.write(s))
  const exitCode = await proc.exited
  await sd; await se
  return { exitCode: exitCode ?? 0, runtimeMs: Date.now() - started, stdout: stdoutBuf, stderr: stderrBuf }
}

function findClaudeBinary(): string {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude.exe'),
    join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    join(process.env.APPDATA || '', 'npm', 'claude'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'claude'
}

async function runSelfHeal(logTail: string): Promise<{ healed: boolean; reason: string; output: string }> {
  const claude = findClaudeBinary()
  wlog(`[heal] invoking ${claude} for self-heal in ${REPO_ROOT}`)

  const prompt = [
    'The remo-code supervisor process on this machine just crashed.',
    '',
    'Your job: investigate root cause, apply the smallest fix in source, and confirm it will start cleanly.',
    'Do NOT start the supervisor yourself — the watchdog retries it after you exit.',
    '',
    `Repo root: ${REPO_ROOT}`,
    'Supervisor entry: supervisor/src/index.ts (cmd=run runs the actual supervisor)',
    'Watchdog: supervisor/src/watchdog.ts',
    `Supervisor log: ${SUP_LOG}`,
    '',
    'Recent supervisor log tail (last ~200 lines):',
    '--- LOG START ---',
    logTail,
    '--- LOG END ---',
    '',
    'Required final line of your output (used by the watchdog to decide whether to retry):',
    '  "HEALED: <one-line summary>"   if you fixed it,',
    '  "CANNOT_HEAL: <reason>"        if you could not.',
  ].join('\n')

  // Pass the prompt via stdin (argv passing fails on long prompts / shell quoting on Windows).
  const res = await runChild([
    claude,
    '--print',
    '--dangerously-skip-permissions',
    '--add-dir', REPO_ROOT,
  ], { cwd: REPO_ROOT, stdin: prompt })

  const combined = res.stdout + (res.stderr ? `\n[stderr]\n${res.stderr}` : '')
  const cannot = /CANNOT_HEAL:\s*(.+)/.exec(combined)
  const healed = /HEALED:\s*(.+)/.exec(combined)
  wlog(`[heal] claude exited code=${res.exitCode}`)
  if (cannot) return { healed: false, reason: cannot[1].trim(), output: combined }
  if (healed) return { healed: true, reason: healed[1].trim(), output: combined }
  return { healed: false, reason: 'Claude exited without HEALED/CANNOT_HEAL marker', output: combined }
}

async function notifyUser(reason: string, claudeOutput: string, logTail: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const incidentPath = join(INCIDENTS_DIR, `cant-heal-${ts}.md`)
  const body = [
    `# Supervisor self-heal failed`, ``,
    `**When:** ${new Date().toISOString()}`,
    `**Host:** ${hostname()}`,
    `**Reason:** ${reason}`, ``,
    `## Supervisor log tail`, '```', logTail, '```', ``,
    `## Claude output`, '```', claudeOutput, '```',
  ].join('\n')
  try {
    writeFileSync(incidentPath, body, 'utf8')
    wlog(`[notify] wrote incident report: ${incidentPath}`)
  } catch (err: any) {
    wlog(`[notify] failed to write incident report: ${err.message}`)
  }

  const key = process.env.E4A_API_KEY
  const inbox = process.env.E4A_INBOX_ID
  const to = process.env.SUPERVISOR_NOTIFY_EMAIL
  const base = process.env.E4A_BASE_URL || 'https://api.emails4agents.com'
  if (!key || !inbox || !to) {
    wlog('[notify] email skipped (set E4A_API_KEY, E4A_INBOX_ID, SUPERVISOR_NOTIFY_EMAIL to enable)')
    return
  }
  try {
    const res = await fetch(`${base}/v1/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({
        inbox_id: inbox,
        to,
        subject: '[remo-code] supervisor self-heal failed',
        body: `Self-heal could not fix the supervisor crash on ${hostname()}.\n\nReason: ${reason}\n\nIncident report: ${incidentPath}\nSupervisor log:  ${SUP_LOG}\nWatchdog log:    ${WATCHDOG_LOG}\n`,
      }),
    })
    wlog(`[notify] email sent status=${res.status}`)
  } catch (err: any) {
    wlog(`[notify] email failed: ${err.message}`)
  }
}

export async function runWatchdog(): Promise<void> {
  ensureDirs()
  wlog(`[watchdog] v${VERSION} starting`)

  const first = await runChild([process.execPath, SUPERVISOR_ENTRY, 'run'])
  wlog(`[watchdog] supervisor exited code=${first.exitCode} runtimeMs=${first.runtimeMs}`)
  if (first.exitCode === 0) { wlog('[watchdog] clean exit'); return }
  if (first.runtimeMs >= MIN_HEALTHY_RUNTIME_MS) {
    wlog('[watchdog] supervisor was healthy >=60s before crash; treating as transient, exiting')
    process.exit(first.exitCode)
  }

  let logTail = ''
  try {
    const all = readFileSync(SUP_LOG, 'utf8').split(/\r?\n/)
    logTail = all.slice(-200).join('\n')
  } catch (err: any) {
    logTail = `(could not read supervisor.log: ${err.message})`
  }

  const heal = await runSelfHeal(logTail)
  if (!heal.healed) {
    wlog(`[watchdog] self-heal failed: ${heal.reason}`)
    await notifyUser(heal.reason, heal.output, logTail)
    process.exit(2)
  }
  wlog(`[watchdog] self-heal claims success: ${heal.reason} — retrying supervisor`)

  const retry = await runChild([process.execPath, SUPERVISOR_ENTRY, 'run'])
  wlog(`[watchdog] retry exited code=${retry.exitCode} runtimeMs=${retry.runtimeMs}`)
  if (retry.exitCode !== 0 && retry.runtimeMs < MIN_HEALTHY_RUNTIME_MS) {
    const msg = `Self-heal applied but supervisor crashed again (exitCode=${retry.exitCode}, runtimeMs=${retry.runtimeMs}).`
    wlog(`[watchdog] ${msg}`)
    await notifyUser(msg, heal.output, logTail)
    process.exit(3)
  }
  wlog('[watchdog] retry stable; incident closed')
}

// Standalone entry: when invoked directly (Task Scheduler), run the watchdog.
if (import.meta.main) {
  runWatchdog().catch((err: any) => {
    try { wlog(`[watchdog] fatal: ${err?.stack || err?.message || String(err)}`) } catch {}
    process.exit(99)
  })
}
