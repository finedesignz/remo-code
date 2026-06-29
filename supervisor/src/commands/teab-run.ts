/**
 * teab_run / teab_status — supervisor-native commands that run Titanium Edge
 * AutoBuilder (TEAB) as a backgrounded process on the supervisor host.
 *
 * TEAB is a standalone Node CLI (`teab run --repo <project>`) that itself spawns
 * headless `claude` subagents to drive a repo's `.planning/` roadmap to
 * completion. It runs for a long time (hours), so `teab_run` background-spawns it
 * DETACHED and returns a started ack immediately; `teab_status` polls a run id.
 *
 * HARD INVARIANT (mirrors the PTY path): the supervisor launches ONLY the `teab`
 * binary with an `['run','--repo',<repo>]` argv. It NEVER passes a programmatic
 * flag (`-p`/`--print`/`--input-format`/`--output-format`/`stream-json`), an API
 * key, or `--dangerously-skip-permissions`/`bypassPermissions`. TEAB owns its own
 * `claude` spawns + permission contract (the target repo's D3
 * `irreversible-action-guard.mjs` hook). Spawn env is routed through the shared
 * `env-sanitize.ts` scrubber, so no inherited provider credential leaks through.
 *
 * RPC contract:
 *   teab_run    args: [repoPath]                → { run_id, started, pid }
 *   teab_status args: [runId]                   → { state, exit_code, events_tail }
 *
 * Preflight fails CLOSED with a specific error before spawning:
 *   teab_not_found | claude_not_found | repo_not_found | missing_planning | missing_guard_hook
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, isAbsolute, delimiter } from 'path'
import { randomUUID } from 'crypto'
import { sanitizeSpawnEnv } from '../runners/env-sanitize'
import type { CommandResult } from './index'

/** Ring-buffer cap for captured stdout/stderr lines per run. */
const EVENTS_TAIL_CAP = 200
/** How many tail lines teab_status returns. */
const STATUS_TAIL_LINES = 50

export interface TeabRunRecord {
  runId: string
  pid?: number
  child?: ChildProcess
  eventsTail: string[]
  state: 'running' | 'exited'
  exitCode?: number
  startedAt: number
}

/** Module-level in-memory run registry (keyed by run id). */
const RUNS = new Map<string, TeabRunRecord>()

/** Test/inspection helpers. */
export function getRun(runId: string): TeabRunRecord | undefined {
  return RUNS.get(runId)
}
export function listRuns(): TeabRunRecord[] {
  return [...RUNS.values()]
}
export function _resetRuns(): void {
  RUNS.clear()
}

function pushTail(rec: TeabRunRecord, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length === 0) continue
    rec.eventsTail.push(line)
  }
  if (rec.eventsTail.length > EVENTS_TAIL_CAP) {
    rec.eventsTail.splice(0, rec.eventsTail.length - EVENTS_TAIL_CAP)
  }
}

/** Resolve a bare binary name against PATH (Windows PATHEXT-aware). */
function whichSync(bin: string): string | null {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null
  const pathEnv = process.env.PATH || process.env.Path || ''
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
      : ['']
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const ext of ['', ...exts]) {
      const full = join(dir, bin + ext)
      try {
        if (existsSync(full) && statSync(full).isFile()) return full
      } catch {
        /* keep scanning */
      }
    }
  }
  return null
}

/** Binary name the supervisor invokes for TEAB (override via TEAB_BIN). */
export function resolveTeabBinName(): string {
  const override = process.env.TEAB_BIN
  return override && override.trim() ? override.trim() : 'teab'
}

/**
 * Build the EXACT spawn argv. Allowlist-of-shape: `teab run --repo <repo>` and
 * nothing else. This is a pure unit so the forbidden-token canary can assert on
 * it without spawning anything.
 */
export function buildTeabSpawnArgs(repoPath: string): { bin: string; args: string[] } {
  return { bin: resolveTeabBinName(), args: ['run', '--repo', repoPath] }
}

export interface TeabPreflightDeps {
  /** Resolve the teab binary; null ⇒ not found. */
  resolveTeabBin?: () => string | null
  /** Resolve the claude binary; null ⇒ not found. */
  resolveClaudeBin?: () => string | null
  /** Existence check for a filesystem path (mockable in tests). */
  pathExists?: (p: string) => boolean
}

