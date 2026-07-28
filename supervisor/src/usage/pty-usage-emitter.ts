/**
 * pty-usage-emitter.ts — PTYCAP Phase 1 (SC-1 / SC-2 / SC-3).
 *
 * Owns the per-session lifecycle of tailing an interactive PTY session's
 * on-disk Claude transcript JSONL and emitting `usage_event` frames tagged
 * `runner_type: 'pty-interactive'` as each assistant record lands — so the
 * hub's usage ledger sees PTY spend WHILE it happens, not only after the
 * session ends (today it never sees PTY spend at all).
 *
 * RECORD/OBSERVE ONLY. This module never blocks, gates, delays, or writes to
 * the PTY. All filesystem access stays supervisor-side — the hub never reads a
 * homedir-derived transcript path (Pitfall 1); the tag crosses the host
 * boundary only via the existing `/ws/agent` `usage_event` frame.
 *
 * Phase 1 is scoped to `cliKind: 'claude'` only (P1-D-E) — a codex-backed PTY
 * session starts no timer, no watcher, and emits nothing (a true no-op; Codex
 * rollout-JSONL usage parity is an unverified fast-follow, see docs/usage-cost.md).
 */
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tailJsonl, type JsonlTail } from './pty-transcript-tail'
import { resolveSessionDir, realPathContained, claudeProjectsBase } from '../commands/session-read'

/** Locate-poll cadence while waiting for the freshly-spawned CLI's JSONL to appear. */
const LOCATE_POLL_MS = 1000
/** Give up locating the transcript file after this long since spawn — no fallback
 *  to an arbitrary older file; a wrong attribution is worse than a missing one. */
const LOCATE_TIMEOUT_MS = 60_000
/** A candidate file must have mtimeMs >= spawnedAt - this slack to qualify as
 *  "the file this session's CLI just touched" (P1-D-B capture-once locator). */
const LOCATE_MTIME_SLACK_MS = 2000
/** Bound the uuid dedupe set so a very long-running session can't leak memory. */
const SEEN_UUID_CAP = 5000

export interface TranscriptUsageRecord {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  model: string | null
}

/**
 * Extract the four token buckets from a Claude transcript JSONL record.
 * Returns null unless `record` is an object with `type === 'assistant'` and an
 * object at `message.usage` — every other shape (tool/user records, malformed
 * lines already caught by the tailer's own parse guard) yields null, never a
 * thrown error (ASVS V5 — a malformed/adversarial record must never crash the
 * tailer or the emitter).
 */
export function extractUsage(record: unknown): TranscriptUsageRecord | null {
  if (!record || typeof record !== 'object') return null
  const r = record as any
  if (r.type !== 'assistant') return null
  const usage = r.message?.usage
  if (!usage || typeof usage !== 'object') return null
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    model: typeof r.message?.model === 'string' ? r.message.model : null,
  }
}

/**
 * Capture-once locator (P1-D-B): find the `.jsonl` in `dir` that THIS session's
 * freshly-spawned CLI touched — the entry with the LOWEST mtimeMs that still
 * qualifies as new (`mtimeMs >= sinceMs - LOCATE_MTIME_SLACK_MS`). Picking the
 * lowest qualifying mtime (not the newest) means the emitter, called once and
 * never re-resolved, cannot later have its attribution stolen by some other
 * concurrently-active session's own JSONL landing in the same project dir with
 * a fresher mtime. Returns null when no entry qualifies. Unreadable entries —
 * including the directory itself not existing yet — are skipped, never thrown.
 */
export function resolveTranscriptPath(dir: string, sinceMs: number): string | null {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return null
  }
  const threshold = sinceMs - LOCATE_MTIME_SLACK_MS
  let best: { path: string; mtime: number } | null = null
  for (const n of names) {
    const full = join(dir, n)
    let mtime: number
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      mtime = st.mtimeMs
    } catch {
      continue
    }
    if (mtime < threshold) continue
    if (!best || mtime < best.mtime) best = { path: full, mtime }
  }
  return best?.path ?? null
}

export interface PtyUsageEventFrame {
  type: 'usage_event'
  session_id: string
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
  cost_source: 'estimated'
  ts: string
  runner_type: 'pty-interactive'
}

export interface PtyUsageEmitterOpts {
  sessionId: string
  projectDir: string
  cliKind: 'claude' | 'codex'
  emit: (frame: PtyUsageEventFrame) => void
  onLog?: (level: 'info' | 'warn', msg: string) => void
  /** Test seam — defaults to Date.now. */
  now?: () => number
  /** Test seam — defaults to claudeProjectsBase. */
  projectsBase?: () => string
}

