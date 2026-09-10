import { homedir, hostname, platform } from 'os'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * "Write to memory before killing" (idle-teardown, 2026-06-24).
 *
 * When the hub idle-teardown sends `{type:'shutdown', reason:'idle_no_subscribers'}`
 * the supervisor kills the live CLI process. The conversation transcript is NOT
 * lost — sessions resume by `project_dir` with full history — but the warm
 * process and any in-flight context are. Before killing, the supervisor (the
 * only component that owns the local FS and can act without driving the
 * human-only PTY) drops a factual breadcrumb recording that the kill happened.
 *
 * This is deliberately NON-INVASIVE: it writes to a supervisor-owned dir, never
 * into the operator's hand-curated `~/.claude/projects/<slug>/memory/` index.
 * Best-effort and fail-open — a breadcrumb write must NEVER block or fail a
 * shutdown.
 */

export interface SessionBreadcrumb {
  session_id: string | null
  repo_path: string
  reason: string
  /** 'pty' | 'stream-json' | 'unknown' — which runner was live at kill time. */
  backend: string
  hostname: string
  /** ISO-8601 UTC. */
  killed_at: string
}

/** `%LOCALAPPDATA%\remo-code-supervisor` (win32) or the XDG state equivalent —
 *  the shared supervisor-owned state dir. Mirrors `defaultAuditLogPath` in
 *  config.ts. Reused by force-update-marker.ts so the sidecar and the Rust
 *  tray watcher agree on one base dir without duplicating the resolution. */
export function supervisorStateDir(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'remo-code-supervisor')
  }
  return join(homedir(), '.local', 'share', 'remo-code-supervisor')
}

/** `%LOCALAPPDATA%\remo-code-supervisor\session-breadcrumbs` (win32) or the
 *  XDG state equivalent. Mirrors `defaultAuditLogPath` in config.ts. */
export function breadcrumbDir(): string {
  return join(supervisorStateDir(), 'session-breadcrumbs')
}

/**
 * Write a single breadcrumb for an idle-killed (or otherwise hub-shutdown)
 * session. Returns the path written, or null on any failure (fail-open).
 * `now` is injectable for tests.
 */
export function writeSessionBreadcrumb(
  input: { sessionId: string | null; repoPath: string; reason: string; backend: string },
  now: Date = new Date(),
): string | null {
  try {
    const dir = breadcrumbDir()
    mkdirSync(dir, { recursive: true })
    const crumb: SessionBreadcrumb = {
      session_id: input.sessionId,
      repo_path: input.repoPath,
      reason: input.reason,
      backend: input.backend,
      hostname: hostname(),
      killed_at: now.toISOString(),
    }
    // Filename keyed by session id (stable across resumes) with a kill-not-found
    // fallback so a sessionless bridge still leaves a trace.
    const name = (input.sessionId || `unknown-${now.getTime()}`)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '_') // collapse any `..` run so the name can't read as traversal
    const path = join(dir, `${name}.json`)
    writeFileSync(path, JSON.stringify(crumb, null, 2) + '\n')
    return path
  } catch {
    return null
  }
}