function defaultResolveTeabBin(): string | null {
  return whichSync(resolveTeabBinName())
}
function defaultResolveClaudeBin(): string | null {
  // TEAB_CLAUDE_BIN overrides the claude binary location for TEAB.
  const override = process.env.TEAB_CLAUDE_BIN
  if (override && override.trim()) return whichSync(override.trim())
  return whichSync('claude')
}

/**
 * Fail-closed preflight. Returns the FIRST specific failure reason, or ok.
 * All filesystem access goes through `pathExists` so tests can fully mock it.
 */
export function preflightTeab(
  repoPath: string | undefined,
  deps: TeabPreflightDeps = {},
): { ok: boolean; error?: string } {
  const resolveTeab = deps.resolveTeabBin ?? defaultResolveTeabBin
  const resolveClaude = deps.resolveClaudeBin ?? defaultResolveClaudeBin
  const pathExists = deps.pathExists ?? ((p: string) => existsSync(p))

  if (!repoPath || !isAbsolute(repoPath)) return { ok: false, error: 'repo_not_found' }
  if (!resolveTeab()) return { ok: false, error: 'teab_not_found' }
  if (!resolveClaude()) return { ok: false, error: 'claude_not_found' }
  if (!pathExists(repoPath)) return { ok: false, error: 'repo_not_found' }
  if (!pathExists(join(repoPath, '.planning'))) return { ok: false, error: 'missing_planning' }
  if (!pathExists(join(repoPath, '.claude', 'hooks', 'irreversible-action-guard.mjs'))) {
    return { ok: false, error: 'missing_guard_hook' }
  }
  return { ok: true }
}

export interface TeabRunDeps extends TeabPreflightDeps {
  /** Spawn implementation (defaults to child_process.spawn). */
  spawnFn?: typeof spawn
  /** Run-id generator (defaults to a uuid). */
  genRunId?: () => string
  /** Spawn-env producer (defaults to sanitized process.env). */
  sanitizeEnv?: () => NodeJS.ProcessEnv
}

function defaultGenRunId(): string {
  return `teab_${randomUUID()}`
}

/**
 * Background-spawn `teab run --repo <repo>` DETACHED and return a started ack
 * immediately. Does NOT await child completion.
 */
export async function runTeabRun(args: string[], deps: TeabRunDeps = {}): Promise<CommandResult> {
  const repoPath = args?.[0]
  const pf = preflightTeab(repoPath, deps)
  if (!pf.ok) return { exit_code: 1, error: pf.error }

  const runId = (deps.genRunId ?? defaultGenRunId)()
  const { bin, args: spawnArgs } = buildTeabSpawnArgs(repoPath as string)
  const env = (deps.sanitizeEnv ?? (() => sanitizeSpawnEnv({ ...process.env })))()
  const spawnImpl = deps.spawnFn ?? spawn

  const rec: TeabRunRecord = {
    runId,
    eventsTail: [],
    state: 'running',
    startedAt: Date.now(),
  }
  RUNS.set(runId, rec)

  let child: ChildProcess
  try {
    child = spawnImpl(bin, spawnArgs, {
      cwd: repoPath,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err: any) {
    rec.state = 'exited'
    rec.exitCode = -1
    pushTail(rec, `spawn failed: ${err?.message ?? String(err)}`)
    return { exit_code: 1, error: 'spawn_failed' }
  }

  rec.child = child
  rec.pid = child.pid
  child.stdout?.on('data', (d: Buffer | string) => pushTail(rec, d.toString()))
  child.stderr?.on('data', (d: Buffer | string) => pushTail(rec, d.toString()))
  child.on('exit', (code: number | null) => {
    rec.state = 'exited'
    rec.exitCode = code ?? -1
  })
  child.on('error', (e: Error) => {
    pushTail(rec, `spawn error: ${e.message}`)
    rec.state = 'exited'
    if (rec.exitCode == null) rec.exitCode = -1
  })
  // Detach so a supervisor restart doesn't reap the long-running TEAB process.
  child.unref?.()

  return { exit_code: 0, snippet: JSON.stringify({ run_id: runId, started: true, pid: child.pid }) }
}

/** Report the state + recent events tail for a run id. */
export async function runTeabStatus(args: string[]): Promise<CommandResult> {
  const runId = args?.[0]
  const rec = runId ? RUNS.get(runId) : undefined
  if (!rec) return { exit_code: 1, error: 'unknown_run' }
  return {
    exit_code: 0,
    snippet: JSON.stringify({
      state: rec.state,
      exit_code: rec.exitCode ?? null,
      events_tail: rec.eventsTail.slice(-STATUS_TAIL_LINES),
    }),
  }
}