/**
 * Per-PTY-session lifecycle owner. Constructed and torn down alongside the
 * interactive PTY runner in `session-bridge.ts` `ensurePtyRunner()` (P1-D-A —
 * NOT `claude-pty-bridge.ts`, which is a pure raw-byte relay with no hub socket
 * and no RunnerEvent/agent-protocol imports).
 */
export class PtyUsageEmitter {
  private locateTimer: ReturnType<typeof setInterval> | null = null
  private tail: JsonlTail | null = null
  private stopped = false
  private seen = new Set<string>()
  private seenOrder: string[] = []
  private skippedLines = 0

  start(opts: PtyUsageEmitterOpts): void {
    if (opts.cliKind !== 'claude') {
      opts.onLog?.('info', `pty-usage: accounting is claude-only for this phase — no-op for cliKind=${opts.cliKind}`)
      return
    }
    const dirResult = resolveSessionDir(opts.projectDir)
    if (!dirResult.ok) {
      opts.onLog?.('warn', `pty-usage: cannot resolve session dir (${dirResult.error})`)
      return
    }
    const dir = dirResult.dir
    const now = opts.now ?? Date.now
    const projectsBase = opts.projectsBase ?? claudeProjectsBase
    const spawnedAt = now()
    const deadline = spawnedAt + LOCATE_TIMEOUT_MS

    const tryLocate = () => {
      if (this.stopped) return
      const found = resolveTranscriptPath(dir, spawnedAt)
      if (found) {
        if (this.locateTimer) {
          clearInterval(this.locateTimer)
          this.locateTimer = null
        }
        this.pinAndTail(found, opts, projectsBase)
        return
      }
      if (now() >= deadline) {
        if (this.locateTimer) {
          clearInterval(this.locateTimer)
          this.locateTimer = null
        }
        opts.onLog?.('warn', `pty-usage: gave up locating transcript file after ${LOCATE_TIMEOUT_MS}ms`)
      }
    }

    this.locateTimer = setInterval(tryLocate, LOCATE_POLL_MS)
    tryLocate() // don't make the common case wait a full poll interval
  }

  /** PINS `pinnedPath` for the life of the emitter — never re-resolved (P1-D-B). */
  private pinAndTail(pinnedPath: string, opts: PtyUsageEmitterOpts, projectsBase: () => string): void {
    if (this.stopped) return
    if (!realPathContained(pinnedPath, projectsBase())) {
      opts.onLog?.('warn', 'pty-usage: path_escape — pinned transcript path escapes projects base')
      return
    }

    const onRecord = (record: unknown) => {
      try {
        const usage = extractUsage(record)
        if (!usage) return
        if (
          usage.inputTokens === 0 &&
          usage.outputTokens === 0 &&
          usage.cacheCreationInputTokens === 0 &&
          usage.cacheReadInputTokens === 0
        ) {
          return // no noise rows
        }
        const uuid = typeof (record as any)?.uuid === 'string' ? ((record as any).uuid as string) : null
        if (uuid) {
          if (this.seen.has(uuid)) return
          this.seen.add(uuid)
          this.seenOrder.push(uuid)
          if (this.seenOrder.length > SEEN_UUID_CAP) {
            const oldest = this.seenOrder.shift()
            if (oldest !== undefined) this.seen.delete(oldest)
          }
        }
        opts.emit({
          type: 'usage_event',
          session_id: opts.sessionId,
          model: usage.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
          cost_usd: 0,
          cost_source: 'estimated',
          ts: new Date().toISOString(),
          runner_type: 'pty-interactive',
        })
      } catch {
        // A malformed/adversarial record must never crash the tailer (ASVS V5) —
        // spend visibility staying dark is worse than skipping one bad record.
      }
    }

    this.tail = tailJsonl(pinnedPath, onRecord, {
      fromStart: false, // never replay historical records on a supervisor restart/reattach
      onParseError: () => {
        this.skippedLines++
      },
    })
  }

  /** Idempotent; safe to call any number of times, including before `start()`. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.locateTimer) {
      clearInterval(this.locateTimer)
      this.locateTimer = null
    }
    if (this.tail) {
      try {
        this.tail.close()
      } catch {
        /* ignore */
      }
      this.tail = null
    }
  }
}
