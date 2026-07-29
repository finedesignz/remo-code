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
 * A pre-spawn snapshot of `.jsonl` basenames in a project's Claude session dir,
 * paired with whether the snapshot itself can be trusted.
 *
 * `reliable: true` means the directory existed and was readable at snapshot
 * time — `names` is a complete, trustworthy list of everything that pre-dated
 * this session's spawn, so anything absent from it is genuinely new.
 *
 * `reliable: false` means the directory was absent or unreadable at snapshot
 * time — `names` is (necessarily) empty, but that emptiness proves NOTHING:
 * it is indistinguishable from "nothing pre-existed" and "we simply couldn't
 * see what was there." Treating an empty-because-unreadable snapshot the same
 * as an empty-because-genuinely-fresh snapshot is exactly the bug this type
 * exists to prevent — a caller must never fall back to "accept any fresh
 * file" when `reliable` is false.
 */
export interface TranscriptSnapshot {
  reliable: boolean
  names: ReadonlySet<string>
}

/** Why `resolveTranscriptPath` declined to pin a file this call. */
export type LocateSkipReason = 'unreliable' | 'ambiguous'

/**
 * Capture-once locator (P1-D-B): find the ONE `.jsonl` in `dir` that THIS
 * session's freshly-spawned CLI touched — the entry that (a) is absent from
 * `snapshot.names` (a genuinely new file, when `snapshot` is supplied) and
 * (b) has `mtimeMs >= sinceMs - LOCATE_MTIME_SLACK_MS`. Unreadable entries —
 * including the directory itself not existing yet — are skipped, never thrown.
 *
 * Fails closed on ambiguity, not just on absence. Two failure modes are
 * both treated as "cannot safely pin," never as "pick something anyway":
 *
 * 1. **Unreliable snapshot** — `snapshot.reliable === false`. The exclusion
 *    set cannot be trusted (see `TranscriptSnapshot`), so no candidate is
 *    ever accepted, however clean the mtime match looks. Callers should
 *    normally intercept this earlier (`PtyUsageEmitter.start` short-circuits
 *    on it) — checked again here so this function alone never mis-attributes
 *    even if called directly with an unreliable snapshot.
 * 2. **Multiple viable candidates** — more than one qualifying (new-enough,
 *    unexcluded) file exists at resolve time. Previously this picked the
 *    lowest-mtime one deterministically; that is exactly the kind of guess
 *    between two candidates that causes mis-attribution when two sessions
 *    spawn into the same project dir close together. Now: refuse, pin
 *    nothing, and let the caller log it loudly. A later poll tick, once
 *    only one candidate remains new-and-unexcluded, can still resolve it.
 *
 * `snapshot` omitted preserves the old mtime-only behavior (no exclusion,
 * still ambiguity-safe) for callers/tests that don't need pre-existing-file
 * exclusion. `onSkip` is an optional side-channel so callers can log why a
 * tick found nothing to pin, without changing the `string | null` return.
 */
export function resolveTranscriptPath(
  dir: string,
  sinceMs: number,
  snapshot?: TranscriptSnapshot,
  onSkip?: (reason: LocateSkipReason, candidateCount?: number) => void,
): string | null {
  if (snapshot && !snapshot.reliable) {
    onSkip?.('unreliable')
    return null
  }
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return null
  }
  const excludeNames = snapshot?.names
  const threshold = sinceMs - LOCATE_MTIME_SLACK_MS
  const candidates: { path: string; mtime: number }[] = []
  for (const n of names) {
    if (excludeNames?.has(n)) continue // pre-existed the spawn — never a valid candidate
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
    candidates.push({ path: full, mtime })
  }
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    onSkip?.('ambiguous', candidates.length)
    return null
  }
  return candidates[0].path
}

/**
 * Snapshot the `.jsonl` basenames already present in `projectDir`'s Claude
 * session dir. The CALLER MUST invoke this BEFORE spawning the CLI process, so
 * the snapshot cannot possibly include the about-to-be-created file for THIS
 * session. Fed back in as `resolveTranscriptPath`'s `snapshot` (via
 * `PtyUsageEmitterOpts.preExistingNames`).
 *
 * Returns `reliable: false` — never a silently-empty-but-trusted set — when
 * the directory can't be proven to have been fully enumerated: an
 * unresolvable project dir, a session dir that doesn't exist yet (this
 * project's very first PTY session), or a `readdirSync` failure (e.g. a
 * permissions error, or the dir vanishing between resolve and read). All
 * three are "we don't know what was there," not "nothing was there."
 */
export function snapshotPreExistingTranscripts(projectDir: string): TranscriptSnapshot {
  const dirResult = resolveSessionDir(projectDir)
  if (!dirResult.ok) return { reliable: false, names: new Set() }
  try {
    return { reliable: true, names: new Set(readdirSync(dirResult.dir).filter((n) => n.endsWith('.jsonl'))) }
  } catch {
    return { reliable: false, names: new Set() }
  }
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
  /** Pre-spawn snapshot from `snapshotPreExistingTranscripts()` — see that
   *  function's doc. Omitted falls back to mtime-only qualification (no
   *  exclusion, but still ambiguity-safe). A snapshot with `reliable: false`
   *  makes `start()` refuse to locate anything for this session at all. */
  preExistingNames?: TranscriptSnapshot
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
    // Fail closed on an unreliable pre-spawn snapshot (round-2 QC fix): if the
    // session dir didn't exist / wasn't readable when the caller snapshotted
    // it, there is no trustworthy way to tell a genuinely-new transcript from
    // a pre-existing sibling's — so this session gets NO usage accounting
    // rather than a chance at mis-pinning someone else's spend under its
    // session_id. Checked once here, up front, rather than every poll tick —
    // the condition can't change mid-session (the snapshot was already taken).
    if (opts.preExistingNames && !opts.preExistingNames.reliable) {
      opts.onLog?.(
        'warn',
        'pty-usage: pre-spawn transcript snapshot unreliable (session dir absent/unreadable at snapshot time) — refusing to locate a transcript for this session; no usage will be emitted',
      )
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

    let loggedAmbiguous = false
    const tryLocate = () => {
      if (this.stopped) return
      const found = resolveTranscriptPath(dir, spawnedAt, opts.preExistingNames, (reason, count) => {
        if (reason === 'ambiguous' && !loggedAmbiguous) {
          loggedAmbiguous = true
          opts.onLog?.(
            'warn',
            `pty-usage: ${count} viable new transcript candidates at once — refusing to guess between them; will keep watching in case it resolves to exactly one`,
          )
        }
      })
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

  /**
   * PINS `pinnedPath` for the life of the emitter — never re-resolved (P1-D-B).
   *
   * QC INFO (judged, not fixed): `realPathContained` runs once, here, before
   * `tailJsonl` starts its own repeated `open()`s on the SAME path string. A
   * classic TOCTOU would let an attacker swap a path component for a symlink
   * between this check and a later reopen. Not re-validated on reopen because
   * the threat model doesn't support it: both this check and every later
   * `tailJsonl` read happen supervisor-side, against the LOCAL filesystem, on
   * the SAME host as the process running this code — never hub-reachable, no
   * network boundary crosses it (see the file header). An attacker able to
   * plant a symlink inside this user's own `~/.claude/projects` between poll
   * ticks already has local write access to that user's home directory, which
   * is strictly more powerful than anything this check could deny them (they
   * could read the target file directly, no symlink needed). Re-validating on
   * every reopen would buy no real containment here — only ceremony. If this
   * module is ever exposed to a less-trusted actor (e.g. a shared-account
   * host), revisit and re-check `realPathContained` on each reopen.
   */
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
