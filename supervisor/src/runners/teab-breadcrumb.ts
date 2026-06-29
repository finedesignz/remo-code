import { homedir, hostname, platform } from 'os'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Fail-open TEAB run breadcrumb (milestone TEAB, 2026-06-28).
 *
 * Mirrors `session-breadcrumb.ts`: the supervisor owns the local FS and is the
 * only component that can leave a factual trace without driving the human-only
 * PTY. A TEAB run is a long-lived DETACHED child (`teab run --repo <repo>`) that
 * survives supervisor restarts, so the in-memory `RUNS` registry alone cannot be
 * trusted across a restart. Each run START and STOP drops a breadcrumb under a
 * supervisor-owned dir so an operator can reconstruct what TEAB did even after a
 * restart wiped the registry.
 *
 * Best-effort + fail-open — a breadcrumb write must NEVER throw into the spawn
 * path or block a run. Every writer swallows FS errors and returns null.
 */

export interface TeabRunBreadcrumb {
  run_id: string
  /** 'start' | 'stop'. */
  event: string
  repo_path?: string
  pid?: number
  exit_code?: number | null
  hostname: string
  /** ISO-8601 UTC. */
  at: string
}

/** `%LOCALAPPDATA%\remo-code-supervisor\teab-run-breadcrumbs` (win32) or the
 *  XDG state equivalent. Mirrors `breadcrumbDir` in session-breadcrumb.ts. */
export function teabBreadcrumbDir(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'remo-code-supervisor', 'teab-run-breadcrumbs')
  }
  return join(homedir(), '.local', 'share', 'remo-code-supervisor', 'teab-run-breadcrumbs')
}

function safeName(runId: string, now: Date): string {
  return (runId || `unknown-${now.getTime()}`)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_') // collapse any `..` run so the name can't read as traversal
}

/**
 * Write (or overwrite) the breadcrumb for a run id. The file is keyed by run id
 * and updated in place: START writes it, STOP overwrites it with the terminal
 * fields. Returns the path written, or null on any failure (fail-open). `now` is
 * injectable for tests.
 */
function writeTeabBreadcrumb(crumb: TeabRunBreadcrumb, now: Date): string | null {
  try {
    const dir = teabBreadcrumbDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${safeName(crumb.run_id, now)}.json`)
    writeFileSync(path, JSON.stringify(crumb, null, 2) + '\n')
    return path
  } catch {
    return null
  }
}

/** Record a TEAB run START. Fail-open. */
export function writeTeabRunStart(
  input: { runId: string; repoPath: string; pid?: number },
  now: Date = new Date(),
): string | null {
  return writeTeabBreadcrumb(
    {
      run_id: input.runId,
      event: 'start',
      repo_path: input.repoPath,
      pid: input.pid,
      hostname: hostname(),
      at: now.toISOString(),
    },
    now,
  )
}

/** Record a TEAB run STOP. Fail-open. */
export function writeTeabRunStop(
  input: { runId: string; exitCode: number | null },
  now: Date = new Date(),
): string | null {
  return writeTeabBreadcrumb(
    {
      run_id: input.runId,
      event: 'stop',
      exit_code: input.exitCode,
      hostname: hostname(),
      at: now.toISOString(),
    },
    now,
  )
}
